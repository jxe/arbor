import {prepareEntryTransfer, type EntryTransfer} from "./entry-transfer.ts";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applySourceEdits, type SourceEdit } from "@arbor/core";
import { decodeTreeSnapshotJSON, encodeTreeSnapshotJSON, verifyTreeSnapshotGraph, decodeWireDirectory,
  encodeWireDirectory, hashObject, decodeCandidateUpdateJSON, encodeCandidateUpdateJSON,
  encodeObjectEnvelopes, type TreeSnapshot, type TreeSnapshotJSON, type CandidateUpdateJSON, type SourceOperation } from "@arbor/wire";

export type SourceAdmissionBasis = { kind: "accepted"; root: string; update: string } | { kind: "authored"; change: string };
export interface SourceAdmissionIntent {
  basis: { tree: string; path: string; revision: string; source: string };
  edits: SourceEdit[];
  source: string;
}
export interface SourceAdmissionRecord {
  change: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshotJSON;
  sourcePath: string | null; intent: SourceAdmissionIntent | null; entryTransfer?: EntryTransfer; candidate: TreeSnapshotJSON; update: CandidateUpdateJSON;
}
interface StoredSourceSnapshot { root: string; objects: string[] }
type StoredSourceAdmissionRecord = Omit<SourceAdmissionRecord, "graph" | "candidate" | "update"> & {
  graph: StoredSourceSnapshot; candidate: StoredSourceSnapshot; update: CandidateUpdateJSON; updateObjects: string[];
};
interface SourceAdmissionJournal { schema: 2; tree: string; records: StoredSourceAdmissionRecord[] }
interface JournalFingerprint { size: number; modified: number; inode: number }
/** Durable platform objects addressable by canonical wire hash. Source queues
 * keep only admission-created objects when this shared store is supplied. */
export interface SourceAdmissionObjectStore {
  bytes(hash: string): Promise<Uint8Array | undefined>;
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
}): SourceAdmissionRecord & {intent: SourceAdmissionIntent; sourcePath: string} {
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
    return { kind: "editSource", key: `edit-${i}`, source: { material: { kind: "basis", path: sourcePath, object: file }, range: [edit.offset, edit.offset + edit.length] }, text: edit.replacement, ...(edit.lineage ? {lineage: edit.lineage.map(part => ({source: {material: {kind: "basis" as const, path: sourcePath, object: file}, range: part.source}, range: part.replacement}))} : {}) };
  });
  const change = input.change ?? crypto.randomUUID();
  const update = encodeCandidateUpdateJSON({ candidate: root, change, operations: file ? operations : null, resolves: [],
    objects: [...candidate.objects].filter(([hash]) => !graph.objects.has(hash)).sort(([a], [b]) => a.localeCompare(b)).map(([hash, bytes]) => ({ hash, bytes })), deltas: [] });
  decodeCandidateUpdateJSON(update);
  return JSON.parse(JSON.stringify({ change, tree, basis: input.basis, graph: snapshotJSON(graph), sourcePath, intent, candidate: snapshotJSON(candidate), update }));
}

export function prepareEntryAdmission(input: {
  change?: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshot; entryTransfer: EntryTransfer; candidate?: TreeSnapshot;
}): SourceAdmissionRecord {
  const change=input.change ?? crypto.randomUUID();
  const {candidate,operations}=prepareEntryTransfer(input.graph,input.entryTransfer,{change,candidate:input.candidate});
  if(input.candidate && input.candidate.root!==candidate.root)throw Error("Entry intent does not reproduce candidate");
  const update=encodeCandidateUpdateJSON({change,candidate:candidate.root,operations,resolves:[],deltas:[],objects:[...candidate.objects].filter(([hash])=>!input.graph.objects.has(hash)).sort(([a],[b])=>a.localeCompare(b)).map(([hash,bytes])=>({hash,bytes}))});
  decodeCandidateUpdateJSON(update);
  return {change,tree:input.tree,basis:input.basis,graph:snapshotJSON(input.graph),sourcePath:null,intent:null,entryTransfer:structuredClone(input.entryTransfer),candidate:snapshotJSON(candidate),update};
}

