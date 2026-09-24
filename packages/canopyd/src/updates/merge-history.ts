import {
  compareWireNames,
  decodeWireDirectory,
  encodeWireDirectory,
  hashObject,
  type WireDirectoryEntry,
  stableJSONString,
  type AcceptedUpdate,
  type CandidateUpdate,
  type InspectedDecision,
  type MaterialRef,
  type ObjectHash,
  type SourceOperation,
} from "@overstory/protocol";
import { decodeLogEntry, encodeLogEntry, type AlternativeBinding, type LogDecision, type LogEntry } from "@overstory/merge-protocol";
import type { ObjectStore } from "@overstory/object-store";
import type { AcceptedUpdateStore } from "./store.ts";

const encoder = new TextEncoder();
const id = (value: unknown) => hashObject(encoder.encode(stableJSONString(value))).slice(7);

export interface OpenDecision {
  key: string;
  decision: LogDecision;
  inspection: InspectedDecision;
}

function operationReferences(op: SourceOperation): MaterialRef[] {
  if (op.kind === "addEntry") return [op.destination.parent];
  const refs = [op.source];
  if (op.kind === "editSource") refs.push(...(op.lineage ?? []).map((l) => l.source));
  if (op.kind === "moveSource" || op.kind === "copySource") refs.push(op.at);
  if (op.kind === "moveEntry" || op.kind === "copyEntry") refs.push(op.destination.parent);
  if (op.kind === "replaceEntry" && "material" in op.value) refs.push(op.value);
  return refs;
}

/** A small bounded cache of immutable values by hash. */
class Recent<T> {
  private readonly values = new Map<string, T>();
  constructor(private readonly limit: number) {}
  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value !== undefined) { this.values.delete(key); this.values.set(key, value); }
    return value;
  }
  set(key: string, value: T): void {
    this.values.set(key, value);
    for (const oldest of this.values.keys()) {
      if (this.values.size <= this.limit) break;
      this.values.delete(oldest);
    }
  }
}

/**
 * Accepted history as log entries in the object store. Each accepted row
 * names its entry; an entry names the one before it. Decisions live only in
 * entries, and their public identities are derived here: a decision's id from
 * its tree and key, an alternative's from its index.
 */
export class MergeHistory {
  private readonly entries = new Recent<LogEntry>(1024);
  private readonly inspected = new Recent<OpenDecision[]>(256);

  constructor(private readonly updates: AcceptedUpdateStore, private readonly objects: ObjectStore) {}

  /** Store an entry durably, before the transaction that records it. */
  async write(entry: LogEntry): Promise<{ hash: ObjectHash; conflicted: boolean }> {
    const bytes = encodeLogEntry(entry), hash = hashObject(bytes);
    await this.objects.store([{ hash, bytes }]);
    this.entries.set(hash, decodeLogEntry(bytes));
    return { hash, conflicted: entry.decisions.length > 0 };
  }

  async entry(hash: ObjectHash): Promise<LogEntry> {
    let entry = this.entries.get(hash);
    if (!entry) {
      entry = decodeLogEntry(await this.objects.read(hash));
      this.entries.set(hash, entry);
    }
    return entry;
  }

  /** The entry an accepted update recorded. Every accepted update has one. */
  async entryFor(update: AcceptedUpdate | string): Promise<{ hash: ObjectHash; entry: LogEntry }> {
    const updateID = typeof update === "string" ? update : update.id;
    const hash = this.updates.entryOf(updateID);
    if (!hash) throw new Error(`Accepted update ${updateID} has no log entry`);
    return { hash, entry: await this.entry(hash) };
  }

  /** Decisions open at an accepted update, with their public presentation. */
  async decisions(update: AcceptedUpdate | string): Promise<OpenDecision[]> {
    const { hash, entry } = await this.entryFor(update);
    let open = this.inspected.get(hash);
    if (!open) {
      open = await Promise.all(entry.decisions.map(async (decision) => ({
        key: decision.key, decision, inspection: await this.inspect(entry, decision),
      })));
      this.inspected.set(hash, open);
    }
    return open;
  }

  /** Carry open decisions onto a root that changed nothing they concern: a
   * choice about an entry keeps each alternative's version of that entry, now
   * in `root`. Null when an entry's parent is gone. New directories join
   * `objects`. */
  async carry(decisions: readonly LogDecision[], root: ObjectHash, objects: Map<ObjectHash, Uint8Array>): Promise<LogDecision[] | null> {
    const carried: LogDecision[] = [];
    for (const d of decisions) {
      if (!d.path || d.range) { carried.push(d); continue; }
      const alternatives = [];
      for (const a of d.alternatives) {
        const object = await this.withEntry(root, d.path, await this.at(a.object, d.path, objects), objects);
        if (!object) return null;
        alternatives.push({ ...a, object });
      }
      carried.push({ ...d, alternatives });
    }
    return carried;
  }

  private async withEntry(root: ObjectHash, names: readonly string[], entry: WireDirectoryEntry | null, objects: Map<ObjectHash, Uint8Array>): Promise<ObjectHash | null> {
    const directory = decodeWireDirectory(await this.objects.load(root, objects));
    const [name, ...rest] = names as [string, ...string[]];
    const prior = directory.entries.find((e) => e.name === name);
    let next = entry;
    if (rest.length) {
      if (!prior?.directory) return null;
      const child = await this.withEntry(prior.directory, rest, entry, objects);
      if (!child) return null;
      next = { ...prior, directory: child };
    }
    directory.entries = [...directory.entries.filter((e) => e.name !== name), ...(next ? [next] : [])]
      .sort((a, b) => compareWireNames(a.name, b.name));
    const bytes = encodeWireDirectory(directory), hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  }

