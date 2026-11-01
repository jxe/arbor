/** The provenance index (Performance 004): for an accepted root, which node
 * each path is and which operation inserted each run of each text file's
 * bytes. overstoryd computes it for every fast-forward with this module, and
 * the merge engine computes its piece edits with the same functions, so there
 * is one implementation of piece semantics.
 *
 * A piece names only identity: the `origin` that inserted its bytes and where
 * they start within that origin. The bytes themselves are the file's at that
 * root, in piece order, so the index never names an object of its own.
 *
 * Identities, all opaque strings to readers:
 * - an imported node or its bytes: the importing root's node id, then
 *   `/` and the URI-encoded name of each entry down to it;
 * - an operation's node or bytes: `keyOf(change, operation)`, the JSON array
 *   `["<change>","<operation key>"]`; an added directory's descendants
 *   continue it as imported nodes do;
 * - a snapshot's replaced bytes and new nodes: `snapshot:<change>:/<path>`.
 */
import { decodeProtocolDirectory, hashObject, type ObjectHash } from "../objects.ts";
import { decodeProtocolPage } from "../pages.ts";
import type { AuthoredOperation, MaterialRef } from "./authored-contract.ts";

export const PROVENANCE_VERSION = 1;

export interface ProvenancePiece { origin: string; start: number; length: number }
export type ProvenanceNode =
  | { kind: "file" | "page"; node: string; pieces: ProvenancePiece[] }
  | { kind: "directory"; node: string; entries: Record<string, ProvenanceNode> }
  | { kind: "tree"; node: string };

/** An operation's identity, as origins and added nodes name it. */
export const operationIdentity = (change: string, operation: string) => JSON.stringify([change, operation]);

export class ProvenanceRefusal extends Error {}
const refuse = (message: string): never => { throw new ProvenanceRefusal(message); };

// ---- Piece lists ----------------------------------------------------------

export const piecesLength = (pieces: readonly ProvenancePiece[]) => pieces.reduce((n, p) => n + p.length, 0);

export function slicePieces(pieces: readonly ProvenancePiece[], start: number, end: number): ProvenancePiece[] {
  const out: ProvenancePiece[] = [];
  let offset = 0;
  for (const p of pieces) {
    const a = Math.max(0, start - offset), b = Math.min(p.length, end - offset);
    if (b > a) out.push({ origin: p.origin, start: p.start + a, length: b - a });
    offset += p.length;
  }
  return out;
}

/** Adjacent pieces that continue one origin merge; empty pieces go. The
 * canonical form: two piece lists name the same bytes exactly when their
 * normal forms are equal. */
export function normalizePieces(pieces: readonly ProvenancePiece[]): ProvenancePiece[] {
  const out: ProvenancePiece[] = [];
  for (const p of pieces) {
    if (!p.length) continue;
    const prior = out.at(-1);
    if (prior && prior.origin === p.origin && prior.start + prior.length === p.start) prior.length += p.length;
    else out.push({ origin: p.origin, start: p.start, length: p.length });
  }
  return out;
}

export const replacePieces = (pieces: readonly ProvenancePiece[], start: number, end: number, inserted: readonly ProvenancePiece[] = []) =>
  normalizePieces([...slicePieces(pieces, 0, start), ...inserted, ...slicePieces(pieces, end, piecesLength(pieces))]);

const intersect = (a: ProvenancePiece, b: ProvenancePiece): [number, number] | undefined => {
  if (a.origin !== b.origin) return undefined;
  const from = Math.max(a.start, b.start), to = Math.min(a.start + a.length, b.start + b.length);
  return to > from ? [from, to] : undefined;
};

/** Where `range` of `observed` is now in `current`, by identity, never by
 * equal bytes. A nonempty range must be present whole and contiguous. An
 * empty range is an insertion point: just after the byte before it, or else
 * just before the byte after it. */
