import { compareProtocolNames, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectoryEntry } from "../objects.ts";
import { applyPageOperations, decodeProtocolPage, encodeProtocolPage, type ProtocolPage } from "../pages.ts";
import { isPageOperation, isPropertyOperation, type AuthoredOperation, type MaterialRef, type PageOperation, type RowOperation } from "./authored-contract.ts";
import { arrangeSources, UnsupportedSourceMove, type SourceReplacement } from "./source-moves.ts";

type Edit = Extract<AuthoredOperation, { kind: "editSource" }>;
/** Validated creation coordinates; bind these to (tree, change, operation) on commit. */
export interface SourceEditEvidence {
  operation: string;
  path: string;
  source: { object: ObjectHash; range: [number, number] };
  text: string;
  lineage: Array<{ source: { object: ObjectHash; range: [number, number] }; range: [number, number] }>;
}
export class UnsupportedSourceEdit extends Error {}
/** A selected file's bytes, or a selected page's body (spec 01, Pages). */
interface Selection { path: string; object: ObjectHash; bytes: Uint8Array; range: [number, number]; page?: ProtocolPage }
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function invalid(message: string): never { throw new Error(`Invalid source edit: ${message}`); }
function boundaries(bytes: Uint8Array, range: [number, number]) {
  if (!range.every(Number.isSafeInteger) || range[0] < 0 || range[1] < range[0] || range[1] > bytes.length) invalid("range outside source");
  decoder.decode(bytes); // Binary and malformed UTF-8 are not text selections.
  for (const offset of range) if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) invalid("range splits UTF-8 scalar");
}
function components(path: string): string[] {
  if (!path.startsWith("/")) invalid("path is not absolute");
  const parts = path === "/" ? [] : path.slice(1).split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p) || p.normalize("NFC") !== p)) invalid("invalid path");
  return parts;
}

/** Pure authored-basis execution. Does not accept updates, reconcile peers or write objects.
 * Callers must bind baseRoot to an authorized accepted state of the same tree.
 * This first slice handles basis selections and disjoint edits, not retained outputs.
 */
