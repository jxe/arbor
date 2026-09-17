import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applySourceEdits, type SourceEdit } from "@arbor/core";
import { decodeTreeSnapshotJSON, encodeTreeSnapshotJSON, verifyTreeSnapshotGraph, decodeWireDirectory,
  encodeWireDirectory, hashObject, decodeCandidateUpdateJSON, encodeCandidateUpdateJSON,
  type TreeSnapshot, type TreeSnapshotJSON, type CandidateUpdateJSON, type SourceOperation } from "@arbor/wire";

export type SourceAdmissionBasis = { kind: "accepted"; root: string; update: string } | { kind: "authored"; change: string };
export interface SourceAdmissionIntent {
  basis: { tree: string; path: string; revision: string; source: string };
  edits: SourceEdit[];
  source: string;
}
export interface SourceAdmissionRecord {
  change: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshotJSON;
  sourcePath: string; intent: SourceAdmissionIntent; candidate: TreeSnapshotJSON; update: CandidateUpdateJSON;
}
const encoder = new TextEncoder();
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((k, i) => k === other[i] && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
function snapshotJSON(snapshot: TreeSnapshot): TreeSnapshotJSON {
  return encodeTreeSnapshotJSON({ root: snapshot.root, objects: new Map([...snapshot.objects].sort(([a], [b]) => a.localeCompare(b))) });
}

/** Builds only the exact authored candidate, never a merge with the current tree. */
export function prepareSourceAdmission(input: {
  change?: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshot;
  sourcePath: string; intent: SourceAdmissionIntent;
}): SourceAdmissionRecord {
  const { tree, sourcePath, intent, graph } = input;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (intent.basis.tree !== tree || typeof intent.basis.revision !== "string" || !intent.basis.revision ||
      typeof intent.basis.path !== "string" || typeof intent.basis.source !== "string" || typeof intent.source !== "string" ||
      decoder.decode(encoder.encode(intent.basis.source)) !== intent.basis.source ||
      !Array.isArray(intent.edits) || !intent.edits.length ||
      intent.edits.some(e => typeof e.replacement !== "string" || decoder.decode(encoder.encode(e.replacement)) !== e.replacement ||
        (e.expected !== undefined && (typeof e.expected !== "string" || decoder.decode(encoder.encode(e.expected)) !== e.expected))) ||
      applySourceEdits(intent.basis.source, intent.edits) !== intent.source) throw new Error("Invalid source intent");
  const parts = sourcePath.slice(1).split("/");
  if (!sourcePath.startsWith("/") || parts.some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p) || p.normalize("NFC") !== p)) throw new Error("Invalid source path");
  verifyTreeSnapshotGraph(graph, "sparse-files");
  const objects = new Map(graph.objects);
  let file = "";
  function replace(hash: string, depth: number): string {
    const bytes = graph.objects.get(hash);
    if (!bytes) throw new Error("Missing directory basis");
    const directory = decodeWireDirectory(bytes), entry = directory.entries.find(e => e.name === parts[depth]);
    if (!entry && depth === parts.length - 1 && parts[depth] === "_index.md" && intent.basis.source === "") {
      const source = encoder.encode(intent.source), file = hashObject(source);
      objects.set(file, source);
      directory.entries.push({ name: "_index.md", file });
      directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const next = encodeWireDirectory(directory), root = hashObject(next); objects.set(root, next); return root;
    }
    if (!entry) throw new Error("Source path is not in basis");
    if (depth === parts.length - 1) {
      if (!entry.file || !equal([...graph.objects.get(entry.file) ?? []], [...encoder.encode(intent.basis.source)]) || !graph.objects.has(entry.file)) throw new Error("Source bytes do not match basis");
      file = entry.file;
      const source = encoder.encode(intent.source);
      entry.file = hashObject(source); objects.set(entry.file, source);
    } else {
      if (!entry.directory) throw new Error("Source path crosses a file or tree boundary");
      entry.directory = replace(entry.directory, depth + 1);
    }
    const next = encodeWireDirectory(directory), root = hashObject(next); objects.set(root, next); return root;
  }
  const root = replace(graph.root, 0), reachable = new Set<string>();
  function visit(hash: string, kind: "file" | "directory") {
    if (reachable.has(hash)) return;
    reachable.add(hash);
    if (kind === "directory") for (const entry of decodeWireDirectory(objects.get(hash)!).entries) {
      if (entry.file) visit(entry.file, "file"); else if (entry.directory) visit(entry.directory, "directory");
    }
  }
  visit(root, "directory");
  const candidate = verifyTreeSnapshotGraph({ root, objects: new Map([...objects].filter(([hash]) => reachable.has(hash))) }, "sparse-files");
  const sourceBytes = encoder.encode(intent.basis.source);
  const operations: SourceOperation[] = intent.edits.map((edit, i) => {
    for (const offset of [edit.offset, edit.offset + edit.length]) if (offset < sourceBytes.length && (sourceBytes[offset]! & 0xc0) === 0x80) throw new Error("Source range splits a UTF-8 scalar");
    return { kind: "editSource", key: `edit-${i}`, source: { material: { kind: "basis", path: sourcePath, object: file }, range: [edit.offset, edit.offset + edit.length] }, text: edit.replacement };
  });
  const change = input.change ?? crypto.randomUUID();
  const update = encodeCandidateUpdateJSON({ candidate: root, change, operations: file ? operations : null, resolves: [],
    objects: [...candidate.objects].filter(([hash]) => !graph.objects.has(hash)).sort(([a], [b]) => a.localeCompare(b)).map(([hash, bytes]) => ({ hash, bytes })), deltas: [] });
  decodeCandidateUpdateJSON(update);
  return JSON.parse(JSON.stringify({ change, tree, basis: input.basis, graph: snapshotJSON(graph), sourcePath, intent, candidate: snapshotJSON(candidate), update }));
}