  private async at(root: ObjectHash, names: readonly string[], objects: ReadonlyMap<ObjectHash, Uint8Array> = new Map()) {
    let object = root;
    for (const [index, name] of names.entries()) {
      const entry = decodeWireDirectory(await this.objects.load(object, objects)).entries.find((e) => e.name === name);
      if (!entry || index === names.length - 1) return entry ?? null;
      if (!entry.directory) return null;
      object = entry.directory;
    }
    return null;
  }

  /** A decision as inspection pages present it: a choice about an entry, a
   * source choice about a range of one file, or a choice about the root. */
  private async inspect(entry: LogEntry, d: LogDecision): Promise<InspectedDecision> {
    const decisionID = (key: string) => id([entry.tree, "decision", key]);
    const root: MaterialRef = { material: { kind: "basis", path: "/", object: entry.root } };
    // A revision names what the alternative holds, so an edit elsewhere in the
    // tree leaves it unchanged.
    const alternative = (index: number, value: InspectedDecision["alternatives"][number]["value"]) => ({
      id: id([entry.tree, "alternative", d.key, index]),
      revision: id([value, d.alternatives[index]!.contributions]),
      value,
      contributions: d.alternatives[index]!.contributions,
    });
    const common = {
      id: decisionID(d.key),
      selected: id([entry.tree, "alternative", d.key, d.selected]),
      dependencies: d.dependencies.map(decisionID),
      actions: ["resolveConflict"],
    };
    if (!d.path)
      return { ...common, kind: "directory", affected: [root], alternatives: d.alternatives.map((a, i) => alternative(i, { directory: a.object })) };
    const path = `/${d.path.join("/")}`;
    if (d.range) {
      const file = d.at ?? (await this.at(entry.root, d.path))?.file;
      if (!file) throw new Error("Source choice file is absent");
      return {
        ...common, kind: "content",
        affected: [{ material: { kind: "basis", path, object: file }, range: d.range }],
        alternatives: d.alternatives.map((a, i) => alternative(i, { file: a.object })),
      };
    }
    const parents = d.path.slice(0, -1), name = d.path.at(-1)!;
    const parent: MaterialRef = { ...root, ...(parents.length ? { within: parents } : {}) };
    const alternatives = [];
    for (const [index, a] of d.alternatives.entries()) {
      const value = await this.at(a.object, d.path);
      alternatives.push(value?.file ? { ...alternative(index, { file: value.file }), placement: { parent, name } }
        : value?.directory ? { ...alternative(index, { directory: value.directory }), placement: { parent, name } }
        : alternative(index, { absent: true }));
    }
    return { ...common, kind: "entry", affected: [parent], alternatives };
  }

  /** The decision keys a request's resolution guards name, or null when a
   * guard no longer matches `current`'s open decisions. A snapshot that
   * changes the root must also resolve what the resolved decisions depend on. */
  async guards(current: AcceptedUpdate, request: CandidateUpdate): Promise<string[] | null> {
    const open = request.resolves.length || request.trace === null ? await this.decisions(current) : [];
    const keys: string[] = [];
    for (const guard of request.resolves) {
      const decision = open.find((d) => d.inspection.id === guard.conflict);
      if (
        guard.state !== current.id ||
        !decision ||
        stableJSONString([...guard.alternatives].sort()) !== stableJSONString(decision.inspection.alternatives.map((a) => a.id).sort())
      )
        return null;
      keys.push(decision.key);
    }
    if (request.trace === null && request.candidate !== current.root) {
      const guarded = new Set(keys);
      for (const key of keys) {
        const decision = open.find((d) => d.key === key);
        if (decision?.inspection.dependencies.some((id) => !open.some((d) => d.inspection.id === id && guarded.has(d.key))))
          return null;
      }
    }
    return keys;
  }

  /** The keys resolution declarations name, wherever they are open, for a
   * candidate evaluated before its acceptance guard is checked. */
  async resolutionKeys(tree: string, resolves: CandidateUpdate["resolves"]): Promise<string[]> {
    const keys: string[] = [];
    for (const r of resolves) {
      const owner = this.updates.get(r.state);
      if (!owner || owner.tree !== tree) continue;
      keys.push(...(await this.decisions(owner)).filter((d) => d.inspection.id === r.conflict).map((d) => d.key));
    }
    return keys;
  }

  /** Bind every alternative a trace names as material to its decision key,
   * index and value. Only this tree's accepted decisions can be named. */
  async bindings(tree: string, trace: CandidateUpdate["trace"]): Promise<AlternativeBinding[]> {
    const bindings: AlternativeBinding[] = [];
    for (const frame of trace ?? [])
      for (const operation of frame.operations)
        for (const ref of operationReferences(operation)) {
          if (ref.material.kind !== "alternative") continue;
          const material = ref.material, owner = this.updates.get(material.state);
          if (!owner || owner.tree !== tree) throw new Error("Alternative belongs to another tree or unavailable state");
          const decision = (await this.decisions(owner)).find((d) => d.inspection.id === material.conflict);
          const index = decision?.inspection.alternatives.findIndex((a) => a.id === material.alternative) ?? -1;
          const value = decision?.inspection.alternatives[index]?.value;
          if (!decision || !value || (!("file" in value) && !("directory" in value)))
            throw new Error("Alternative material is unavailable");
          const binding: AlternativeBinding = {
            ref: { material },
            decision: decision.key,
            alternative: index,
            value: "file" in value ? { object: value.file, kind: "file" } : { object: value.directory, kind: "directory" },
          };
          if (!bindings.some((b) => stableJSONString(b.ref) === stableJSONString(binding.ref))) bindings.push(binding);
        }
    return bindings;
  }
}
