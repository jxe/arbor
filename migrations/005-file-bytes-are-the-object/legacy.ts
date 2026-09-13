// Frozen schema-6 codec, used only by the one-time migration.
import { compareUTF8, compareUTF8Bytes, decodeCBOR, decodeCollectionFileDescriptor, encodeCanonicalCBOR, sha256, type CollectionFileDescriptor } from "@arbor/core";

export type ObjectHash = string;

export interface WireFile {
  type: "file";
  bytes: Uint8Array;
}

export interface WireDirectoryEntry {
  name: string;
  hash?: ObjectHash;
  tree?: string;
}

export interface WireDirectory {
  type: "directory";
  entries: WireDirectoryEntry[];
  childrenSource?: CollectionFileDescriptor;
}

export function wireEntryObjectHashes(entry: WireDirectoryEntry): ObjectHash[] {
  if (entry.hash) return [entry.hash];
  return [];
}

export type WireObject = WireFile | WireDirectory;

export interface ResolvedWireLogicalNode {
  object: WireObject;
  objectName: string;
  body?: WireFile;
  bodyOrigin?: "sibling" | "index";
  /** A sibling body exists beside the `_index.md` that supplies this node's content. */
  shadowedBody: boolean;
}

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
  /** The object's kind when the producer knows it without loading the bytes. */
  kind?: "file" | "directory";
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

export function encodeLegacyObject(object: WireObject): Uint8Array {
  return encodeCanonicalCBOR(object);
}

export function decodeLegacyObject(bytes: Uint8Array): WireObject {
  const value = decodeCBOR(bytes);
  if (!value || typeof value !== "object") throw new Error("Wire object must be a map");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === "file" && record.bytes instanceof Uint8Array && keys.length === 2 && keys.includes("type") && keys.includes("bytes")) {
    return { type: "file", bytes: record.bytes };
  }
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
        || (typeof item.hash !== "string" && typeof item.tree !== "string")
        || [item.hash, item.tree].filter((target) => target !== undefined).length !== 1
        || itemKeys.length !== 2
      ) throw new Error("Invalid directory entry");
      if (typeof item.hash === "string" && !/^sha256:[a-f0-9]{64}$/.test(item.hash)) throw new Error("Invalid directory entry hash");
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
        ...(typeof item.hash === "string" ? { hash: item.hash } : {}),
        ...(typeof item.tree === "string" ? { tree: item.tree } : {}),
      };
    });
    const childrenSource = record.childrenSource === undefined
      ? undefined
      : decodeCollectionFileDescriptor(record.childrenSource);
    if (childrenSource) {
      const source = entries.find((entry) => entry.name === childrenSource.source);
      const schema = entries.find((entry) => entry.name === childrenSource.schemaSource);
      if (!source?.hash || !schema?.hash) throw new Error("Collection-file sources must be ordinary file entries");
      const allowed = new Set([childrenSource.source, childrenSource.schemaSource, "_index.md"]);
      if (entries.some((entry) => !allowed.has(entry.name))) {
        throw new Error("Collection-file directory mixes immediate-child backings");
      }
    }
    return { type: "directory", entries, ...(childrenSource ? { childrenSource } : {}) };
  }
  throw new Error("Unknown wire object");
}

export function compareWireNames(left: string, right: string): number {
  return compareUTF8(left, right);
}