function rebuildAdmission(record: SourceAdmissionRecord): SourceAdmissionRecord {
  const graph=decodeTreeSnapshotJSON(record.graph);
  if(record.intent && record.sourcePath && !record.entryTransfer) return prepareSourceAdmission({...record,graph,intent:record.intent,sourcePath:record.sourcePath});
  if(record.intent===null && record.sourcePath===null && record.entryTransfer) return prepareEntryAdmission({...record,graph,candidate:decodeTreeSnapshotJSON(record.candidate),entryTransfer:record.entryTransfer});
  throw Error("Incomplete captured intent");
}

export function validateSourceAdmissions(records: SourceAdmissionRecord[], tree: string): void {
  const prior = new Map<string, SourceAdmissionRecord>();
  for (const record of records) {
    if (record.tree !== tree || prior.has(record.change)) throw new Error("Invalid queue scope or duplicate identity");
    if (new Set(record.graph.objects.map(o => o.hash)).size !== record.graph.objects.length) throw new Error("Duplicate basis object");
    const rebuilt = rebuildAdmission(record);
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
  readonly objectsPath: string;
  private records?: SourceAdmissionRecord[];
  private fingerprint?: JournalFingerprint;
  private readonly objects = new Map<string, Uint8Array>();
  constructor(readonly tree: string, stateRoot: string, private readonly platform?: SourceAdmissionObjectStore) {
    this.path = resolve(stateRoot, "sync", "source-admissions.json");
    this.objectsPath = resolve(stateRoot, "sync", "source-admission-objects");
  }
  async retained(): Promise<SourceAdmissionRecord[]> {
    const fingerprint = await this.currentFingerprint();
    if (!this.records || !equal(fingerprint, this.fingerprint)) await this.load();
    return structuredClone(this.records!);
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
      await this.write(records);
    });
    writers.set(this.path, next);
    try { await next; } finally { if (writers.get(this.path) === next) writers.delete(this.path); }
  }
  /** Remove settled records unless a pending authored descendant still needs them. */
  async compact(settled: ReadonlySet<string>, preservingSettledTail = true): Promise<boolean> {
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await this.load();
      const records = this.records!;
      const required = new Set(records.filter(record => !settled.has(record.change)).map(record => record.change));
      if (preservingSettledTail && !required.size && records.length) required.add(records.at(-1)!.change);
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) if (required.has(record.change) && record.basis.kind === "authored" && !required.has(record.basis.change)) {
          required.add(record.basis.change); changed = true;
        }
      }
      const retained = records.filter(record => required.has(record.change));
      if (retained.length !== records.length) await this.write(retained);
      return retained.length === 0;
    });
    writers.set(this.path, next);
    try { return await next; } finally { if (writers.get(this.path) === next) writers.delete(this.path); }
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

  private async load(settled: ReadonlySet<string> = new Set()): Promise<void> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = []; this.fingerprint = undefined; return;
      }
      throw error;
    }
    if (Array.isArray(value)) {
      const legacy = value as SourceAdmissionRecord[];
      if (legacy.length && legacy.every(record => typeof record.change === "string" && settled.has(record.change))) {
        await this.write([]); return;
      }
      validateSourceAdmissions(legacy, this.tree);
      // Legacy recovery is self-contained even when its platform no longer
      // retains an old accepted basis.
      await this.write(legacy, true);
      return;
    }
    const journal = value as Partial<SourceAdmissionJournal>;
    if (journal.schema !== 2 || journal.tree !== this.tree || !Array.isArray(journal.records)) throw new Error("Invalid source admission journal");
    if (journal.records.length && journal.records.every(record => typeof record.change === "string" && settled.has(record.change))) {
      await this.write([]); return;
    }
    const hashes = new Set(journal.records.flatMap(record => [...record.graph.objects, ...record.candidate.objects, ...record.updateObjects]));
    await Promise.all([...hashes].map(async hash => {
      if (!this.objects.has(hash)) this.objects.set(hash, await this.objectBytes(hash));
    }));
    const records = journal.records.map(record => this.materialize(record));
    validateSourceAdmissions(records, this.tree);
    this.records = records;
    this.fingerprint = await this.currentFingerprint();
  }

  private async write(records: SourceAdmissionRecord[], selfContained = false): Promise<void> {
    const snapshots = records.flatMap(record => [decodeTreeSnapshotJSON(record.graph), decodeTreeSnapshotJSON(record.candidate)]);
    const presented = new Map<string, Uint8Array>();
    for (const snapshot of snapshots) for (const [hash, bytes] of snapshot.objects) {
      if (!this.platform || selfContained) presented.set(hash, bytes);
      this.objects.set(hash, bytes);
    }
    // Update envelopes are exactly the objects introduced relative to each
    // graph. They remain queue-owned until the admission settles.
    for (const record of records) for (const object of decodeCandidateUpdateJSON(record.update).objects) {
      presented.set(object.hash, object.bytes);
    }
    await mkdir(this.objectsPath, { recursive: true, mode: 0o700 });
    await Promise.all([...presented].map(([hash, bytes]) => this.writeObject(hash, bytes)));
    const journal: SourceAdmissionJournal = { schema: 2, tree: this.tree, records: records.map(record => this.stored(record)) };
    const directory = dirname(this.path), temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
      const parent = await open(dirname(directory), "r"); try { await parent.sync(); } finally { await parent.close(); }
    } finally { await rm(temporary, { force: true }); }
    const retained = new Set(journal.records.flatMap(record => [...record.graph.objects, ...record.candidate.objects, ...record.updateObjects]));
    for (const name of await readdir(this.objectsPath)) {
      const hash = `sha256:${name}`;
      if (/^[0-9a-f]{64}$/.test(name) && !retained.has(hash)) await rm(resolve(this.objectsPath, name), { force: true });
    }
    for (const hash of this.objects.keys()) if (!retained.has(hash)) this.objects.delete(hash);
    this.records = structuredClone(records);
    this.fingerprint = await this.currentFingerprint();
  }

  private stored(record: SourceAdmissionRecord): StoredSourceAdmissionRecord {
    const { graph, candidate, update, ...rest } = record;
    return { ...rest,
      graph: { root: graph.root, objects: graph.objects.map(object => object.hash).sort() },
      candidate: { root: candidate.root, objects: candidate.objects.map(object => object.hash).sort() },
      update: { ...update, objects: [] }, updateObjects: update.objects.map(object => object.hash).sort() };
  }

  private materialize(record: StoredSourceAdmissionRecord): SourceAdmissionRecord {
    const snapshot = (stored: StoredSourceSnapshot): TreeSnapshotJSON => snapshotJSON({ root: stored.root,
      objects: new Map(stored.objects.map(hash => {
        const bytes = this.objects.get(hash); if (!bytes) throw new Error(`Missing source admission object ${hash}`); return [hash, bytes];
      })) });
    const { updateObjects, ...stored } = record;
    const update = { ...stored.update, objects: encodeObjectEnvelopes(updateObjects.map(hash => {
      const bytes = this.objects.get(hash); if (!bytes) throw new Error(`Missing source admission object ${hash}`); return [hash, bytes] as const;
    })) };
    const value = { ...stored, update, graph: snapshot(record.graph), candidate: snapshot(record.candidate) };
    const rebuilt = rebuildAdmission(value);
    if (!equal(rebuilt, value)) throw new Error("Retained source candidate or operations changed");
    return value;
  }

  private objectPath(hash: string): string {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid source admission object hash");
    return resolve(this.objectsPath, hash.slice("sha256:".length));
  }
  private async readObject(hash: string): Promise<Uint8Array> {
    const bytes = new Uint8Array(await readFile(this.objectPath(hash)));
    if (hashObject(bytes) !== hash) throw new Error(`Source admission object hash mismatch: ${hash}`);
    return bytes;
  }
  private async objectBytes(hash: string): Promise<Uint8Array> {
    try { return await this.readObject(hash); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !this.platform) throw error;
    }
    const bytes = await this.platform.bytes(hash);
    if (!bytes) throw new Error(`Missing source admission object ${hash}`);
    if (hashObject(bytes) !== hash) throw new Error(`Source admission object hash mismatch: ${hash}`);
    return bytes;
  }
  private async writeObject(hash: string, bytes: Uint8Array): Promise<void> {
    if (hashObject(bytes) !== hash) throw new Error(`Source admission object hash mismatch: ${hash}`);
    const destination = this.objectPath(hash);
    try {
      const existing = await this.readObject(hash);
      if (!equal([...existing], [...bytes])) throw new Error(`Source admission object changed: ${hash}`);
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, destination);
      const dir = await open(this.objectsPath, "r"); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  private async currentFingerprint(): Promise<JournalFingerprint | undefined> {
    try {
      const value = await stat(this.path);
      return { size: value.size, modified: value.mtimeMs, inode: Number(value.ino) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}