export function validateSourceAdmissions(records: SourceAdmissionRecord[], tree: string): void {
  const prior = new Map<string, SourceAdmissionRecord>();
  for (const record of records) {
    if (record.tree !== tree || prior.has(record.change)) throw new Error("Invalid queue scope or duplicate identity");
    if (new Set(record.graph.objects.map(o => o.hash)).size !== record.graph.objects.length) throw new Error("Duplicate basis object");
    const rebuilt = prepareSourceAdmission({ ...record, graph: decodeTreeSnapshotJSON(record.graph) });
    if (!equal(rebuilt, record)) throw new Error("Retained source candidate or operations changed");
    if (record.basis.kind === "accepted") {
      if (!record.basis.update || record.basis.root !== record.graph.root) throw new Error("Accepted basis does not match graph");
    } else if (record.basis.kind !== "authored" || !equal(prior.get(record.basis.change)?.candidate, record.graph)) throw new Error("Missing or altered authored basis");
    prior.set(record.change, record);
  }
}

const writers = new Map<string, Promise<unknown>>();
/** One client process owns a state directory, as with the existing sync state.
 * Instances in that process serialize commits to the same canonical path.
 * SourceAdmissionPublisher consumes the journal only when its host enables emission.
 */
export class SourceAdmissionQueue {
  readonly path: string;
  constructor(readonly tree: string, stateRoot: string) { this.path = resolve(stateRoot, "sync", "source-admissions.json"); }
  async retained(): Promise<SourceAdmissionRecord[]> {
    let records: SourceAdmissionRecord[];
    try { records = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    validateSourceAdmissions(records, this.tree); return records;
  }
  async retain(value: SourceAdmissionRecord): Promise<void> {
    const record = structuredClone(value);
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const records = await this.retained(), prior = records.find(r => r.change === record.change);
      if (prior && !equal(prior, record)) throw new Error("Authored identity was reused");
      if (!prior) records.push(record);
      // Repeat the durable write on an exact retry: an earlier rename may have
      // succeeded before directory synchronization failed.
      validateSourceAdmissions(records, this.tree);
      const directory = dirname(this.path), temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(records)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
        const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
        const parent = await open(dirname(directory), "r"); try { await parent.sync(); } finally { await parent.close(); }
      } finally { await rm(temporary, { force: true }); }
    });
    writers.set(this.path, next);
    try { await next; } finally { if (writers.get(this.path) === next) writers.delete(this.path); }
  }
  async request(through: string): Promise<{ base: { root: string; update: string }; request: { base: string; updates: CandidateUpdateJSON[] } }> {
    const records = await this.retained(), updates: CandidateUpdateJSON[] = [];
    let current = through;
    for (;;) {
      const record = records.find(r => r.change === current); if (!record) throw new Error("Missing authored dependency");
      updates.unshift(record.update);
      if (record.basis.kind === "accepted") return { base: { root: record.basis.root, update: record.basis.update }, request: { base: record.basis.update, updates } };
      current = record.basis.change;
    }
  }
}
