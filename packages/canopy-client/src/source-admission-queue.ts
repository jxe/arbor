import {prepareEntryActions, prepareEntryTransfer, type EntryActions, type EntryTransfer} from "./entry-transfer.ts";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applySourceEdits, canonicalCBORHash, composeSourceEdits, type PlainSourceEdit, type SourceEdit } from "@arbor/core";
import { decodeTreeSnapshotJSON, encodeTreeSnapshotJSON, verifyTreeSnapshotGraph, decodeWireDirectory,
  encodeWireDirectory, hashObject, decodeCandidateUpdateJSON, encodeCandidateUpdateJSON,
  encodeObjectEnvelopes, type TreeSnapshot, type TreeSnapshotJSON, type CandidateUpdateJSON, type SourceOperation } from "@arbor/wire";

export type SourceAdmissionBasis = { kind: "accepted"; root: string; update: string } | { kind: "authored"; change: string };
/** One editor generation of a coalesced intent: its edits against the source
 * the previous generation produced, and the source it produced. */
export interface SourceAdmissionGeneration { edits: SourceEdit[]; source: string }
/** `edits` always take the basis to `source` in one step. `generations`, when
 * present, is the same change as the editor captured it, one generation after
 * another, ending at `source`; the queue emits one frame per generation. */
export interface SourceAdmissionIntent {
  basis: { tree: string; path: string; revision: string; source: string };
  edits: SourceEdit[];
  source: string;
  generations?: SourceAdmissionGeneration[];
}
export interface SourcePageCreation { document: {tree: string; path: string}; removals: string[] }
/** What a source record remembers of its editor capture: enough to serve the
 * document's hidden candidate and recognize an exact retry, never the bytes. */
export interface SourceDocumentCapture { path: string; basisRevision: string; intentDigest: string }
/** Records keep hashes, the wire element, and a capture summary; undo is an
 * ordinary edit and no document source or editor transaction is retained. */
export interface SourceAdmissionRecord {
  creation?: SourcePageCreation;
  change: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshotJSON;
  sourcePath: string | null; document: SourceDocumentCapture | null; entryTransfer?: EntryTransfer; entryActions?: EntryActions; candidate: TreeSnapshotJSON; update: CandidateUpdateJSON;
}
interface StoredSourceSnapshot { root: string; objects: string[] }
type StoredSourceAdmissionRecord = Omit<SourceAdmissionRecord, "graph" | "candidate" | "update"> & {
  graph: StoredSourceSnapshot; candidate: StoredSourceSnapshot; update: CandidateUpdateJSON; updateObjects: string[];
};
/** Schema 4 stores the wire element verbatim with its frame chain. */
interface SourceAdmissionJournal { schema: 4; tree: string; records: StoredSourceAdmissionRecord[] }
export function sourceIntentDigest(intent: SourceAdmissionIntent): string { return canonicalCBORHash(intent); }
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

/** Keep preserved occurrences out of an edit's authored footprint. For ordered
 * lineage, compile only the gaps; copies cannot overlap preserved spans. */
function operationEdits(edits: SourceEdit[]): SourceEdit[] {
  return edits.flatMap(edit=>{
    const lineage=edit.lineage??[];
    if(!edit.copies?.length || !lineage.length)return [edit];
    let previous=edit.offset;
    for(const part of lineage){if(part.source[0]<previous)return [edit];previous=part.source[1];}
    const bytes=encoder.encode(edit.replacement),result:SourceEdit[]=[];
    let source=edit.offset,output=0;
    for(const part of [...lineage,{source:[edit.offset+edit.length,edit.offset+edit.length] as [number,number],replacement:[bytes.length,bytes.length] as [number,number]}]) {
      const end=part.replacement[0];
      if(source!==part.source[0]||output!==end) {
        const copies=edit.copies.filter(c=>c.replacement[0]>=output&&c.replacement[1]<=end).map(c=>({...c,replacement:[c.replacement[0]-output,c.replacement[1]-output] as [number,number]}));
        result.push({offset:source,length:part.source[0]-source,replacement:new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes.subarray(output,end)),...(copies.length?{copies}:{})});
      }
      source=part.source[1];output=part.replacement[1];
    }
    return result;
  });
}

