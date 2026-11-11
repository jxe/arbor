import { compareUTF8, compareUTF8Bytes, decodeCBOR, decodeCollectionReference, decodeProtocolTable, encodeCanonicalCBOR, sha256, type CollectionReference } from "./index.ts";
import { canonicalPageFile, decodeProtocolPage, type ProtocolPage } from "./pages.ts";

export type ObjectHash = string;

export type ProtocolEntryKind = "file" | "page" | "directory";
export type ProtocolDirectoryEntry =
  | { name: string; file: ObjectHash; created: number; modified: number; page?: never; directory?: never; tree?: never }
  | { name: string; page: ObjectHash; created: number; modified: number; file?: never; directory?: never; tree?: never }
  | { name: string; directory: ObjectHash; file?: never; page?: never; tree?: never; created?: never; modified?: never }
  | { name: string; tree: string; file?: never; page?: never; directory?: never; created?: never; modified?: never };
/** A file or page entry. */
export type ProtocolContentEntry = Extract<ProtocolDirectoryEntry, { created: number }>;

export interface ProtocolDirectory {
  type: "directory";
  entries: ProtocolDirectoryEntry[];
  /** The rows of the folder's logical collection (spec 06 §2.1); its `schema.usl` is an entry. */
  collection?: CollectionReference;
}

/**
 * A collection folder's schema file entry (spec 1.4): `schema.vad`, or `schema.usl` in a
 * tree not yet converted from USL. When a folder has both, `schema.vad` is its schema.
 */
export const COLLECTION_SCHEMA_NAMES = ["schema.vad", "schema.usl"] as const;

export function isCollectionSchemaName(name: string): boolean {
  return name === "schema.vad" || name === "schema.usl";
}

/** The name of a folder's schema entry among `names`, if it has one. */
export function collectionSchemaName(names: Iterable<string>): "schema.vad" | "schema.usl" | undefined {
  let found: "schema.vad" | "schema.usl" | undefined;
  for (const name of names) {
    if (name === "schema.vad") return name;
    if (name === "schema.usl") found = name;
  }
  return found;
}

export function protocolEntryObject(entry: ProtocolDirectoryEntry): { kind: ProtocolEntryKind; hash: ObjectHash } | undefined {
  if (entry.file !== undefined) return { kind: "file", hash: entry.file };
  if (entry.page !== undefined) return { kind: "page", hash: entry.page };
  if (entry.directory !== undefined) return { kind: "directory", hash: entry.directory };
  return undefined;
}

/** A file or page entry's object: what a reader of content, rather than of folders, follows. */
export function protocolContentObject(entry: ProtocolDirectoryEntry | undefined): ObjectHash | undefined {
  return entry?.file ?? entry?.page;
}

/** Whether objects of this kind are leaves: content that reaches no other object. */
export function isProtocolContentKind(kind: ProtocolObjectKind): kind is "file" | "page" {
  return kind === "file" || kind === "page";
}

/**
 * The file bytes a content object reads as: a file's own bytes, or the
 * canonical file a page is written as (spec 02 §3). For readers that render
 * or parse Markdown; editing a page goes through its properties and body.
 */
export function protocolContentBytes(kind: "file" | "page", bytes: Uint8Array): Uint8Array {
  return kind === "page" ? canonicalPageFile(decodeProtocolPage(bytes)) : bytes;
}

/** The page an object of `kind` holds, or undefined for a file. */
export function protocolPageOf(kind: "file" | "page", bytes: Uint8Array): ProtocolPage | undefined {
  return kind === "page" ? decodeProtocolPage(bytes) : undefined;
}

/**
 * Whether a tree holds a page entry anywhere below `root` (not across nested
 * trees): a writer whose basis does is in page mode (directory format §3).
 * `memo` keeps each directory's answer by hash, so a later root that shares
 * most directories reads only the ones that changed.
 */
export async function treeHoldsPages(
  root: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  memo: Map<ObjectHash, boolean> = new Map(),
): Promise<boolean> {
  const known = memo.get(root);
  if (known !== undefined) return known;
  const directory = decodeProtocolDirectory(await load(root));
  let holds = directory.entries.some((entry) => entry.page !== undefined);
  for (const entry of directory.entries) {
    if (holds) break;
    if (entry.directory) holds = await treeHoldsPages(entry.directory, load, memo);
  }
  if (memo.size >= 100_000) memo.clear();
  memo.set(root, holds);
  return holds;
}