export function locatePieces(current: readonly ProvenancePiece[], observed: readonly ProvenancePiece[], range: [number, number]): [number, number] {
  const selected = slicePieces(observed, ...range);
  if (!observed.length && current.length) refuse("Empty source anchor has concurrent content");
  if (range[0] !== range[1]) {
    const positions: Array<[number, number]> = [];
    let offset = 0, covered = 0;
    for (const p of current) {
      for (const q of selected) {
        const shared = intersect(p, q);
        if (shared) { positions.push([offset + shared[0] - p.start, offset + shared[1] - p.start]); covered += shared[1] - shared[0]; }
      }
      offset += p.length;
    }
    positions.sort((a, b) => a[0] - b[0]);
    if (covered !== piecesLength(selected) || !positions.length || positions.at(-1)![1] - positions[0]![0] !== covered)
      refuse("Selected material was changed or duplicated");
    return [positions[0]![0], positions.at(-1)![1]];
  }
  const left = slicePieces(observed, Math.max(0, range[0] - 1), range[0])[0];
  const right = slicePieces(observed, range[0], Math.min(piecesLength(observed), range[0] + 1))[0];
  let l: number | undefined = left ? undefined : 0, r: number | undefined = right ? undefined : piecesLength(current);
  let offset = 0;
  for (const p of current) {
    if (left && p.origin === left.origin && left.start >= p.start && left.start < p.start + p.length) l = offset + left.start - p.start + 1;
    if (right && p.origin === right.origin && right.start >= p.start && right.start < p.start + p.length) r = offset + right.start - p.start;
    offset += p.length;
  }
  if (!right && left) r = l;
  if (!left && right) l = r;
  if (l === undefined || r === undefined || l > r) refuse("Insertion anchor is unavailable");
  return [r!, r!];
}

// ---- Importing a root ------------------------------------------------------

/** The index of `object` as an import: every node named under `id`, every
 * text file one piece of its own node. */
