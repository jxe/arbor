import { compareUTF8, compareUTF8Bytes, decodeRollupDescriptor, sha256, type Hash, type RollupDescriptor } from "@arbor/core";
import { decodeCBOR, encodeCanonicalCBOR } from "./cbor.ts";

export type ObjectHash = string;

export interface WireFile {
  type: "file";
  bytes: Uint8Array;
}

export interface WireDirectoryEntry {
  name: string;
  hash?: ObjectHash;
  tree?: string;
  rollup?: RollupDescriptor;
}

export interface WireDirectory {
  type: "directory";
  entries: WireDirectoryEntry[];
}

export function wireEntryObjectHashes(entry: WireDirectoryEntry): ObjectHash[] {
  if (entry.hash) return [entry.hash];
  if (entry.rollup) return [entry.rollup.source, entry.rollup.schemaSource];
  return [];
}

export type WireObject = WireFile | WireDirectory;

export interface ResolvedWireLogicalNode {
  object: WireObject;
  objectName: string;
  body?: WireFile;
  bodyOrigin?: "sibling" | "index";
  duplicateBody: boolean;
}

export interface TreeSnapshot {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
}

export function hashObject(bytes: Uint8Array): ObjectHash {
  return `sha256:${sha256(bytes)}`;
}

export function encodeWireObject(object: WireObject): Uint8Array {
  return encodeCanonicalCBOR(object);
}

export function decodeWireObject(
  bytes: Uint8Array,
  options: { allowLegacyDirectoryOrder?: boolean } = {},
): WireObject {
  const value = decodeCBOR(bytes);
  if (!value || typeof value !== "object") throw new Error("Wire object must be a map");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === "file" && record.bytes instanceof Uint8Array && keys.length === 2 && keys.includes("type") && keys.includes("bytes")) {
    return { type: "file", bytes: record.bytes };
  }
  if (record.type === "directory" && Array.isArray(record.entries) && keys.length === 2 && keys.includes("type") && keys.includes("entries")) {
    let previousName: Uint8Array | undefined;
    const names = new Set<string>();
    const entries = record.entries.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid directory entry");
      const item = entry as Record<string, unknown>;
      const itemKeys = Object.keys(item);
      if (
        typeof item.name !== "string"
        || item.name.length === 0
        || item.name === "."
        || item.name === ".."
        || /[\\/\0]/.test(item.name)
        || (typeof item.hash !== "string" && typeof item.tree !== "string" && item.rollup === undefined)
        || [item.hash, item.tree, item.rollup].filter((target) => target !== undefined).length !== 1
        || itemKeys.length !== 2
      ) throw new Error("Invalid directory entry");
      if (typeof item.hash === "string" && !/^sha256:[a-f0-9]{64}$/.test(item.hash)) throw new Error("Invalid directory entry hash");
      if (typeof item.tree === "string" && item.tree.length === 0) throw new Error("Invalid directory entry tree");
      const rollup = item.rollup === undefined ? undefined : decodeRollupDescriptor(item.rollup);
      if (names.has(item.name)) throw new Error("Duplicate directory entry name");
      names.add(item.name);
      const encodedName = new TextEncoder().encode(item.name);
      if (
        !options.allowLegacyDirectoryOrder
        && previousName
        && compareUTF8Bytes(previousName, encodedName) >= 0
      ) throw new Error("Directory entries are not in UTF-8 order");
      previousName = encodedName;
      return {
        name: item.name,
        ...(typeof item.hash === "string" ? { hash: item.hash } : {}),
        ...(typeof item.tree === "string" ? { tree: item.tree } : {}),
        ...(rollup ? { rollup } : {}),
      };
    });
    return { type: "directory", entries };
  }
  throw new Error("Unknown wire object");
}

export function compareWireNames(left: string, right: string): number {
  return compareUTF8(left, right);
}

async function loadWireObject(
  hash: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<WireObject> {
  const bytes = await load(hash);
  if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
  return decodeWireObject(bytes);
}

async function directoryBody(
  directory: WireDirectory,
  sibling: WireDirectoryEntry | undefined,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<Pick<ResolvedWireLogicalNode, "body" | "bodyOrigin" | "duplicateBody">> {
  const index = directory.entries.find((entry) => entry.name === "_index.md" && entry.hash);
  const [siblingObject, indexObject] = await Promise.all([
    sibling?.hash ? loadWireObject(sibling.hash, load) : null,
    index?.hash ? loadWireObject(index.hash, load) : null,
  ]);
  if (siblingObject && siblingObject.type !== "file") throw new Error("Sibling Markdown body must be a file");
  if (indexObject && indexObject.type !== "file") throw new Error("Directory _index.md body must be a file");
  if (siblingObject?.type === "file") {
    return {
      body: siblingObject,
      bodyOrigin: "sibling",
      duplicateBody: indexObject?.type === "file",
    };
  }
  if (indexObject?.type === "file") {
    return { body: indexObject, bodyOrigin: "index", duplicateBody: false };
  }
  return { duplicateBody: false };
}

/**
 * Resolve an extensionless logical path over the physical wire graph. A
 * sibling `x.md` supplies `/x`'s body while `x/` supplies its children, with
 * `x/_index.md` as fallback exactly as in the filesystem driver.
 */
export async function resolveWireLogicalNode(
  root: ObjectHash,
  path: string,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<ResolvedWireLogicalNode | null> {
  const parts = path.split("/").filter(Boolean);
  let object = await loadWireObject(root, load);
  if (!parts.length) {
    if (object.type !== "directory") return { object, objectName: "", duplicateBody: false };
    return { object, objectName: "", ...await directoryBody(object, undefined, load) };
  }

  for (const [index, part] of parts.entries()) {
    if (object.type !== "directory") return null;
    const exact = object.entries.find((entry) => entry.name === part);
    const sibling = object.entries.find((entry) => entry.name === `${part}.md`);
    const last = index === parts.length - 1;

    if (exact?.tree) return null;
    if (exact?.hash) {
      const next = await loadWireObject(exact.hash, load);
      if (!last) {
        object = next;
        continue;
      }
      if (next.type === "directory") {
        return {
          object: next,
          objectName: exact.name,
          ...await directoryBody(next, sibling, load),
        };
      }
      return { object: next, objectName: exact.name, duplicateBody: false };
    }

    if (!last || !sibling?.hash) return null;
    const markdown = await loadWireObject(sibling.hash, load);
    if (markdown.type !== "file") return null;
    return { object: markdown, objectName: sibling.name, duplicateBody: false };
  }
  return null;
}
