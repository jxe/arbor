import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Hash, RollupDescriptor } from "@arbor/core";
import {
  compareWireNames,
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type TreeSnapshot,
  type WireDirectoryEntry,
  type WireObject,
} from "@arbor/wire";
import { IGNORED_WORKSPACE_DIRECTORIES } from "./discovery.ts";

export interface SnapshotRollupDescription {
  codec: RollupDescriptor["codec"];
  schema: Hash;
  scope: RollupDescriptor["scope"];
  modelHash: Hash;
}

export type DescribeSnapshotRollup = (
  directory: string,
  sourceName: string,
) => Promise<SnapshotRollupDescription | null>;

export class UnavailableCloudContentError extends Error {
  constructor(readonly path: string) {
    super(`Cloud content is not materialized: ${path}`);
    this.name = "UnavailableCloudContentError";
  }
}

function cloudPlaceholderName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".icloud") && name.length > ".icloud".length + 1;
}

function privateTransactionName(name: string): boolean {
  return name.includes(".arbor-write-") || name.includes(".arbor-txn-");
}

export async function snapshotDirectory(
  inputRoot: string,
  boundaries: ReadonlyMap<string, string> = new Map(),
  excludedRoots: readonly string[] = [],
  describeRollup?: DescribeSnapshotRollup,
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
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compareWireNames(a.name, b.name))) {
      if (privateTransactionName(entry.name)) continue;
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
        const source = store({ type: "file", bytes: await readFile(absolute) });
        const description = describeRollup && ["_store.csv", "_store.json", "_store.jsonl"].includes(entry.name)
          ? await describeRollup(directory, entry.name)
          : null;
        if (description) {
          const schemaPath = join(directory, "schema.ts");
          const schemaSource = store({ type: "file", bytes: await readFile(schemaPath) });
          entries.push({
            name: entry.name,
            rollup: { version: 1, source: source as Hash, schemaSource: schemaSource as Hash, ...description },
          });
        } else {
          entries.push({ name: entry.name, hash: source });
        }
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
    for (const [name, tree] of [...virtualChildren].sort(([a], [b]) => compareWireNames(a, b))) {
      entries.push(tree
        ? { name, tree }
        : { name, hash: await walkVirtual(join(directory, name)) });
    }
    return store({ type: "directory", entries: entries.sort((a, b) => compareWireNames(a.name, b.name)) });
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
    for (const [name, tree] of [...children].sort(([a], [b]) => compareWireNames(a, b))) {
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
      const existing = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing?.equals(Buffer.from(object.bytes))) return;
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
      else if (entry.rollup) await visit(target, entry.rollup.source);
      else if (entry.hash) await visit(target, entry.hash);
    }
  };
  await visit(canonicalDestination, rootHash);
}