/** What an object is, which its referrer says: an entry's file, page or directory, or a collection's table or rows chunk. */
export type ProtocolObjectKind = ProtocolEntryKind | "table" | "rows";

/** The objects one directory reaches directly: its entries' objects, then its collection's tables. */
export function protocolDirectoryReferences(directory: ProtocolDirectory): Array<{ kind: ProtocolObjectKind; hash: ObjectHash }> {
  const references: Array<{ kind: ProtocolObjectKind; hash: ObjectHash }> = directory.entries.flatMap((entry) => protocolEntryObject(entry) ?? []);
  for (const { table } of directory.collection?.tables ?? []) references.push({ kind: "table", hash: table });
  return references;
}

/**
 * The objects an object of `kind` reaches directly: a directory's entries and
 * tables, a table's rows chunks. Files and rows reach nothing. Every walk of
 * the object graph follows these edges. A page is a leaf, but it is checked
 * to be a canonical page object here, as a directory or table is.
 */
export function protocolObjectReferences(kind: ProtocolObjectKind, bytes: Uint8Array): Array<{ kind: ProtocolObjectKind; hash: ObjectHash }> {
  if (kind === "directory") return protocolDirectoryReferences(decodeProtocolDirectory(bytes));
  if (kind === "table") return decodeProtocolTable(bytes).chunks.map(({ chunk }) => ({ kind: "rows" as const, hash: chunk }));
  if (kind === "page") decodeProtocolPage(bytes);
  return [];
}

export type ResolvedProtocolLogicalNode = (
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "directory"; directory: ProtocolDirectory }
) & {
  objectName: string;
  body?: Uint8Array;
  bodyOrigin?: "sibling" | "index";
  shadowedBody: boolean;
};

export interface TreeSnapshot {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
}

/**
 * An object whose canonical bytes may not be in memory yet. Directory and
 * Markdown objects resolve from cached bytes; other files may read on demand.
 * The loader must return bytes whose hash equals `hash`.
 */
export interface ProtocolObjectSource {
  hash: ObjectHash;
  bytes(): Promise<Uint8Array>;
}

/** A tree graph whose object bytes are loaded through `ProtocolObjectSource`. */
export interface LazyTreeSnapshot {
  root: ObjectHash;
  objects: Map<ObjectHash, ProtocolObjectSource>;
}

export function hashObject(bytes: Uint8Array): ObjectHash {
  return `sha256:${sha256(bytes)}`;
}

export function encodeProtocolDirectory(directory: ProtocolDirectory): Uint8Array {
  const bytes = encodeCanonicalCBOR(directory);
  decodeProtocolDirectory(bytes);
  return bytes;
}

export function decodeProtocolDirectory(bytes: Uint8Array): ProtocolDirectory {
  return scanDirectory(bytes) ?? decodeDirectoryValue(bytes);
}

const strictUTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The common directory (no collection) read in one forward pass over its
 * bytes: every head minimal, keys in canonical order, names valid, NFC and in
 * UTF-8 order, hashes well formed, nothing trailing. Bytes that pass are
 * exactly the canonical encoding of the result, so nothing is re-encoded to
 * prove it. Anything else, valid or not, returns null and takes the general
 * path, which also gives every refusal its message.
 */