/** The wire allows this many frames per element and this many operations
 * across them. A trace that would exceed either after compaction is dropped
 * to snapshot semantics: exact bytes stay authoritative. */
const TRACE_FRAME_LIMIT = 64, TRACE_OPERATION_LIMIT = 1024;

function validText(value: unknown, decoder: TextDecoder): value is string {
  return typeof value === "string" && decoder.decode(encoder.encode(value)) === value;
}
function validEdits(edits: unknown, decoder: TextDecoder): edits is SourceEdit[] {
  return Array.isArray(edits) && edits.every(e => validText(e.replacement, decoder) && (e.expected === undefined || validText(e.expected, decoder)));
}

/** Builds only the exact authored candidate, never a merge with the current
 * tree. A multi-generation intent yields one frame per generation, each from
 * the root the previous generation produced, with operation keys
 * `edit-<frame>-<index>`; `compact` (default) then merges adjacent frames of
 * plain edits (`compactTrace`). Only the final candidate's objects travel; the
 * authority reproduces intermediate roots by executing the frames. */
export function prepareSourceAdmission(input: {
  change?: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshot;
  sourcePath: string; intent: SourceAdmissionIntent; compact?: boolean;
}): SourceAdmissionRecord & {document: SourceDocumentCapture; sourcePath: string} {
  const { tree, sourcePath, intent, graph } = input;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (intent.basis.tree !== tree || typeof intent.basis.revision !== "string" || !intent.basis.revision ||
      typeof intent.basis.path !== "string" || !validText(intent.basis.source, decoder) || typeof intent.source !== "string" ||
      !validEdits(intent.edits, decoder) || !intent.edits.length ||
      applySourceEdits(intent.basis.source, intent.edits) !== intent.source ||
      (intent.generations !== undefined && (!Array.isArray(intent.generations) || intent.generations.some(g => !validEdits(g.edits, decoder) || typeof g.source !== "string")))) throw new Error("Invalid source intent");
  validateSourceIntent(intent);
  // A generation that changed nothing states nothing; the rest chain exactly.
  const generations = (intent.generations ?? [{ edits: intent.edits, source: intent.source }]).filter(g => g.edits.length);
  if (!generations.length) throw new Error("Invalid source intent");
  const parts = sourcePath.slice(1).split("/");
  if (!sourcePath.startsWith("/") || parts.some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p) || p.normalize("NFC") !== p)) throw new Error("Invalid source path");
  verifyTreeSnapshotGraph(graph, "sparse-files");
  const objects = new Map(graph.objects);
  let file = "";
  function replace(hash: string, depth: number, previous: string, source: string): string {
    const bytes = objects.get(hash);
    if (!bytes) throw new Error("Missing directory basis");
    const directory = decodeWireDirectory(bytes), entry = directory.entries.find(e => e.name === parts[depth]);
    if (!entry && depth === parts.length - 1 && parts[depth] === "_index.md" && previous === "") {
      const produced = encoder.encode(source), file = hashObject(produced);
      objects.set(file, produced);
      directory.entries.push({ name: "_index.md", file });
      directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const next = encodeWireDirectory(directory), root = hashObject(next); objects.set(root, next); return root;
    }
    if (!entry) throw new Error("Source path is not in basis");
    if (depth === parts.length - 1) {
      if (!entry.file || !objects.has(entry.file) || !equal([...objects.get(entry.file)!], [...encoder.encode(previous)])) throw new Error("Source bytes do not match basis");
      file = entry.file;
      const produced = encoder.encode(source);
      entry.file = hashObject(produced); objects.set(entry.file, produced);
    } else {
      if (!entry.directory) throw new Error("Source path crosses a file or tree boundary");
      entry.directory = replace(entry.directory, depth + 1, previous, source);
    }
    const next = encodeWireDirectory(directory), root = hashObject(next); objects.set(root, next); return root;
  }
  const change = input.change ?? crypto.randomUUID();
  function copyMaterial(copy: NonNullable<SourceEdit["copies"]>[number], file: string): {kind: "basis"; path: string; object: string} {
    if (!copy.document) return {kind: "basis", path: sourcePath, object: file};
    const {path, source} = copy.document, parts = path.slice(1).split("/");
    if (!path.startsWith("/") || parts.some(p => !p || p === "." || p === "..")) throw Error("Invalid copy path");
    // Other documents are untouched by this record, so their basis object is
    // the same in every frame's `before` tree.
    let hash = graph.root;
    for (const [index, part] of parts.entries()) {
      const entry = decodeWireDirectory(graph.objects.get(hash)!).entries.find(e => e.name === part);
      if (index === parts.length - 1) {
        if (!entry?.file || !graph.objects.has(entry.file) || decoder.decode(graph.objects.get(entry.file)!) !== source) throw Error("Copy source changed or crosses a tree boundary");
        return {kind: "basis", path, object: entry.file};
      }
      if (!entry?.directory) throw Error("Copy source crosses a tree boundary");
      hash = entry.directory;
    }
    throw Error("Invalid copy path");
  }
  let frames: SourceFrame[] = [], evidence = true;
  const sources = new Map<string, string>([[graph.root, intent.basis.source]]);
  let previousRoot = graph.root, previousSource = intent.basis.source;
  for (const [frame, generation] of generations.entries()) {
    file = "";
    const root = replace(previousRoot, 0, previousSource, generation.source);
    sources.set(root, generation.source);
    const sourceBytes = encoder.encode(previousSource);
    const operations: SourceOperation[] = operationEdits(generation.edits).flatMap((edit, i) => {
      for (const offset of [edit.offset, edit.offset + edit.length]) if (offset < sourceBytes.length && (sourceBytes[offset]! & 0xc0) === 0x80) throw new Error("Source range splits a UTF-8 scalar");
      if (!file) return [];
      const key = `edit-${frame}-${i}`;
      if(edit.length===0 && edit.copies?.length===1 && edit.copies[0]!.replacement[0]===0 && edit.copies[0]!.replacement[1]===encoder.encode(edit.replacement).length) {
        return [{key:`copy-${frame}-${i}-0`,kind:"copySource",source:{material:copyMaterial(edit.copies[0]!, file),range:edit.copies[0]!.source},at:{material:{kind:"basis",path:sourcePath,object:file},range:[edit.offset,edit.offset]},side:"before"} as SourceOperation];
      }
      const operation:SourceOperation = { kind: "editSource", key, source: { material: { kind: "basis", path: sourcePath, object: file }, range: [edit.offset, edit.offset + edit.length] }, text: edit.replacement, ...(edit.lineage ? {lineage: edit.lineage.map(part => ({source: {material: {kind: "basis" as const, path: sourcePath, object: file}, range: part.source}, range: part.replacement}))} : {}) };
      const result:SourceOperation[]=[operation];
      for(const [j,copy] of (edit.copies??[]).entries()) {
        const target={material:{kind:"operation" as const,change,operation:key},range:copy.replacement};
        result.push({key:`copy-${frame}-${i}-${j}`,kind:"copySource",source:{material:copyMaterial(copy, file),range:copy.source},at:target,side:"before"});
        result.push({key:`copy-placeholder-${frame}-${i}-${j}`,kind:"editSource",source:target,text:""});
      }
      return result;
    });
    // A generation without operations (the first body of a directory) cannot
    // be a frame; the whole record is then a snapshot.
    if (!file || !operations.length) evidence = false;
    frames.push({ before: previousRoot, after: root, operations });
    previousRoot = root; previousSource = generation.source;
  }
  const root = previousRoot, reachable = new Set<string>();
  function visit(hash: string, kind: "file" | "directory") {
    if (reachable.has(hash)) return;
    reachable.add(hash);
    if (kind === "directory") for (const entry of decodeWireDirectory(objects.get(hash)!).entries) {
      if (entry.file) visit(entry.file, "file"); else if (entry.directory) visit(entry.directory, "directory");
    }
  }
  visit(root, "directory");
  const candidate = verifyTreeSnapshotGraph({ root, objects: new Map([...objects].filter(([hash]) => reachable.has(hash))) }, "sparse-files");
  if (evidence && input.compact !== false) {
    // A compacted frame is proven against the generation sources it spans
    // before it replaces the chain; otherwise the chain stays.
    const compacted = compactTrace(frames);
    if (compacted.every(frame => reproduces(frame, sourcePath, sources))) frames = compacted;
  }
  if (frames.length > TRACE_FRAME_LIMIT || frames.reduce((total, frame) => total + frame.operations.length, 0) > TRACE_OPERATION_LIMIT) evidence = false;
  const update = encodeCandidateUpdateJSON({ candidate: root, change,
    trace: evidence && frames.length ? frames : null, resolves: [],
    objects: [...candidate.objects].filter(([hash]) => !graph.objects.has(hash)).sort(([a], [b]) => a.localeCompare(b)).map(([hash, bytes]) => ({ hash, bytes })), deltas: [] });
  decodeCandidateUpdateJSON(update);
  const document: SourceDocumentCapture = { path: intent.basis.path, basisRevision: intent.basis.revision, intentDigest: sourceIntentDigest(intent) };
  return JSON.parse(JSON.stringify({ change, tree, basis: input.basis, graph: snapshotJSON(graph), sourcePath, document, candidate: snapshotJSON(candidate), update }));
}