export async function executeExactSourceEdits(
  baseRoot: ObjectHash,
  operations: readonly AuthoredOperation[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<{ root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; evidence: SourceEditEvidence[] }> {
  const cache = new Map<ObjectHash, Uint8Array>();
  async function read(hash: ObjectHash) {
    const known = cache.get(hash);
    if (known) return known;
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash) invalid("object hash mismatch");
    cache.set(hash, bytes);
    return bytes;
  }
  async function select(ref: MaterialRef): Promise<Selection> {
    if (ref.material.kind !== "basis") throw new UnsupportedSourceEdit("Retained operation and alternative references are not enabled");
    const baseParts = components(ref.material.path);
    const within = ref.within ?? [];
    if (within.length) components("/" + within.join("/"));
    let object = baseRoot, kind: "file" | "page" | "directory" = "directory";
    const parts = [...baseParts, ...within];
    for (let index = 0; index <= parts.length; index++) {
      if (index === baseParts.length && object !== ref.material.object) invalid("basis object does not match path");
      if (index === parts.length) break;
      if (kind !== "directory") invalid("selector descends through a file");
      const entry = decodeProtocolDirectory(await read(object)).entries.find(e => e.name === parts[index]);
      if (!entry) invalid("path absent from basis");
      if (entry.tree) invalid("selection crosses tree boundary");
      object = (entry.file ?? entry.page ?? entry.directory)!;
      kind = entry.file ? "file" : entry.page ? "page" : "directory";
    }
    if (kind === "directory") invalid("source selection is not a file");
    const page = kind === "page" ? decodeProtocolPage(await read(object)) : undefined;
    const bytes = page?.body ?? await read(object);
    const range: [number, number] = ref.range ?? [0, bytes.length];
    boundaries(bytes, range);
    return { path: "/" + parts.join("/"), object, bytes, range, page };
  }
  const groups = new Map<string, Array<{ selected: Selection; text: Uint8Array; index: number }>>();
  const evidence: SourceEditEvidence[] = [];
  const keys = new Set<string>();
  // Moves precede every edit in a frame this executes, so each edit is stated
  // over basis material wherever the frame's moves put it.
  const moves: Array<{ source: Selection; anchor: Selection; side: "before" | "after" }> = [];
  for (const operation of operations) {
    if (operation.kind === "moveSource") {
      if (groups.size) throw new UnsupportedSourceEdit("A move after an edit requires causal source execution");
      if (keys.has(operation.key)) invalid("duplicate operation key");
      keys.add(operation.key);
      moves.push({ source: await select(operation.source), anchor: await select(operation.at), side: operation.side });
      continue;
    }
    if (operation.kind !== "editSource") throw new UnsupportedSourceEdit(`Operation ${operation.kind} is not enabled in exact source execution`);
    const edit: Edit = operation;
    if (keys.has(edit.key)) invalid("duplicate operation key");
    keys.add(edit.key);
    const selected = await select(edit.source), text = encoder.encode(edit.text);
    if (decoder.decode(text) !== edit.text) invalid("replacement is not scalar text");
    const lineage: SourceEditEvidence["lineage"] = [];
    let priorEnd = 0, priorSourceEnd = selected.range[0];
    for (const mapping of edit.lineage ?? []) {
      boundaries(text, mapping.range);
      if (mapping.range[0] < priorEnd) invalid("overlapping replacement lineage");
      priorEnd = mapping.range[1];
      const source = await select(mapping.source);
      // An edit can preserve selected material; borrowing another occurrence is
      // copy intent and cannot be smuggled into a preservation claim.
      if (source.path !== selected.path || source.range[0] < selected.range[0] || source.range[1] > selected.range[1]) throw new UnsupportedSourceEdit("Lineage outside the replaced selection requires causal source execution");
      if (!Buffer.from(source.bytes.subarray(...source.range)).equals(Buffer.from(text.subarray(...mapping.range)))) invalid("lineage changes bytes");
      if (source.range[0] < priorSourceEnd) throw new UnsupportedSourceEdit("Reordered or reused lineage requires causal source execution");
      priorSourceEnd = source.range[1];
      lineage.push({ source: { object: source.object, range: source.range }, range: mapping.range });
    }
    const group = groups.get(selected.path) ?? [];
    group.push({ selected, text, index: evidence.length });
    groups.set(selected.path, group);
    evidence.push({ operation: edit.key, path: selected.path, source: { object: selected.object, range: selected.range }, text: edit.text, lineage });
  }
  const files = new Map<string, Uint8Array>(), pages = new Map<string, ProtocolPage>();
  for (const selection of [...moves.flatMap(m => [m.source, m.anchor]), ...[...groups.values()].flat().map(e => e.selected)]) {
    const known = files.get(selection.path);
    if (known && known !== selection.bytes && !Buffer.from(known).equals(Buffer.from(selection.bytes))) invalid("one path names two basis objects");
    files.set(selection.path, selection.bytes);
    if (selection.page) pages.set(selection.path, selection.page);
  }
  const replacements: SourceReplacement[] = [];
  for (const [path, edits] of groups) {
    edits.sort((a, b) => a.selected.range[0] - b.selected.range[0] || a.index - b.index);
    let cursor = 0, priorStart = -1;
    for (const { selected, text } of edits) {
      if (selected.range[0] < cursor || selected.range[0] === priorStart) throw new UnsupportedSourceEdit("Overlapping or same-anchor edits require causal source execution");
      replacements.push({ path, range: selected.range, text });
      priorStart = selected.range[0]; cursor = selected.range[1];
    }
  }
  let arranged: Map<string, Uint8Array>;
  try {
    arranged = arrangeSources(files, moves.map(m => ({ source: { path: m.source.path, range: m.source.range }, anchor: { path: m.anchor.path, range: m.anchor.range }, side: m.side })), replacements);
  } catch (error) {
    if (error instanceof UnsupportedSourceMove) throw new UnsupportedSourceEdit(error.message);
    throw error;
  }
  const generated = new Map<ObjectHash, Uint8Array>();
  const replacementObjects = new Map<string, ObjectHash>();
  for (const [path, arrangedBytes] of arranged) {
    // An edited page keeps its properties; only its body is source text.
    const page = pages.get(path);
    const bytes = page ? encodeProtocolPage({ ...page, body: arrangedBytes }) : arrangedBytes;
    const hash = hashObject(bytes);
    generated.set(hash, bytes); replacementObjects.set(path, hash);
  }
  async function rebuild(hash: ObjectHash, path: string): Promise<ObjectHash> {
    const directory = decodeProtocolDirectory(await read(hash));
    let changed = false;
    for (const entry of directory.entries) {
      const child = path + "/" + entry.name;
      if (![...replacementObjects.keys()].some(p => p === child || p.startsWith(child + "/"))) continue;
      const next = entry.file || entry.page ? replacementObjects.get(child)! : entry.directory ? await rebuild(entry.directory, child) : undefined;
      if (next && next !== (entry.file ?? entry.page ?? entry.directory)) {
        if (entry.file) entry.file = next; else if (entry.page) entry.page = next; else entry.directory = next;
        changed = true;
      }
    }
    if (!changed) return hash;
    const bytes = encodeProtocolDirectory(directory), result = hashObject(bytes);
    generated.set(result, bytes); return result;
  }
  return { root: await rebuild(baseRoot, ""), generated, evidence };
}

/** Verify the complete candidate, including every untouched path and source byte. */
export async function validateSourceEditCandidate(
  baseRoot: ObjectHash,
  candidate: ObjectHash,
  operations: readonly AuthoredOperation[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  rows?: CollectionRowReplay,
): Promise<{ root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; evidence: SourceEditEvidence[] }> {
  const result = operations.some(isPropertyOperation)
    ? { ...await executeRowOperations(baseRoot, operations, load, rows), evidence: [] }
    : await executeExactSourceEdits(baseRoot, operations, load);
  if (result.root !== candidate) invalid("operations do not explain candidate");
  return result;
}

/** One tree-root to tree-root step of authored evidence, as the merge engine
 * sees it. Basis references name objects in this frame's `before` tree. */
export interface SourceFrame {
  before: ObjectHash;
  after: ObjectHash;
  operations: readonly AuthoredOperation[];
}

/** Validate a chain of frames. Each frame must follow its predecessor's result
 * and must reproduce its own `after` exactly; objects a frame generates are
 * available to the frames that follow it. Operation keys stay unique across the
 * whole trace, because they name contributions of one change. */
export async function validateSourceTrace(
  frames: readonly SourceFrame[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  rows?: CollectionRowReplay,
): Promise<{ root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; evidence: SourceEditEvidence[] }> {
  if (!frames.length) invalid("trace has no frames");
  const generated = new Map<ObjectHash, Uint8Array>();
  const evidence: SourceEditEvidence[] = [];
  const keys = new Set<string>();
  const read = async (hash: ObjectHash) => generated.get(hash) ?? await load(hash);
  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1];
    if (previous && previous.after !== frame.before) invalid("frame does not follow its basis");
    if (!frame.operations.length) invalid("frame carries no operations");
    for (const operation of frame.operations) {
      if (keys.has(operation.key)) invalid("duplicate operation key");
      keys.add(operation.key);
    }
    const result = await validateSourceEditCandidate(frame.before, frame.after, frame.operations, read, rows);
    for (const [hash, bytes] of result.generated) generated.set(hash, bytes);
    evidence.push(...result.evidence);
  }
  return { root: frames.at(-1)!.after, generated, evidence };
}


/** Whether a trace is plain enough for an authority to accept on the current
 * head without a merge: every frame's operations are `moveSource` and then
 * `editSource` over basis material (as `executeExactSourceEdits` executes
 * them) or `addEntry` of a new
 * name into a basis directory, and each frame reproduces its own `after`
 * exactly. `touched` names each edited file and each added entry; the caller
 * decides whether an open decision concerns one. Anything else is a
 * fall-through with its reason, never a rejection. */
export async function checkPlainTrace(
  frames: readonly SourceFrame[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  rows?: CollectionRowReplay,
): Promise<{ plain: true; touched: string[]; generated: Map<ObjectHash, Uint8Array> } | { plain: false; reason: string }> {
  if (!frames.length) return { plain: false, reason: "empty trace" };
  const generated = new Map<ObjectHash, Uint8Array>();
  const read = async (hash: ObjectHash) => generated.get(hash) ?? await load(hash);
  const touched = new Set<string>();
  const keys = new Set<string>();
  try {
    for (const [index, frame] of frames.entries()) {
      if (index && frames[index - 1]!.after !== frame.before) return { plain: false, reason: "frame does not follow its basis" };
      const root = await executePlainFrame(frame.before, frame.operations, read, rows, { keys, touched, generated });
      if (typeof root !== "string") return { plain: false, reason: root.reason };
      if (root !== frame.after) return { plain: false, reason: "operations do not reproduce the frame" };
    }
  } catch (error) {
    return { plain: false, reason: error instanceof Error ? error.message : "invalid trace" };
  }
  return { plain: true, touched: [...touched], generated };
}

/** A frame whose roots may be left out (spec 10 §2). */
export interface DerivableSourceFrame {
  before?: ObjectHash;
  after?: ObjectHash;
  operations: readonly AuthoredOperation[];
}

/** Why an authority cannot derive a trace's omitted roots: an operation its
 * plain executor does not run. Not a rejection of the operations. */
export class UnsupportedDerivation extends Error {}

/** Execute a trace on `basis`, deriving each omitted root and checking each
 * stated one (spec 10 §2.2), with the executor `checkPlainTrace` uses. A stated
 * root the execution does not match, or an operation that does not apply, is
 * invalid; an operation outside that executor is an `UnsupportedDerivation`.
 * Returns the frames with every root stated and the objects they generate. */
export async function deriveTrace(
  basis: ObjectHash,
  frames: readonly DerivableSourceFrame[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  rows?: CollectionRowReplay,
): Promise<{ frames: SourceFrame[]; root: ObjectHash; generated: Map<ObjectHash, Uint8Array> }> {
  if (!frames.length) invalid("trace has no frames");
  const generated = new Map<ObjectHash, Uint8Array>();
  const read = async (hash: ObjectHash) => generated.get(hash) ?? await load(hash);
  const keys = new Set<string>(), touched = new Set<string>();
  const stated: SourceFrame[] = [];
  let root = basis;
  for (const frame of frames) {
    if (frame.before !== undefined && frame.before !== root) invalid("frame does not follow its basis");
    let after: Awaited<ReturnType<typeof executePlainFrame>>;
    try {
      after = await executePlainFrame(root, frame.operations, read, rows, { keys, touched, generated });
    } catch (error) {
      if (error instanceof UnsupportedSourceEdit) throw new UnsupportedDerivation(error.message);
      throw error;
    }
    if (typeof after !== "string") throw new UnsupportedDerivation(`Cannot derive a frame with ${after.reason}`);
    if (frame.after !== undefined && frame.after !== after) invalid("operations do not reproduce the frame");
    stated.push({ before: root, after, operations: frame.operations });
    root = after;
  }
  return { frames: stated, root, generated };
}

/** Execute one frame of plain operations on `before`: row operations, or
 * `moveSource` and `editSource` over basis material and then `addEntry` of new
 * names. Returns the result root, or the reason the frame is not plain.
 * Throws on an operation that does not apply. */
async function executePlainFrame(
  before: ObjectHash,
  operations: readonly AuthoredOperation[],
  read: (hash: ObjectHash) => Promise<Uint8Array>,
  rows: CollectionRowReplay | undefined,
  into: { keys: Set<string>; touched: Set<string>; generated: Map<ObjectHash, Uint8Array> },
): Promise<ObjectHash | { reason: string }> {
  const { keys, touched, generated } = into;
  if (!operations.length) return { reason: "frame carries no operations" };
  if (operations.some(isPropertyOperation)) {
    for (const operation of operations) {
      if (keys.has(operation.key)) return { reason: "duplicate operation key" };
      keys.add(operation.key);
    }
    if (!rows && operations.some((operation) => isPropertyOperation(operation) && !isPageOperation(operation)))
      return { reason: "row operations need a collection replay" };
    const result = await executeRowOperations(before, operations, read, rows);
    for (const [hash, bytes] of result.generated) generated.set(hash, bytes);
    for (const path of result.touched) touched.add(path);
    return result.root;
  }
  const edits: AuthoredOperation[] = [], additions: Array<Extract<AuthoredOperation, { kind: "addEntry" }>> = [];
  for (const operation of operations) {
    if (keys.has(operation.key)) return { reason: "duplicate operation key" };
    keys.add(operation.key);
    if (operation.kind === "editSource") edits.push(operation);
    else if (operation.kind === "moveSource") {
      edits.push(operation);
      for (const ref of [operation.source, operation.at])
        if (ref.material.kind === "basis") touched.add(ref.material.path + (ref.within?.length ? "/" + ref.within.join("/") : ""));
    }
    else if (operation.kind === "addEntry") additions.push(operation);
    else return { reason: `operation ${operation.kind}` };
  }
  let root = before;
  if (edits.length) {
    const result = await executeExactSourceEdits(before, edits, read);
    for (const [hash, bytes] of result.generated) generated.set(hash, bytes);
    for (const evidence of result.evidence) touched.add(evidence.path);
    root = result.root;
  }
  const names = new Set<string>();
  for (const addition of additions) {
    const parent = addition.destination.parent;
    if (parent.material.kind !== "basis" || parent.range) return { reason: "addEntry into non-basis material" };
    const base = components(parent.material.path), within = parent.within ?? [];
    if (within.length) components("/" + within.join("/"));
    // The parent must be the named basis directory in this frame's `before`.
    const parts = [...base, ...within];
    let object = before;
    for (let depth = 0; depth <= parts.length; depth++) {
      if (depth === base.length && object !== parent.material.object) invalid("basis object does not match path");
      if (depth === parts.length) break;
      const entry = decodeProtocolDirectory(await read(object)).entries.find((e) => e.name === parts[depth]);
      if (!entry?.directory) return { reason: "addEntry parent is not a basis directory" };
      object = entry.directory;
    }
    const path = [...base, ...within, addition.destination.name];
    components("/" + path.join("/"));
    const key = path.join("/");
    if (names.has(key)) return { reason: "addEntry names one entry twice" };
    names.add(key);
    const entry = { name: addition.destination.name, ...addition.value } as ProtocolDirectoryEntry;
    const next = await addEntryAt(root, path, entry, read, generated);
    if (!next) return { reason: "addEntry names an existing entry" };
    root = next;
    touched.add("/" + key);
  }
  return root;
}

/** Apply one collection directory's row operations, in order, and return its
 * re-derived directory object (spec 10 §4.1). Protocol does not know a
 * collection's representations, so the collection schema package supplies
 * this; the client and the host use the same one. Throws on an invalid
 * operation. */
export type CollectionRowReplay = (
  directory: ObjectHash,
  operations: readonly RowOperation[],
  read: (hash: ObjectHash) => Promise<Uint8Array>,
) => Promise<{ directory: ObjectHash; generated: Map<ObjectHash, Uint8Array> }>;

/** Execute a frame of property operations against `baseRoot`. Each operation
 * names a basis collection directory or a basis page entry; operations on one
 * target run in order. Each changed collection is re-derived by `replay`, and
 * each changed page is the basis page with its operations applied. A frame
 * that carries property operations carries nothing else. */
export async function executeRowOperations(
  baseRoot: ObjectHash,
  operations: readonly AuthoredOperation[],
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  replay?: CollectionRowReplay,
): Promise<{ root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; touched: string[] }> {
  const generated = new Map<ObjectHash, Uint8Array>();
  const read = async (hash: ObjectHash) => generated.get(hash) ?? await load(hash);
  type Group = { object: ObjectHash; parts: string[] } & ({ page: false; operations: RowOperation[] } | { page: true; operations: PageOperation[] });
  const groups = new Map<string, Group>();
  const keys = new Set<string>();
  for (const operation of operations) {
    if (!isPropertyOperation(operation)) invalid("a frame with property operations carries only property operations");
    if (keys.has(operation.key)) invalid("duplicate operation key");
    keys.add(operation.key);
    const page = isPageOperation(operation);
    if (!page && !replay) throw new UnsupportedSourceEdit("Row operations need a collection replay");
    const ref = page ? operation.page : (operation as RowOperation).collection;
    if (ref.material.kind !== "basis") throw new UnsupportedSourceEdit("Property operations name basis entries");
    if (ref.range) invalid("a property target is never ranged");
    const base = components(ref.material.path), within = ref.within ?? [];
    if (within.length) components("/" + within.join("/"));
    const parts = [...base, ...within], path = "/" + parts.join("/");
    let group = groups.get(path);
    if (!group) {
      let object = baseRoot;
      for (let depth = 0; depth <= parts.length; depth++) {
        if (depth === base.length && object !== ref.material.object) invalid("basis object does not match path");
        if (depth === parts.length) break;
        const entry = decodeProtocolDirectory(await read(object)).entries.find((e) => e.name === parts[depth]);
        const last = depth === parts.length - 1;
        if (page && last) {
          if (!entry?.page) invalid("page target is not a basis page");
          object = entry.page;
        } else {
          if (!entry?.directory) invalid(page ? "page target crosses a file or tree boundary" : "collection is not a basis directory");
          object = entry.directory;
        }
      }
      if (page && !parts.length) invalid("page target is not a basis page");
      groups.set(path, group = page ? { object, parts, page, operations: [] } : { object, parts, page, operations: [] });
    } else if (group.page !== page) invalid("one path names a page and a collection");
    else if (base.length === parts.length && group.object !== ref.material.object) invalid("one path names two basis objects");
    (group.operations as unknown[]).push(operation);
  }
  let root = baseRoot;
  for (const group of groups.values()) {
    if (group.page) {
      const page = applyPageOperations(decodeProtocolPage(await read(group.object)), group.operations);
      const bytes = encodeProtocolPage(page), hash = hashObject(bytes);
      generated.set(hash, bytes);
      root = await setPageAt(root, group.parts, hash, read, generated);
      continue;
    }
    const result = await replay!(group.object, group.operations, read);
    for (const [hash, bytes] of result.generated) generated.set(hash, bytes);
    root = await setDirectoryAt(root, group.parts, result.directory, read, generated);
  }
  return { root, generated, touched: [...groups.keys()] };
}

/** Replace the page entry at `path` below `root` with the page `page`. */
async function setPageAt(
  root: ObjectHash,
  path: readonly string[],
  page: ObjectHash,
  read: (hash: ObjectHash) => Promise<Uint8Array>,
  generated: Map<ObjectHash, Uint8Array>,
): Promise<ObjectHash> {
  const parent = decodeProtocolDirectory(await read(root));
  const [name, ...rest] = path as [string, ...string[]];
  const prior = parent.entries.find((e) => e.name === name);
  let next: ProtocolDirectoryEntry;
  if (!rest.length) {
    if (!prior?.page) invalid("page target is not a page");
    if (prior.page === page) return root;
    next = { name, page };
  } else {
    if (!prior?.directory) invalid("page target crosses a file or tree boundary");
    const directory = await setPageAt(prior.directory, rest, page, read, generated);
    if (directory === prior.directory) return root;
    next = { name, directory };
  }
  parent.entries = parent.entries.map((e) => e.name === name ? next : e);
  const bytes = encodeProtocolDirectory(parent), hash = hashObject(bytes);
  generated.set(hash, bytes);
  return hash;
}

async function setDirectoryAt(
  root: ObjectHash,
  path: readonly string[],
  directory: ObjectHash,
  read: (hash: ObjectHash) => Promise<Uint8Array>,
  generated: Map<ObjectHash, Uint8Array>,
): Promise<ObjectHash> {
  if (!path.length) return directory;
  const parent = decodeProtocolDirectory(await read(root));
  const [name, ...rest] = path as [string, ...string[]];
  const prior = parent.entries.find((e) => e.name === name);
  if (!prior?.directory) invalid("collection is not a directory");
  const next = await setDirectoryAt(prior.directory, rest, directory, read, generated);
  if (next === prior.directory) return root;
  parent.entries = parent.entries.map((e) => e.name === name ? { name, directory: next } : e);
  const bytes = encodeProtocolDirectory(parent), hash = hashObject(bytes);
  generated.set(hash, bytes);
  return hash;
}

/** Add `entry` at `path` below `root`; null when the name is taken. */
async function addEntryAt(
  root: ObjectHash,
  path: readonly string[],
  entry: ProtocolDirectoryEntry,
  read: (hash: ObjectHash) => Promise<Uint8Array>,
  generated: Map<ObjectHash, Uint8Array>,
): Promise<ObjectHash | null> {
  const directory = decodeProtocolDirectory(await read(root));
  const [name, ...rest] = path as [string, ...string[]];
  const prior = directory.entries.find((e) => e.name === name);
  let next: ProtocolDirectoryEntry;
  if (rest.length) {
    if (!prior?.directory) return null;
    const child = await addEntryAt(prior.directory, rest, entry, read, generated);
    if (!child) return null;
    next = { ...prior, directory: child };
  } else {
    if (prior) return null;
    next = entry;
  }
  directory.entries = [...directory.entries.filter((e) => e.name !== name), next].sort((a, b) => compareProtocolNames(a.name, b.name));
  const bytes = encodeProtocolDirectory(directory), hash = hashObject(bytes);
  generated.set(hash, bytes);
  return hash;
}