function scanDirectory(b: Uint8Array): ProtocolDirectory | null {
  const n = b.length;
  let o = 0;
  // A text or array head's length at `o`, minimal; -1 for any other head.
  const head = (major: number): number => {
    if (o >= n) return -1;
    const first = b[o]!;
    if (first >> 5 !== major) return -1;
    const extra = first & 31;
    if (extra < 24) { o += 1; return extra; }
    if (extra === 24) { if (o + 2 > n || b[o + 1]! < 24) return -1; o += 2; return b[o - 1]!; }
    if (extra === 25) { if (o + 3 > n) return -1; const v = (b[o + 1]! << 8) | b[o + 2]!; if (v <= 0xff) return -1; o += 3; return v; }
    if (extra === 26) { if (o + 5 > n) return -1; const v = ((b[o + 1]! << 24) >>> 0) + (b[o + 2]! << 16) + (b[o + 3]! << 8) + b[o + 4]!; if (v <= 0xffff) return -1; o += 5; return v; }
    return -1;
  };
  // Whether a text key equal to `key` (ASCII) is at `o`; consumes it if so.
  const key = (text: string): boolean => {
    const at = o;
    if (head(3) !== text.length || o + text.length > n) { o = at; return false; }
    for (let i = 0; i < text.length; i++) if (b[o + i] !== text.charCodeAt(i)) { o = at; return false; }
    o += text.length;
    return true;
  };
  if (b[0] !== 0xa2) return null; // a map of exactly type and entries
  o = 1;
  if (!key("type") || !key("directory") || !key("entries")) return null;
  const count = head(4);
  if (count < 0) return null;
  const entries: ProtocolDirectoryEntry[] = new Array(count);
  let previousAt = -1, previousLength = 0;
  // An unsigned integer head at `o`, minimal and safe; -1 for anything else
  // (a negative time takes the general path).
  const uint = (): number => {
    if (o >= n) return -1;
    const first = b[o]!;
    if (first >> 5 !== 0) return -1;
    const extra = first & 31;
    if (extra < 24) { o += 1; return extra; }
    if (extra === 24) { if (o + 2 > n || b[o + 1]! < 24) return -1; o += 2; return b[o - 1]!; }
    if (extra === 25) { if (o + 3 > n) return -1; const v = (b[o + 1]! << 8) | b[o + 2]!; if (v <= 0xff) return -1; o += 3; return v; }
    if (extra === 26) { if (o + 5 > n) return -1; const v = ((b[o + 1]! << 24) >>> 0) + (b[o + 2]! << 16) + (b[o + 3]! << 8) + b[o + 4]!; if (v <= 0xffff) return -1; o += 5; return v; }
    if (extra === 27) {
      if (o + 9 > n) return -1;
      const high = ((b[o + 1]! << 24) >>> 0) + (b[o + 2]! << 16) + (b[o + 3]! << 8) + b[o + 4]!;
      const low = ((b[o + 5]! << 24) >>> 0) + (b[o + 6]! << 16) + (b[o + 7]! << 8) + b[o + 8]!;
      if (high === 0 || high > 0x1fffff) return -1;
      o += 9; return high * 0x100000000 + low;
    }
    return -1;
  };
  for (let index = 0; index < count; index++) {
    const size = b[o];
    if (size !== 0xa2 && size !== 0xa4) return null;
    o += 1;
    // Keys in canonical order, shorter first: "file" and "page" entries are
    // {file, name, created, modified} and {name, page, created, modified};
    // "directory" and "tree" entries {name, directory} and {name, tree}.
    let kind: "file" | "page" | "directory" | "tree";
    let nameAt: number, nameLength: number, targetAt: number, targetLength: number;
    let created = 0, modified = 0;
    if (key("file")) {
      kind = "file";
      targetLength = head(3); targetAt = o; o += targetLength;
      if (targetLength < 0 || o > n || !key("name")) return null;
      nameLength = head(3); nameAt = o; o += nameLength;
      if (nameLength < 0 || o > n) return null;
    } else if (key("name")) {
      nameLength = head(3); nameAt = o; o += nameLength;
      if (nameLength < 0 || o > n) return null;
      if (key("page")) kind = "page";
      else if (key("tree")) kind = "tree";
      else if (key("directory")) kind = "directory";
      else return null;
      targetLength = head(3); targetAt = o; o += targetLength;
      if (targetLength < 0 || o > n) return null;
    } else return null;
    if ((kind === "file" || kind === "page") !== (size === 0xa4)) return null;
    if (size === 0xa4) {
      if (!key("created") || (created = uint()) < 0 || !key("modified") || (modified = uint()) < 0 || created > modified) return null;
    }
    // Name: non-empty, not . or .., no / \ or NUL, valid UTF-8 in NFC.
    if (nameLength === 0) return null;
    let ascii = true;
    for (let i = nameAt; i < nameAt + nameLength; i++) {
      const c = b[i]!;
      if (c === 0x2f || c === 0x5c || c === 0) return null;
      if (c > 0x7f) ascii = false;
    }
    if (b[nameAt] === 0x2e && (nameLength === 1 || (nameLength === 2 && b[nameAt + 1] === 0x2e))) return null;
    let name: string;
    try { name = strictUTF8.decode(b.subarray(nameAt, nameAt + nameLength)); } catch { return null; }
    if (!ascii && name !== name.normalize("NFC")) return null;
    // Strictly increasing UTF-8 byte order, which also rules out duplicates.
    if (previousAt >= 0) {
      const shared = Math.min(previousLength, nameLength);
      let order = 0;
      for (let i = 0; i < shared && !order; i++) order = b[previousAt + i]! - b[nameAt + i]!;
      if ((order || previousLength - nameLength) >= 0) return null;
    }
    previousAt = nameAt; previousLength = nameLength;
    // Target: sha256:<64 lowercase hex> for an object; any non-empty tree id.
    if (kind === "tree") {
      if (targetLength === 0) return null;
    } else {
      if (targetLength !== 71) return null;
      for (let i = 0; i < 7; i++) if (b[targetAt + i] !== "sha256:".charCodeAt(i)) return null;
      for (let i = targetAt + 7; i < targetAt + 71; i++) {
        const c = b[i]!;
        if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) return null;
      }
    }
    let target: string;
    try { target = strictUTF8.decode(b.subarray(targetAt, targetAt + targetLength)); } catch { return null; }
    entries[index] = kind === "file" ? { name, file: target, created, modified }
      : kind === "page" ? { name, page: target, created, modified }
      : kind === "directory" ? { name, directory: target }
      : { name, tree: target };
  }
  if (o !== n) return null;
  return { type: "directory", entries };
}