/** `edits` must take the basis to `source`; each generation must reproduce
 * the next exactly and the chain must end at `source`. */
export function validateSourceIntent(intent: SourceAdmissionIntent): void {
  if (applySourceEdits(intent.basis.source, intent.edits) !== intent.source) throw Error("Invalid source intent");
  let previous = intent.basis.source;
  for (const generation of intent.generations ?? []) {
    if (applySourceEdits(previous, generation.edits) !== generation.source) throw Error("Invalid source generation");
    previous = generation.source;
  }
  if (intent.generations && previous !== intent.source) throw Error("Source generations do not end at the candidate");
}

/** One tree-root to tree-root step of a record's evidence, as the wire carries it. */
export interface SourceFrame { before: string; after: string; operations: SourceOperation[] }

/** A frame is plain when every operation is a lineage-free `editSource` over
 * `basis` material of one path with a range: what `composeSourceEdits` handles. */
function plainEdits(frame: SourceFrame): { path: string; object: string; edits: PlainSourceEdit[] } | null {
  let path: string | undefined, object: string | undefined;
  const edits: PlainSourceEdit[] = [];
  for (const operation of frame.operations) {
    if (operation.kind !== "editSource" || operation.lineage?.length || operation.source.material.kind !== "basis" || operation.source.within?.length || !operation.source.range) return null;
    const material = operation.source.material;
    if ((path !== undefined && path !== material.path) || (object !== undefined && object !== material.object)) return null;
    path = material.path; object = material.object;
    edits.push({ offset: operation.source.range[0], length: operation.source.range[1] - operation.source.range[0], replacement: operation.text });
  }
  if (path === undefined || object === undefined) return null;
  return { path, object, edits: edits.sort((a, b) => a.offset - b.offset) };
}

