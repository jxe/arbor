import { compareUTF8, compareUTF8Bytes, decodeCBOR, decodeCollectionFileDescriptor, encodeCanonicalCBOR, sha256, type CollectionFileDescriptor } from "./index.ts";

export type ObjectHash = string;

export type WireEntryKind = "file" | "directory";
export type WireDirectoryEntry =
  | { name: string; file: ObjectHash; directory?: never; tree?: never }
  | { name: string; directory: ObjectHash; file?: never; tree?: never }
  | { name: string; tree: string; file?: never; directory?: never };

export interface WireDirectory {
  type: "directory";
  entries: WireDirectoryEntry[];
  childrenSource?: CollectionFileDescriptor;
}

export function wireEntryObject(entry: WireDirectoryEntry): { kind: WireEntryKind; hash: ObjectHash } | undefined {
  if (entry.file !== undefined) return { kind: "file", hash: entry.file };
  if (entry.directory !== undefined) return { kind: "directory", hash: entry.directory };
  return undefined;
}

export type ResolvedWireLogicalNode = (
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "directory"; directory: WireDirectory }
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
export interface WireObjectSource {
  hash: ObjectHash;
  bytes(): Promise<Uint8Array>;
}

/** A tree graph whose object bytes are loaded through `WireObjectSource`. */
export interface LazyTreeSnapshot {
  root: ObjectHash;
  objects: Map<ObjectHash, WireObjectSource>;
}

export function hashObject(bytes: Uint8Array): ObjectHash {
  return `sha256:${sha256(bytes)}`;
}

export function encodeWireDirectory(directory: WireDirectory): Uint8Array {
  const bytes = encodeCanonicalCBOR(directory);
  decodeWireDirectory(bytes);
  return bytes;
}

export function decodeWireDirectory(bytes: Uint8Array): WireDirectory {
  const value = decodeCBOR(bytes);
  if (!value || typeof value !== "object") throw new Error("Wire object must be a map");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === "directory" && Array.isArray(record.entries)
    && (keys.length === 2 || keys.length === 3)
    && keys.includes("type") && keys.includes("entries")
    && keys.every((key) => key === "type" || key === "entries" || key === "childrenSource")) {
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
        || (typeof item.file !== "string" && typeof item.directory !== "string" && typeof item.tree !== "string")
        || [item.file, item.directory, item.tree].filter((target) => target !== undefined).length !== 1
        || itemKeys.length !== 2
      ) throw new Error("Invalid directory entry");
      for (const hash of [item.file, item.directory]) {
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
        ...(typeof item.directory === "string" ? { directory: item.directory } : {}),
        ...(typeof item.tree === "string" ? { tree: item.tree } : {}),
      } as WireDirectoryEntry;
    });
    const childrenSource = record.childrenSource === undefined
      ? undefined
      : decodeCollectionFileDescriptor(record.childrenSource);
    if (childrenSource) {
      const source = entries.find((entry) => entry.name === childrenSource.source);
      const schema = entries.find((entry) => entry.name === childrenSource.schemaSource);
      if (!source?.file || !schema?.file) throw new Error("Collection-file sources must be ordinary file entries");
      const allowed = new Set([childrenSource.source, childrenSource.schemaSource, "_index.md"]);
      if (entries.some((entry) => !allowed.has(entry.name))) {
        throw new Error("Collection-file directory mixes immediate-child backings");
      }
    }
    const directory: WireDirectory = { type: "directory", entries, ...(childrenSource ? { childrenSource } : {}) };
    const canonical = encodeCanonicalCBOR(directory);
    if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) throw new Error("Directory object is not canonical CBOR");
    return directory;
  }
  throw new Error("Unknown wire object");
}

export function compareWireNames(left: string, right: string): number {
  return compareUTF8(left, right);
}

async function loadVerified(hash: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<Uint8Array> {
  const bytes = await load(hash);
  if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
  return bytes;
}

async function directoryBody(directory: WireDirectory, sibling: WireDirectoryEntry | undefined, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<Pick<ResolvedWireLogicalNode, "body" | "bodyOrigin" | "shadowedBody">> {
  const index = directory.entries.find((entry) => entry.name === "_index.md");
  if (index && !index.file) throw new Error("Directory _index.md body must be a file");
  if (sibling && !sibling.file) throw new Error("Sibling Markdown body must be a file");
  if (index?.file) return { body: await loadVerified(index.file, load), bodyOrigin: "index", shadowedBody: !!sibling?.file };
  if (sibling?.file) return { body: await loadVerified(sibling.file, load), bodyOrigin: "sibling", shadowedBody: false };
  return { shadowedBody: false };
}

/** Resolve an extensionless logical path; _index.md takes precedence over a sibling body. */
export async function resolveWireLogicalNode(root: ObjectHash, path: string, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<ResolvedWireLogicalNode | null> {
  const parts = path.split("/").filter(Boolean);
  let directory = decodeWireDirectory(await loadVerified(root, load));
  if (!parts.length) return { kind: "directory", directory, objectName: "", ...await directoryBody(directory, undefined, load) };
  for (const [index, part] of parts.entries()) {
    if (part === directory.childrenSource?.source || part === directory.childrenSource?.schemaSource) return null;
    const exact = directory.entries.find((entry) => entry.name === part);
    const sibling = directory.entries.find((entry) => entry.name === `${part}.md`);
    const last = index === parts.length - 1;
    if (exact?.tree) return null;
    if (exact?.directory) {
      directory = decodeWireDirectory(await loadVerified(exact.directory, load));
      if (last) return { kind: "directory", directory, objectName: exact.name, ...await directoryBody(directory, sibling, load) };
    } else if (exact?.file) {
      return last ? { kind: "file", bytes: await loadVerified(exact.file, load), objectName: exact.name, shadowedBody: false } : null;
    } else {
      return last && sibling?.file ? { kind: "file", bytes: await loadVerified(sibling.file, load), objectName: sibling.name, shadowedBody: false } : null;
    }
  }
  return null;
}