export async function importProvenance(
  object: ObjectHash, kind: ProvenanceNode["kind"], id: string, load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<ProvenanceNode> {
  if (kind === "tree") return { kind, node: id };
  if (kind === "file" || kind === "page") {
    const bytes = await load(object);
    const size = kind === "page" ? decodeProtocolPage(bytes).body.length : bytes.length;
    return { kind, node: id, pieces: size ? [{ origin: id, start: 0, length: size }] : [] };
  }
  const entries: Record<string, ProvenanceNode> = {};
  for (const entry of decodeProtocolDirectory(await load(object)).entries) {
    const childKind = entry.file ? "file" : entry.page ? "page" : entry.directory ? "directory" : "tree";
    entries[entry.name] = await importProvenance((entry.file ?? entry.page ?? entry.directory ?? entry.tree)!, childKind,
      `${id}/${encodeURIComponent(entry.name)}`, load);
  }
  return { kind: "directory", node: id, entries };
}

// ---- Advancing over a plain frame -----------------------------------------

const clone = (node: ProvenanceNode): ProvenanceNode =>
  node.kind === "directory" ? { ...node, entries: { ...node.entries } } : node.kind === "tree" ? node : { ...node, pieces: [...node.pieces] };

/** A working copy that copies only what it changes. */
class Working {
  root: ProvenanceNode;
  private copied = new Set<ProvenanceNode>();
  constructor(root: ProvenanceNode) { this.root = root; }
  /** The directory at `parts`, copied for editing along the way. */
  private directory(parts: string[]): Extract<ProvenanceNode, { kind: "directory" }> {
    if (!this.copied.has(this.root)) { this.root = clone(this.root); this.copied.add(this.root); }
    let node = this.root;
    for (const part of parts) {
      if (node.kind !== "directory") refuse("Path crosses a file or tree boundary");
      const dir = node as Extract<ProvenanceNode, { kind: "directory" }>;
      let child = dir.entries[part] ?? refuse("Path is absent");
      if (!this.copied.has(child)) { child = clone(child); this.copied.add(child); dir.entries[part] = child; }
      node = child;
    }
    if (node.kind !== "directory") refuse("Path is not a directory");
    return node as Extract<ProvenanceNode, { kind: "directory" }>;
  }
  get(parts: string[]): ProvenanceNode | undefined {
    let node: ProvenanceNode | undefined = this.root;
    for (const part of parts) node = node?.kind === "directory" ? node.entries[part] : undefined;
    return node;
  }
  set(parts: string[], value: ProvenanceNode): void {
    const parent = this.directory(parts.slice(0, -1));
    parent.entries[parts.at(-1)!] = value;
    this.copied.add(value);
  }
  /** Every text file, with its path. */
  *files(node = this.root, path: string[] = []): Generator<[string[], Extract<ProvenanceNode, { pieces: unknown }>]> {
    if (node.kind === "file" || node.kind === "page") yield [path, node];
    else if (node.kind === "directory") for (const [name, child] of Object.entries(node.entries)) yield* this.files(child, [...path, name]);
  }
}

const pathOf = (ref: MaterialRef): string[] => {
  if (ref.material.kind !== "basis") refuse("Only basis material is supported");
  const path = (ref.material as { path: string }).path;
  return [...(path === "/" ? [] : path.slice(1).split("/")), ...(ref.within ?? [])];
};
const textAt = (index: ProvenanceNode, parts: string[]) => {
  let node: ProvenanceNode | undefined = index;
  for (const part of parts) node = node?.kind === "directory" ? node.entries[part] : undefined;
  if (!node || (node.kind !== "file" && node.kind !== "page")) return refuse("Source target is not a text file");
  return node as Extract<ProvenanceNode, { pieces: unknown }>;
};

/** The index after one plain frame (spec 10 §2: `editSource`, `moveSource`
 * and `addEntry` over the frame's basis), from the index of its `before`.
 * Operations apply in order; each states its material over the frame's
 * basis and is found in the current text by identity. `load` reads objects
 * of an added entry. The frame must already be checked (`checkPlainTrace`);
 * anything this cannot place refuses with `ProvenanceRefusal`. */
export async function advanceProvenance(
  basis: ProvenanceNode, operations: readonly AuthoredOperation[], change: string,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<ProvenanceNode> {
  const work = new Working(basis);
  /** The file currently holding `selected`, if it has moved, else the file at `parts`. */
  const holder = (parts: string[], selected: ProvenancePiece[]): string[] => {
    if (!selected.length) return parts;
    const found: string[][] = [];
    for (const [path, file] of work.files())
      if (file.pieces.some((p) => selected.some((q) => intersect(p, q)))) found.push(path);
    if (found.length > 1) refuse("Selection spans multiple current entries");
    return found[0] ?? parts;
  };
  const current = (parts: string[]) => {
    const node = work.get(parts);
    if (!node || (node.kind !== "file" && node.kind !== "page")) return refuse("Source entry was removed");
    return node as Extract<ProvenanceNode, { pieces: unknown }>;
  };
  const setPieces = (parts: string[], pieces: ProvenancePiece[]) => work.set(parts, { ...current(parts), pieces });
  for (const operation of operations) {
    const key = operationIdentity(change, operation.key);
    if (operation.kind === "editSource") {
      const parts = pathOf(operation.source), observed = textAt(basis, parts).pieces;
      const range = operation.source.range ?? [0, piecesLength(observed)];
      const selected = slicePieces(observed, ...range);
      const at = holder(parts, selected), now = current(at).pieces;
      const where = locatePieces(now, observed, range);
      const size = new TextEncoder().encode(operation.text).length;
      let pieces: ProvenancePiece[] = size ? [{ origin: key, start: 0, length: size }] : [];
      if (operation.lineage?.length) {
        const mapped: ProvenancePiece[] = [];
        let cursor = 0;
        for (const lineage of operation.lineage) {
          const source = textAt(basis, pathOf(lineage.source)).pieces;
          const kept = slicePieces(source, ...(lineage.source.range ?? [0, piecesLength(source)]));
          mapped.push(...slicePieces(pieces, cursor, lineage.range[0]), ...kept);
          cursor = lineage.range[1];
        }
        pieces = [...mapped, ...slicePieces(pieces, cursor, size)];
      }
      setPieces(at, replacePieces(now, where[0], where[1], pieces));
    } else if (operation.kind === "moveSource") {
      const parts = pathOf(operation.source), observed = textAt(basis, parts).pieces;
      const range = operation.source.range ?? [0, piecesLength(observed)];
      const selected = slicePieces(observed, ...range);
      const from = holder(parts, selected), source = current(from).pieces;
      const where = locatePieces(source, observed, range);
      const targetParts = pathOf(operation.at), targetObserved = textAt(basis, targetParts).pieces;
      const targetRange = operation.at.range ?? [0, piecesLength(targetObserved)];
      const to = holder(targetParts, slicePieces(targetObserved, ...targetRange));
      const same = to.join("/") === from.join("/");
      const destination = current(to).pieces;
      const anchor = locatePieces(destination, targetObserved, targetRange);
      let at = operation.side === "before" ? anchor[0] : anchor[1];
      const moved = slicePieces(source, ...where);
      if (same && at > where[0] && at < where[1]) refuse("Move destination is inside source");
      const without = replacePieces(source, where[0], where[1]);
      setPieces(from, without);
      if (same && at >= where[1]) at -= where[1] - where[0];
      setPieces(to, replacePieces(same ? without : destination, at, at, moved));
    } else if (operation.kind === "addEntry") {
      const parent = pathOf(operation.destination.parent), name = operation.destination.name;
      const directory = work.get(parent);
      if (directory?.kind !== "directory") refuse("Invalid entry destination");
      if ((directory as Extract<ProvenanceNode, { kind: "directory" }>).entries[name]) refuse("Entry name is taken");
      const value = operation.value;
      const kind = "file" in value ? "file" : "page" in value ? "page" : "directory";
      work.set([...parent, name], await importProvenance(("file" in value ? value.file : "page" in value ? value.page : value.directory) as ObjectHash, kind, key, load));
    } else refuse(`Operation ${operation.kind} is not a plain operation`);
  }
  return work.root;
}

// ---- Rebinding to a snapshot ----------------------------------------------

/** The index of a snapshot `root` accepted onto `previous`'s root (no
 * trace): a node keeps its identity where the same path holds the same
 * kind; a text file whose bytes (a page's body) are unchanged keeps its
 * pieces; anything else is new under `snapshot:<change>:/<path>`. */
export async function rebindProvenance(
  previous: ProvenanceNode, previousRoot: ObjectHash, root: ObjectHash, change: string,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<ProvenanceNode> {
  const fresh = (path: string) => `snapshot:${change}:${path || "/"}`;
  const bytesOf = async (object: ObjectHash, kind: "file" | "page") => kind === "page" ? decodeProtocolPage(await load(object)).body : load(object);
  const visit = async (old: ProvenanceNode | undefined, oldObject: ObjectHash | undefined, object: ObjectHash,
    kind: ProvenanceNode["kind"], path: string): Promise<ProvenanceNode> => {
    const same = old?.kind === kind;
    const node = same ? old!.node : fresh(path);
    if (kind === "tree") return { kind, node };
    if (kind === "file" || kind === "page") {
      const bytes = await bytesOf(object, kind);
      if (same && oldObject && (oldObject === object || Buffer.from(await bytesOf(oldObject, kind)).equals(Buffer.from(bytes))))
        return { kind, node, pieces: (old as { pieces: ProvenancePiece[] }).pieces };
      return { kind, node, pieces: bytes.length ? [{ origin: fresh(path), start: 0, length: bytes.length }] : [] };
    }
    const oldEntries = same && oldObject ? new Map(decodeProtocolDirectory(await load(oldObject)).entries.map((e) => [e.name, e])) : new Map();
    const entries: Record<string, ProvenanceNode> = {};
    for (const entry of decodeProtocolDirectory(await load(object)).entries) {
      const childKind = entry.file ? "file" : entry.page ? "page" : entry.directory ? "directory" : "tree";
      const prior = oldEntries.get(entry.name);
      const priorObject = prior ? (prior.file ?? prior.page ?? prior.directory ?? prior.tree) as ObjectHash : undefined;
      entries[entry.name] = await visit(same ? (old as Extract<ProvenanceNode, { kind: "directory" }>).entries[entry.name] : undefined,
        priorObject, (entry.file ?? entry.page ?? entry.directory ?? entry.tree)! as ObjectHash, childKind, `${path}/${encodeURIComponent(entry.name)}`);
    }
    return { kind: "directory", node, entries };
  };
  return visit(previous, previousRoot, root, "directory", "");
}

// ---- Records ----------------------------------------------------------------

export const PROVENANCE_RECORD_FORMAT = "overstory-provenance-v1";
type Pieces = Array<[string, number, number]>;
export type ProvenanceRecord =
  | { format: typeof PROVENANCE_RECORD_FORMAT; node: string; kind: "directory"; entries: Array<[string, ObjectHash]> }
  | { format: typeof PROVENANCE_RECORD_FORMAT; node: string; kind: "file" | "page"; chunks: ObjectHash[] }
  | { format: typeof PROVENANCE_RECORD_FORMAT; node: string; kind: "tree" }
  | { format: typeof PROVENANCE_RECORD_FORMAT; kind: "pieces"; pieces: Pieces };

const recordEncoder = new TextEncoder(), recordDecoder = new TextDecoder("utf-8", { fatal: true });
/** Canonical JSON: sorted keys, no whitespace. */
const canonicalJSON = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
/** Where a file's piece list is cut into chunks: after each piece whose
 * `sha256(origin + "\0" + start)` begins with five zero bits. */
export function chunkPieces(pieces: readonly ProvenancePiece[]): ProvenancePiece[][] {
  const chunks: ProvenancePiece[][] = [[]];
  for (const p of pieces) {
    chunks.at(-1)!.push(p);
    const digest = hashObject(recordEncoder.encode(`${p.origin}\0${p.start}`));
    if ((parseInt(digest.slice(7, 9), 16) & 0xf8) === 0) chunks.push([]);
  }
  if (!chunks.at(-1)!.length) chunks.pop();
  return chunks;
}

/** Write `index` as records with `put`, returning its root record's hash.
 * `written` remembers nodes already written (an index shares every node its
 * edit did not change), so pass one per writer to write only what changed. */
export function encodeProvenance(
  index: ProvenanceNode, put: (bytes: Uint8Array) => ObjectHash, written: WeakMap<object, ObjectHash> = new WeakMap(),
): ObjectHash {
  const write = (record: ProvenanceRecord) => put(recordEncoder.encode(canonicalJSON(record)));
  const visit = (node: ProvenanceNode): ObjectHash => {
    const known = written.get(node);
    if (known) return known;
    const format = PROVENANCE_RECORD_FORMAT;
    const hash = node.kind === "tree" ? write({ format, node: node.node, kind: "tree" })
      : node.kind === "directory"
      ? write({ format, node: node.node, kind: "directory",
          entries: Object.keys(node.entries).sort(compareUTF8).map((name) => [name, visit(node.entries[name]!)] as [string, ObjectHash]) })
      : write({ format, node: node.node, kind: node.kind,
          chunks: chunkPieces(node.pieces).map((chunk) => write({ format, kind: "pieces", pieces: chunk.map((p) => [p.origin, p.start, p.length]) })) });
    written.set(node, hash);
    return hash;
  };
  return visit(index);
}
const compareUTF8 = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function decodeProvenanceRecord(bytes: Uint8Array): ProvenanceRecord {
  const text = recordDecoder.decode(bytes), value = JSON.parse(text) as ProvenanceRecord;
  if (value?.format !== PROVENANCE_RECORD_FORMAT || canonicalJSON(value) !== text) refuse("Not a canonical provenance record");
  const valid = value.kind === "pieces" ? Array.isArray(value.pieces) && value.pieces.every((p) => Array.isArray(p) && p.length === 3 &&
      typeof p[0] === "string" && Number.isSafeInteger(p[1]) && p[1] >= 0 && Number.isSafeInteger(p[2]) && p[2] > 0)
    : typeof value.node !== "string" ? false
    : value.kind === "tree" ? Object.keys(value).length === 3
    : value.kind === "directory" ? Array.isArray(value.entries) && value.entries.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string")
    : (value.kind === "file" || value.kind === "page") && Array.isArray(value.chunks) && value.chunks.every((c) => typeof c === "string");
  if (!valid) refuse("Invalid provenance record");
  return value;
}

/** Read the whole index whose root record is `hash`. */
export async function readProvenance(hash: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<ProvenanceNode> {
  const record = decodeProvenanceRecord(await load(hash));
  if (record.kind === "pieces") return refuse("A pieces record is not a node");
  if (record.kind === "tree") return { kind: "tree", node: record.node };
  if (record.kind === "directory") {
    const entries: Record<string, ProvenanceNode> = {};
    for (const [name, child] of record.entries) entries[name] = await readProvenance(child, load);
    return { kind: "directory", node: record.node, entries };
  }
  const pieces: ProvenancePiece[] = [];
  for (const chunk of record.chunks) {
    const r = decodeProvenanceRecord(await load(chunk));
    if (r.kind !== "pieces") refuse("A file's chunk is not a pieces record");
    for (const [origin, start, length] of (r as { pieces: Pieces }).pieces) pieces.push({ origin, start, length });
  }
  return { kind: record.kind, node: record.node, pieces: normalizePieces(pieces) };
}