/**
 * A file or page entry at `name` holding `object`, with its times stamped as
 * data model §6 says, from the entry that was at its path before (or at its
 * source, for a rename, move or file↔page conversion):
 *
 * - the same object, or `keep` (a rename, move or conversion): its times stay;
 * - a different object: `created` stays, `modified` becomes `at`;
 * - nothing before: both become `at`.
 *
 * `source` is an earlier time a snapshot update takes from where the content
 * came from, such as a file's mtime; it is never allowed past `at`.
 */
export function stampedEntry(
  kind: "file" | "page",
  name: string,
  object: ObjectHash,
  previous: ProtocolDirectoryEntry | undefined,
  at: number,
  options: { keep?: boolean; source?: number } = {},
): ProtocolContentEntry {
  const before = previous && (previous.file !== undefined || previous.page !== undefined) ? previous as ProtocolContentEntry : undefined;
  const target = kind === "file" ? { name, file: object } : { name, page: object };
  if (before && (options.keep || protocolContentObject(before) === object)) {
    return { ...target, created: before.created, modified: before.modified } as ProtocolContentEntry;
  }
  const stamp = options.source !== undefined && isEntryTime(options.source) ? Math.min(options.source, at) : at;
  return { ...target, created: before ? Math.min(before.created, stamp) : stamp, modified: stamp } as ProtocolContentEntry;
}

/** Stamps entries of one directory against the directory that was at its
 * path before (`stampedEntry` for each name). */
export type EntryStamper = (kind: "file" | "page", name: string, object: ObjectHash) => ProtocolContentEntry;
export function directoryStamper(previous: ProtocolDirectory | undefined, at: number): EntryStamper {
  const before = new Map(previous?.entries.map((entry) => [entry.name, entry]));
  return (kind, name, object) => stampedEntry(kind, name, object, before.get(name), at);
}

/**
 * A merged entry's times (data model §6, updates and merging §3.6): `created`
 * is the basis's, or the earlier of the sides' when both created it;
 * `modified` is the later of the sides that changed the entry, or the basis's
 * when neither did. A side changed the entry when it differs from the basis
 * in object or times.
 */
export function mergedEntryTimes(
  base: ProtocolDirectoryEntry | undefined,
  candidate: ProtocolDirectoryEntry | undefined,
  current: ProtocolDirectoryEntry | undefined,
): { created: number; modified: number } | undefined {
  const times = (entry: ProtocolDirectoryEntry | undefined) => entry && entry.created !== undefined ? entry as ProtocolContentEntry : undefined;
  const b = times(base), sides = [times(candidate), times(current)].filter((entry) => entry !== undefined);
  if (!sides.length) return b ? { created: b.created, modified: b.modified } : undefined;
  const changed = sides.filter((entry) => !b || protocolContentObject(entry) !== protocolContentObject(b) || entry.created !== b.created || entry.modified !== b.modified);
  const created = b ? b.created : Math.min(...sides.map((entry) => entry.created));
  const modified = changed.length ? Math.max(...changed.map((entry) => entry.modified)) : b!.modified;
  return { created: Math.min(created, modified), modified };
}