/** Merges runs of adjacent plain frames over one path into one frame each, by
 * `composeSourceEdits`: the merged frame runs from the first frame's `before`
 * to the last frame's `after`, names the path's object in the first frame, and
 * keys its operations `edit-<k>-<i>` where `k` is the first frame's index in
 * `frames`. A run that ends at the root it started from changed nothing and
 * yields no frame. Frames with lineage, copies or operation material are kept
 * as they are, so a claim always stays in the frame whose basis it was
 * captured against (spec/09). The same rule runs in the Swift queue and in
 * Canopy's `composeFrames`; `conformance/source-admission-queue.json` holds the
 * shared vectors. */
export function compactTrace(frames: readonly SourceFrame[]): SourceFrame[] {
  const result: SourceFrame[] = [];
  let index = 0;
  while (index < frames.length) {
    const first = plainEdits(frames[index]!);
    if (!first) { result.push(frames[index]!); index++; continue; }
    let end = index + 1;
    const generations = [first.edits];
    while (end < frames.length) {
      const next = plainEdits(frames[end]!);
      if (!next || next.path !== first.path) break;
      generations.push(next.edits); end++;
    }
    const before = frames[index]!.before, after = frames[end - 1]!.after;
    if (end - index === 1) result.push(frames[index]!);
    else if (before === after) { /* a plain run back to its start states nothing */ }
    else {
      const operations: SourceOperation[] = composeSourceEdits(generations).map((edit, i) => ({ key: `edit-${index}-${i}`, kind: "editSource",
        source: { material: { kind: "basis", path: first.path, object: first.object }, range: [edit.offset, edit.offset + edit.length] }, text: edit.replacement }));
      if (operations.length) result.push({ before, after, operations }); else result.push(...frames.slice(index, end));
    }
    index = end;
  }
  return result;
}

