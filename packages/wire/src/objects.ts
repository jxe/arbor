import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { sha256 } from "@arbor/core";
import { IGNORED_WORKSPACE_DIRECTORIES } from "@arbor/fs";
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
}

export interface WireDirectory {
  type: "directory";
  entries: WireDirectoryEntry[];
}

export type WireObject = WireFile | WireDirectory;

export interface TreeSnapshot {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
}

export class UnavailableCloudContentError extends Error {
  constructor(readonly path: string) {
    super(`Cloud content is not materialized: ${path}`);
    this.name = "UnavailableCloudContentError";
  }
}

export function hashObject(bytes: Uint8Array): ObjectHash {
  return `sha256:${sha256(bytes)}`;
}

export function encodeWireObject(object: WireObject): Uint8Array {
  return encodeCanonicalCBOR(object);
}

export function decodeWireObject(bytes: Uint8Array): WireObject {
  const value = decodeCBOR(bytes);
  if (!value || typeof value !== "object") throw new Error("Wire object must be a map");
  const record = value as Record<string, unknown>;
  if (record.type === "file" && record.bytes instanceof Uint8Array) {
    return { type: "file", bytes: record.bytes };
  }
  if (record.type === "directory" && Array.isArray(record.entries)) {
    const entries = record.entries.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid directory entry");
      const item = entry as Record<string, unknown>;
      if (
        typeof item.name !== "string"
        || (typeof item.hash !== "string" && typeof item.tree !== "string")
        || (item.hash !== undefined && item.tree !== undefined)
      ) throw new Error("Invalid directory entry");
      return {
        name: item.name,
        ...(typeof item.hash === "string" ? { hash: item.hash } : {}),
        ...(typeof item.tree === "string" ? { tree: item.tree } : {}),
      };
    });
    return { type: "directory", entries };
  }
  throw new Error("Unknown wire object");
}

function cloudPlaceholderName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".icloud") && name.length > ".icloud".length + 1;
}

export async function snapshotDirectory(
  inputRoot: string,
  boundaries: ReadonlyMap<string, string> = new Map(),
): Promise<TreeSnapshot> {
  const root = resolve(inputRoot);
  if (!(await stat(root)).isDirectory()) throw new Error(`Tree root is not a directory: ${root}`);
  const objects = new Map<ObjectHash, Uint8Array>();

  const store = (object: WireObject): ObjectHash => {
    const bytes = encodeWireObject(object);
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };

  const walk = async (directory: string): Promise<ObjectHash> => {
    const entries: WireDirectoryEntry[] = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (cloudPlaceholderName(entry.name)) throw new UnavailableCloudContentError(join(directory, entry.name));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_WORKSPACE_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const boundary = boundaries.get(absolute);
      if (boundary) {
        entries.push({ name: entry.name, tree: boundary });
      } else if (entry.isDirectory()) {
        entries.push({ name: entry.name, hash: await walk(absolute) });
      } else if (entry.isFile()) {
        entries.push({ name: entry.name, hash: store({ type: "file", bytes: await readFile(absolute) }) });
      }
    }
    return store({ type: "directory", entries });
  };

  return { root: await walk(root), objects };
}

function contained(root: string, path: string): string {
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "..") throw new Error(`Wire object escapes destination: ${path}`);
  return target;
}

export async function materializeTree(
  root: string,
  rootHash: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  onBoundary?: (path: string, tree: string) => Promise<void>,
): Promise<void> {
  const destination = resolve(root);
  await mkdir(destination, { recursive: true });
  const visit = async (path: string, hash: ObjectHash): Promise<void> => {
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
    const object = decodeWireObject(bytes);
    if (object.type === "file") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, object.bytes);
      return;
    }
    await mkdir(path, { recursive: true });
    const expected = new Set(object.entries.map((entry) => entry.name));
    for (const existing of await readdir(path, { withFileTypes: true })) {
      if (IGNORED_WORKSPACE_DIRECTORIES.has(existing.name) || expected.has(existing.name)) continue;
      await rm(contained(destination, join(path, existing.name)), { recursive: true, force: true });
    }
    for (const entry of object.entries) {
      const target = contained(destination, join(path, entry.name));
      if (entry.tree) await onBoundary?.(target, entry.tree);
      else if (entry.hash) await visit(target, entry.hash);
    }
  };
  await visit(destination, rootHash);
}

export async function changedPaths(
  before: ObjectHash | null,
  after: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<string[]> {
  const changes: string[] = [];
  const compare = async (path: string, left: ObjectHash | null, right: ObjectHash): Promise<void> => {
    if (left === right) return;
    if (!left) {
      changes.push(path);
      return;
    }
    const [leftObject, rightObject] = await Promise.all([load(left).then(decodeWireObject), load(right).then(decodeWireObject)]);
    if (leftObject.type !== "directory" || rightObject.type !== "directory") {
      changes.push(path);
      return;
    }
    const leftEntries = new Map(leftObject.entries.map((entry) => [entry.name, entry]));
    const rightEntries = new Map(rightObject.entries.map((entry) => [entry.name, entry]));
    for (const name of new Set([...leftEntries.keys(), ...rightEntries.keys()])) {
      const leftEntry = leftEntries.get(name);
      const rightEntry = rightEntries.get(name);
      const childPath = `${path === "/" ? "" : path}/${name}`;
      if (!rightEntry || rightEntry.tree || leftEntry?.tree) {
        if (leftEntry?.tree !== rightEntry?.tree || leftEntry?.hash !== rightEntry?.hash) changes.push(childPath);
      } else {
        await compare(childPath, leftEntry?.hash ?? null, rightEntry.hash!);
      }
    }
  };
  await compare("/", before, after);
  return changes.sort();
}
