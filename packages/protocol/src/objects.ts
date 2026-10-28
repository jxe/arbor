import { compareUTF8, compareUTF8Bytes, decodeCBOR, decodeCollectionReference, decodeProtocolTable, encodeCanonicalCBOR, sha256, type CollectionReference } from "./index.ts";
import { canonicalPageFile, decodeProtocolPage, type ProtocolPage } from "./pages.ts";

export type ObjectHash = string;

export type ProtocolEntryKind = "file" | "page" | "directory";
export type ProtocolDirectoryEntry =
  | { name: string; file: ObjectHash; page?: never; directory?: never; tree?: never }
  | { name: string; page: ObjectHash; file?: never; directory?: never; tree?: never }
  | { name: string; directory: ObjectHash; file?: never; page?: never; tree?: never }
  | { name: string; tree: string; file?: never; page?: never; directory?: never };

export interface ProtocolDirectory {
  type: "directory";
  entries: ProtocolDirectoryEntry[];
  /** The rows of the folder's logical collection (spec 06 §2.1); its `schema.usl` is an entry. */
  collection?: CollectionReference;
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
        || itemKeys.length !== 2
      ) throw new Error("Invalid directory entry");
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
      } as ProtocolDirectoryEntry;
    });
    const collection = record.collection === undefined ? undefined : decodeCollectionReference(record.collection);
    if (collection && !entries.find((entry) => entry.name === "schema.usl")?.file) throw new Error("A collection's schema.usl must be a file entry");
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