/** Whether a plain frame's operations take the source at its `before` root to
 * the source at its `after` root; frames of other kinds pass. */
function reproduces(frame: SourceFrame, sourcePath: string, sources: ReadonlyMap<string, string>): boolean {
  const plain = plainEdits(frame);
  if (!plain || plain.path !== sourcePath) return true;
  const before = sources.get(frame.before), after = sources.get(frame.after);
  if (before === undefined || after === undefined) return false;
  try { return applySourceEdits(before, plain.edits) === after; } catch { return false; }
}

/** Page creation is still a snapshot. Its record names the branch it introduced
 * and proves that removing it restores the original graph: a validity check on
 * the record. Undoing a conversion in the editor is a plain source edit. */
export function preparePageCreation(input: {change: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshot; candidate: TreeSnapshot; creation: SourcePageCreation}): SourceAdmissionRecord {
  const {change,tree,basis,graph,candidate,creation} = input;
  if (creation.document.tree !== tree) throw Error("Invalid creation scope");
  const removed = prepareEntryActions(candidate,{transfers:[],removals:creation.removals},{change});
  if (removed.candidate.root !== graph.root) throw Error("Creation does not reproduce original graph");
  verifyTreeSnapshotGraph(graph,"sparse-files"); verifyTreeSnapshotGraph(candidate,"sparse-files");
  const update = encodeCandidateUpdateJSON({change,candidate:candidate.root,trace:null,resolves:[],deltas:[],objects:[...candidate.objects].filter(([hash])=>!graph.objects.has(hash)).sort(([a],[b])=>a.localeCompare(b)).map(([hash,bytes])=>({hash,bytes}))});
  return {change,tree,basis,graph:snapshotJSON(graph),candidate:snapshotJSON(candidate),sourcePath:null,document:null,creation:{document:{...creation.document},removals:[...creation.removals]},update};
}
export function prepareEntryAdmission(input: {
  change?: string; tree: string; basis: SourceAdmissionBasis; graph: TreeSnapshot; entryTransfer?: EntryTransfer; entryActions?: EntryActions; candidate?: TreeSnapshot;
}): SourceAdmissionRecord {
  const change=input.change ?? crypto.randomUUID();
  if(!!input.entryTransfer === !!input.entryActions)throw Error("Specify one entry intent representation");
  const context={change,candidate:input.candidate};
  const {candidate,operations}=input.entryActions ? prepareEntryActions(input.graph,input.entryActions,context) : prepareEntryTransfer(input.graph,input.entryTransfer!,context);
  if(input.candidate && input.candidate.root!==candidate.root)throw Error("Entry intent does not reproduce candidate");
  const update=encodeCandidateUpdateJSON({change,candidate:candidate.root,trace:operations.length?[{before:input.graph.root,after:candidate.root,operations}]:null,resolves:[],deltas:[],objects:[...candidate.objects].filter(([hash])=>!input.graph.objects.has(hash)).sort(([a],[b])=>a.localeCompare(b)).map(([hash,bytes])=>({hash,bytes}))});
  decodeCandidateUpdateJSON(update);
  return {change,tree:input.tree,basis:input.basis,graph:snapshotJSON(input.graph),sourcePath:null,document:null,...(input.entryActions ? {entryActions:structuredClone(input.entryActions)} : {entryTransfer:structuredClone(input.entryTransfer)}),candidate:snapshotJSON(candidate),update};
}

/** Structural integrity of one record: hash-checked graphs, a wire element
 * naming this candidate and change, update objects drawn from the candidate. */
