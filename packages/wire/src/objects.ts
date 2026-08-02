import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
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

function cloudPlaceholderName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".icloud") && name.length > ".icloud".length + 1;
}

export async function snapshotDirectory(
  inputRoot: string,
  boundaries: ReadonlyMap<string, string> = new Map(),
  excludedRoots: readonly string[] = [],
): Promise<TreeSnapshot> {
  const resolvedInputRoot = resolve(inputRoot);
  const root = await realpath(inputRoot);
  const normalizedBoundaries = new Map([...boundaries].map(([path, tree]) => [
    join(root, relative(resolvedInputRoot, resolve(path))),
    tree,
  ]));
  const exclusions = await Promise.all(excludedRoots.map(async (item) =>
    realpath(item).catch(() => resolve(item))
  ));
  const isExcluded = (path: string): boolean => {
    const candidate = resolve(path);
    return exclusions.some((excluded) => candidate === excluded || candidate.startsWith(`${excluded}${sep}`));
  };
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
    const seen = new Set<string>();
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (cloudPlaceholderName(entry.name)) throw new UnavailableCloudContentError(join(directory, entry.name));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_WORKSPACE_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (isExcluded(absolute)) continue;
      const boundary = normalizedBoundaries.get(absolute);
      if (boundary) {
        entries.push({ name: entry.name, tree: boundary });
        seen.add(entry.name);
      } else if (entry.isDirectory()) {
        entries.push({ name: entry.name, hash: await walk(absolute) });
        seen.add(entry.name);
      } else if (entry.isFile()) {
        entries.push({ name: entry.name, hash: store({ type: "file", bytes: await readFile(absolute) }) });
        seen.add(entry.name);
      }
    }
    const virtualChildren = new Map<string, string | null>();
    for (const [boundaryPath, tree] of normalizedBoundaries) {
      const remainder = relative(directory, boundaryPath);
      if (!remainder || remainder === ".." || remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) continue;
      const [name, ...rest] = remainder.split(/[\\/]/);
      if (!name || seen.has(name)) continue;
      virtualChildren.set(name, rest.length === 0 ? tree : null);
    }
    for (const [name, tree] of [...virtualChildren].sort(([a], [b]) => a.localeCompare(b))) {
      entries.push(tree
        ? { name, tree }
        : { name, hash: await walkVirtual(join(directory, name)) });
    }
    return store({ type: "directory", entries: entries.sort((a, b) => a.name.localeCompare(b.name)) });
  };

  const walkVirtual = async (directory: string): Promise<ObjectHash> => {
    const children = new Map<string, string | null>();
    for (const [boundaryPath, tree] of normalizedBoundaries) {
      const remainder = relative(directory, boundaryPath);
      if (!remainder || remainder === ".." || remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) continue;
      const [name, ...rest] = remainder.split(/[\\/]/);
      if (name) children.set(name, rest.length === 0 ? tree : null);
    }
    if (!children.size) throw new Error(`Virtual canonical boundary has no target below ${directory}`);
    const entries: WireDirectoryEntry[] = [];
    for (const [name, tree] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
      entries.push(tree ? { name, tree } : { name, hash: await walkVirtual(join(directory, name)) });
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
  excludedRoots: readonly string[] = [],
): Promise<void> {
  const destination = resolve(root);
  await mkdir(destination, { recursive: true });
  const canonicalDestination = await realpath(destination);
  const exclusions = await Promise.all(excludedRoots.map(async (item) =>
    realpath(item).catch(() => resolve(item))
  ));
  const isExcluded = (path: string): boolean => {
    const candidate = resolve(path);
    return exclusions.some((excluded) => candidate === excluded || candidate.startsWith(`${excluded}${sep}`));
  };
  const visit = async (path: string, hash: ObjectHash): Promise<void> => {
    if (isExcluded(path)) return;
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
      if (IGNORED_WORKSPACE_DIRECTORIES.has(existing.name) || expected.has(existing.name) || isExcluded(join(path, existing.name))) continue;
      await rm(contained(canonicalDestination, join(path, existing.name)), { recursive: true, force: true });
    }
    for (const entry of object.entries) {
      const target = contained(canonicalDestination, join(path, entry.name));
      if (isExcluded(target)) continue;
      if (entry.tree) await onBoundary?.(target, entry.tree);
      else if (entry.hash) await visit(target, entry.hash);
    }
  };
  await visit(canonicalDestination, rootHash);
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