/**
 * A copy of a directory subtree as entries created at `at` (a copied entry is
 * a new entry, data model §6): every file and page entry below `hash` takes
 * `at` for both times, and the rewritten directories go into `objects`.
 * Nested tree entries are left as they are. Returns the new directory hash.
 */
export function restampedSubtree(hash: ObjectHash, at: number, objects: Map<ObjectHash, Uint8Array>): ObjectHash {
  const bytes = objects.get(hash);
  if (!bytes) throw new Error(`Missing directory ${hash}`);
  const directory = decodeProtocolDirectory(bytes);
  const entries = directory.entries.map((entry): ProtocolDirectoryEntry => {
    if (entry.directory) return { name: entry.name, directory: restampedSubtree(entry.directory, at, objects) };
    if (entry.file !== undefined || entry.page !== undefined) return { ...entry, created: at, modified: at } as ProtocolContentEntry;
    return entry;
  });
  const next = encodeProtocolDirectory({ ...directory, entries });
  const result = hashObject(next);
  objects.set(result, next);
  return result;
}

/** An entry without its times: what it names, for comparing content. */
export function untimedEntry(entry: ProtocolDirectoryEntry): Omit<ProtocolDirectoryEntry, "created" | "modified"> {
  const { created: _created, modified: _modified, ...rest } = entry;
  return rest;
}

/** Whether two roots hold the same content, entry times aside. */
export async function sameUntimed(left: ObjectHash, right: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<boolean> {
  if (left === right) return true;
  const [a, b] = [decodeProtocolDirectory(await load(left)), decodeProtocolDirectory(await load(right))];
  if (JSON.stringify(a.collection ?? null) !== JSON.stringify(b.collection ?? null) || a.entries.length !== b.entries.length) return false;
  for (const [index, entry] of a.entries.entries()) {
    const other = b.entries[index]!;
    if (entry.directory !== undefined && other.directory !== undefined) {
      if (entry.name !== other.name || !(await sameUntimed(entry.directory, other.directory, load))) return false;
    } else if (JSON.stringify(untimedEntry(entry)) !== JSON.stringify(untimedEntry(other))) return false;
  }
  return true;
}

/** An update's `at` (RFC 3339 UTC) as entry-time milliseconds. */
export function entryTimeOf(at: string): number {
  const ms = Date.parse(at);
  if (!isEntryTime(ms)) throw new Error(`Invalid update time: ${at}`);
  return ms;
}

/** Whether `value` can be an entry time: a safe integer of Unix milliseconds. */
export function isEntryTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** The general decoder: any directory, with a message for every refusal. Exported for differential tests. */
export function decodeDirectoryValue(bytes: Uint8Array): ProtocolDirectory {
  const value = decodeCBOR(bytes);
  if (!value || typeof value !== "object") throw new Error("Wire object must be a map");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === "directory" && Array.isArray(record.entries)
    && (keys.length === 2 || keys.length === 3)
    && keys.includes("type") && keys.includes("entries")
    && keys.every((key) => key === "type" || key === "entries" || key === "collection")) {
    let previousName: Uint8Array | undefined;
    const names = new Set<string>();
    const entries = record.entries.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid directory entry");
      const item = entry as Record<string, unknown>;
      const itemKeys = Object.keys(item);
      if (
        typeof item.name !== "string"
        || item.name.length === 0
        || item.name !== item.name.normalize("NFC")
        || item.name === "."
        || item.name === ".."
        || /[\\/\0]/.test(item.name)
        || (typeof item.file !== "string" && typeof item.page !== "string" && typeof item.directory !== "string" && typeof item.tree !== "string")
        || [item.file, item.page, item.directory, item.tree].filter((target) => target !== undefined).length !== 1
        || itemKeys.length !== (item.file !== undefined || item.page !== undefined ? 4 : 2)
      ) throw new Error("Invalid directory entry");
      const content = item.file !== undefined || item.page !== undefined;
      if (content && !(isEntryTime(item.created) && isEntryTime(item.modified) && item.created <= item.modified)) {
        throw new Error("Invalid directory entry times");
      }
      for (const hash of [item.file, item.page, item.directory]) {
        if (hash !== undefined && (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid directory entry hash");
      }
      if (typeof item.tree === "string" && item.tree.length === 0) throw new Error("Invalid directory entry tree");
      if (names.has(item.name)) throw new Error("Duplicate directory entry name");
      names.add(item.name);
      const encodedName = new TextEncoder().encode(item.name);
      if (previousName && compareUTF8Bytes(previousName, encodedName) >= 0) {
        throw new Error("Directory entries are not in UTF-8 order");
      }
      previousName = encodedName;
      return {
        name: item.name,
        ...(typeof item.file === "string" ? { file: item.file } : {}),
        ...(typeof item.page === "string" ? { page: item.page } : {}),
        ...(typeof item.directory === "string" ? { directory: item.directory } : {}),
        ...(typeof item.tree === "string" ? { tree: item.tree } : {}),
        ...(content ? { created: item.created, modified: item.modified } : {}),
      } as ProtocolDirectoryEntry;
    });
    const collection = record.collection === undefined ? undefined : decodeCollectionReference(record.collection);
    const schemaName = collectionSchemaName(entries.map((entry) => entry.name));
    if (collection && !entries.find((entry) => entry.name === schemaName)?.file) throw new Error("A collection's schema.vad must be a file entry");
    const directory: ProtocolDirectory = { type: "directory", entries, ...(collection ? { collection } : {}) };
    const canonical = encodeCanonicalCBOR(directory);
    if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) throw new Error("Directory object is not canonical CBOR");
    return directory;
  }
  throw new Error("Unknown wire object");
}