export function validateSourceAdmission(record: SourceAdmissionRecord): void {
  if (!record.change || record.update.change !== record.change || record.update.candidate !== record.candidate.root) throw new Error("Wire element does not name its record");
  const graph = decodeTreeSnapshotJSON(record.graph), candidate = decodeTreeSnapshotJSON(record.candidate);
  if (new Set(record.graph.objects.map(o => o.hash)).size !== record.graph.objects.length ||
      new Set(record.candidate.objects.map(o => o.hash)).size !== record.candidate.objects.length) throw new Error("Duplicate snapshot object");
  verifyTreeSnapshotGraph(graph, "sparse-files"); verifyTreeSnapshotGraph(candidate, "sparse-files");
  for (const object of decodeCandidateUpdateJSON(record.update).objects) {
    const present = candidate.objects.get(object.hash);
    if (graph.objects.has(object.hash) || !present || !equal([...present], [...object.bytes])) throw new Error("Update object is not a new candidate object");
  }
  if ((record.document === null) !== (record.sourcePath === null)) throw new Error("Incomplete source intent");
  if (record.creation) {
    if (record.creation.document.tree !== record.tree || record.entryActions || record.entryTransfer) throw new Error("Invalid page creation");
    const removed = prepareEntryActions(candidate,{transfers:[],removals:record.creation.removals},{change:record.change});
    if (removed.candidate.root !== graph.root) throw new Error("Creation does not reproduce original graph");
  }
  if (record.entryTransfer && record.entryActions) throw new Error("Multiple entry intent representations");
}

export function validateSourceAdmissions(records: SourceAdmissionRecord[], tree: string): void {
  const prior = new Map<string, SourceAdmissionRecord>();
  for (const record of records) {
    if (record.tree !== tree || prior.has(record.change)) throw new Error("Invalid queue scope or duplicate identity");
    validateSourceAdmission(record);
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
  async retain(value: SourceAdmissionRecord | SourceAdmissionRecord[]): Promise<void> {
    const batch = structuredClone(Array.isArray(value) ? value : [value]);
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const records = await this.retained();
      for (const record of batch) {
        const prior = records.find(r => r.change === record.change);
        if (prior && !equal(prior, record)) throw new Error("Authored identity was reused");
        if (!prior) records.push(record);
      }
      // Repeat the durable write on an exact retry: an earlier rename may have
      // succeeded before directory synchronization failed.
      validateSourceAdmissions(records, this.tree);
      await this.write(records);
    });
    writers.set(this.path, next);
    try { await next; } finally { if (writers.get(this.path) === next) writers.delete(this.path); }
  }
  /** Remove settled records unless a pending authored descendant still needs
   * them. The newest record per open document and its ancestry stay while the
   * tail is preserved; nothing else survives acceptance. */
  async compact(settled: ReadonlySet<string>, preservingSettledTail = true): Promise<boolean> {
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await this.load();
      const records = this.records!;
      const required = new Set(records.filter(record => !settled.has(record.change)).map(record => record.change));
      if (preservingSettledTail && records.length) {
        required.add(records.at(-1)!.change);
        const documents = new Set<string>();
        for (const record of records.slice().reverse()) if (record.document && !documents.has(record.document.path)) {
          documents.add(record.document.path); required.add(record.change);
        }
      }
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
    const journal = value as Partial<SourceAdmissionJournal>;
    if (journal.schema !== 4 || journal.tree !== this.tree || !Array.isArray(journal.records)) throw new Error("Invalid source admission journal");
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

  private async write(records: SourceAdmissionRecord[]): Promise<void> {
    const snapshots = records.flatMap(record => [decodeTreeSnapshotJSON(record.graph), decodeTreeSnapshotJSON(record.candidate)]);
    const presented = new Map<string, Uint8Array>();
    for (const snapshot of snapshots) for (const [hash, bytes] of snapshot.objects) {
      if (!this.platform) presented.set(hash, bytes);
      this.objects.set(hash, bytes);
    }
    // Update envelopes are exactly the objects introduced relative to each
    // graph. They remain queue-owned until the admission settles.
    for (const record of records) for (const object of decodeCandidateUpdateJSON(record.update).objects) {
      presented.set(object.hash, object.bytes);
    }
    await mkdir(this.objectsPath, { recursive: true, mode: 0o700 });
    await Promise.all([...presented].map(([hash, bytes]) => this.writeObject(hash, bytes)));
    const journal: SourceAdmissionJournal = { schema: 4, tree: this.tree, records: records.map(record => this.stored(record)) };
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
    return { ...stored, update, graph: snapshot(record.graph), candidate: snapshot(record.candidate) } as SourceAdmissionRecord;
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
