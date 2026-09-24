import { decodeTreeSnapshotJSON, decodeWireDirectory, wireEntryObject, type TreeSnapshot } from "@overstory/protocol";
import { prepareSourceChange, type AcceptedBase, type AcceptedSource, type AcceptedTree, type LocalChange,
  type UpdateCoordinator } from "@overstory/working-tree";
import type { ChangeLog } from "@overstory/working-tree/node";

/**
 * An editor's working tree held in memory: the accepted state the runner
 * installs, every object reachable from it, and a view derived from the change
 * log (the newest pending change's candidate, else the accepted graph).
 */
export class MemoryWorkingTree implements AcceptedTree {
  base?: AcceptedBase;
  readonly objects = new Map<string, Uint8Array>();
  installs = 0;

  constructor(initial?: { base: AcceptedBase; snapshot: TreeSnapshot }) {
    if (initial) {
      this.base = { ...initial.base };
      for (const [hash, bytes] of initial.snapshot.objects) this.objects.set(hash, bytes);
    }
  }

  async accepted(): Promise<AcceptedBase | undefined> { return this.base && { ...this.base }; }
  async object(hash: string): Promise<Uint8Array | undefined> { return this.objects.get(hash); }
  async recordAccepted(base: AcceptedBase): Promise<void> { this.base = { ...base }; }

  async install(base: AcceptedBase, source: AcceptedSource): Promise<void> {
    const pending: Array<{ hash: string; kind: "file" | "directory" }> = [{ hash: base.root, kind: "directory" }];
    const fetched = new Map<string, Uint8Array>();
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (fetched.has(next.hash)) continue;
      const bytes = await source.object(next.hash);
      fetched.set(next.hash, bytes);
      if (next.kind !== "directory") continue;
      for (const entry of decodeWireDirectory(bytes).entries) {
        const child = wireEntryObject(entry);
        if (child) pending.push(child);
      }
    }
    for (const [hash, bytes] of fetched) this.objects.set(hash, bytes);
    this.base = { ...base };
    this.installs++;
  }

  /** The accepted graph: every object reachable from the accepted root. */
  graph(): TreeSnapshot {
    if (!this.base) throw new Error("Not placed");
    const objects = new Map<string, Uint8Array>();
    const pending: Array<{ hash: string; kind: "file" | "directory" }> = [{ hash: this.base.root, kind: "directory" }];
    for (let next = pending.pop(); next; next = pending.pop()) {
      const bytes = this.objects.get(next.hash);
      if (!bytes) throw new Error(`Missing ${next.hash}`);
      objects.set(next.hash, bytes);
      if (next.kind === "directory") for (const entry of decodeWireDirectory(bytes).entries) {
        const child = wireEntryObject(entry);
        if (child) pending.push(child);
      }
    }
    return { root: this.base.root, objects };
  }
}

/** The file at `path` in `graph`, as text. */
export function readSource(graph: TreeSnapshot, path: string): string {
  let hash = graph.root;
  const parts = path.slice(1).split("/");
  for (const [index, part] of parts.entries()) {
    const entry = decodeWireDirectory(graph.objects.get(hash)!).entries.find(entry => entry.name === part);
    if (!entry) throw new Error(`No ${path}`);
    if (index === parts.length - 1) return new TextDecoder().decode(graph.objects.get(entry.file!)!);
    hash = entry.directory!;
  }
  throw new Error(`No ${path}`);
}

/** What an editor shows: the newest pending change's candidate, else the accepted graph. */
export async function editorView(coordinator: UpdateCoordinator, working: MemoryWorkingTree):
    Promise<{ graph: TreeSnapshot; basis: LocalChange["basis"] }> {
  const latest = (await coordinator.pendingChanges()).at(-1);
  if (latest) return { graph: decodeTreeSnapshotJSON(latest.candidate), basis: { kind: "authored", change: latest.change } };
  const graph = working.graph();
  return { graph, basis: { kind: "accepted", root: working.base!.root, update: working.base!.update } };
}

/** Append one editor generation to the change log, as an editor source does, and tell the runner. */
export async function appendSource(coordinator: UpdateCoordinator, log: ChangeLog, working: MemoryWorkingTree,
    sourcePath: string, edit: (source: string) => { offset: number; length: number; replacement: string },
    from?: LocalChange): Promise<LocalChange> {
  // An editor that captured an earlier change of its own continues from it.
  const { graph, basis } = from ? { graph: decodeTreeSnapshotJSON(from.candidate), basis: { kind: "authored" as const, change: from.change } }
    : await editorView(coordinator, working);
  const source = readSource(graph, sourcePath);
  const { offset, length, replacement } = edit(source);
  const bytes = new TextEncoder().encode(source);
  const expected = new TextDecoder().decode(bytes.subarray(offset, offset + length));
  const result = new TextDecoder().decode(new Uint8Array([...bytes.subarray(0, offset), ...new TextEncoder().encode(replacement), ...bytes.subarray(offset + length)]));
  const record = prepareSourceChange({ change: `change-${crypto.randomUUID()}`, tree: log.tree, basis, graph, sourcePath,
    intent: { basis: { tree: log.tree, path: sourcePath.replace(/\.md$/, ""), revision: graph.root, source },
      edits: [{ offset, length, expected, replacement }], source: result } });
  await log.retain(record);
  await coordinator.noteLocalChange();
  return record;
}