export function compareProtocolNames(left: string, right: string): number {
  return compareUTF8(left, right);
}

async function loadVerified(hash: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<Uint8Array> {
  const bytes = await load(hash);
  if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
  return bytes;
}

/** A file or page entry's bytes as a file: a page reads as its canonical file. */
/** A file or page entry's file bytes, its object checked against its hash: a
 * page reads as its canonical file (`protocolContentBytes`). */
export async function loadProtocolContent(entry: ProtocolDirectoryEntry, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<Uint8Array> {
  if (entry.page) return protocolContentBytes("page", await loadVerified(entry.page, load));
  return loadVerified(entry.file!, load);
}

async function directoryBody(directory: ProtocolDirectory, sibling: ProtocolDirectoryEntry | undefined, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<Pick<ResolvedProtocolLogicalNode, "body" | "bodyOrigin" | "shadowedBody">> {
  const index = directory.entries.find((entry) => entry.name === "_index.md");
  const content = (entry: ProtocolDirectoryEntry | undefined) => !!protocolContentObject(entry);
  if (index && !content(index)) throw new Error("Directory _index.md body must be a file or page");
  if (sibling && !content(sibling)) throw new Error("Sibling Markdown body must be a file or page");
  if (index) return { body: await loadProtocolContent(index, load), bodyOrigin: "index", shadowedBody: !!sibling };
  if (sibling) return { body: await loadProtocolContent(sibling, load), bodyOrigin: "sibling", shadowedBody: false };
  return { shadowedBody: false };
}

/** Resolve an extensionless logical path; _index.md takes precedence over a sibling body. */
export async function resolveProtocolLogicalNode(root: ObjectHash, path: string, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<ResolvedProtocolLogicalNode | null> {
  const parts = path.split("/").filter(Boolean);
  let directory = decodeProtocolDirectory(await loadVerified(root, load));
  if (!parts.length) return { kind: "directory", directory, objectName: "", ...await directoryBody(directory, undefined, load) };
  for (const [index, part] of parts.entries()) {
    const exact = directory.entries.find((entry) => entry.name === part);
    const sibling = directory.entries.find((entry) => entry.name === `${part}.md`);
    const last = index === parts.length - 1;
    if (exact?.tree) return null;
    if (exact?.directory) {
      directory = decodeProtocolDirectory(await loadVerified(exact.directory, load));
      if (last) return { kind: "directory", directory, objectName: exact.name, ...await directoryBody(directory, sibling, load) };
    } else if (exact && protocolContentObject(exact)) {
      return last ? { kind: "file", bytes: await loadProtocolContent(exact, load), objectName: exact.name, shadowedBody: false } : null;
    } else {
      return last && sibling && protocolContentObject(sibling) ? { kind: "file", bytes: await loadProtocolContent(sibling, load), objectName: sibling.name, shadowedBody: false } : null;
    }
  }
  return null;
}
