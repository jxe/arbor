import type { BigIntStats } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { CollectionFileDescriptor, Hash } from "@arbor/core";
import {
  compareWireNames,
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type LazyTreeSnapshot,
  type ObjectHash,
  type TreeSnapshot,
  type WireDirectoryEntry,
  type WireObject,
  type WireObjectSource,
} from "@arbor/wire";
import { IGNORED_WORKSPACE_DIRECTORIES } from "./discovery.ts";
import { writeAtomic } from "./file-ops.ts";

export interface SnapshotCollectionFileDescription {
  format: CollectionFileDescriptor["format"];
  schemaFingerprint: Hash;
  childSetHash: Hash;
}

export type DescribeSnapshotCollectionFile = (
  directory: string,
  sourceName: string,
) => Promise<SnapshotCollectionFileDescription | null>;

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

/**
 * The per-workspace object index consulted by `snapshotDirectory`. A file hit
 * is trusted only when the caller's stat tuple matches the stored row; the
 * walk then skips reading that file and returns a loader that reads on demand.
 * `directoryHash` is optional and only for callers that verify the produced
 * object afterwards: it lets the walk adopt a cached subtree hash without
 * recursing, which is never safe on its own because directory rows carry no
 * validity tuple.
 */
export interface SnapshotObjectIndex {
  fileHash(absolute: string, stat: BigIntStats): ObjectHash | undefined;
  remember(absolute: string, kind: "file" | "directory", stat: BigIntStats | undefined, hash: ObjectHash): void;
  directoryHash?(absolute: string): ObjectHash | undefined;
}

function markdownName(name: string): boolean {
  return extname(name).toLowerCase() === ".md";
}

/** Load every object of a lazy snapshot into memory. */
export async function resolveSnapshot(lazy: LazyTreeSnapshot): Promise<TreeSnapshot> {
  const objects = new Map<ObjectHash, Uint8Array>();
  const sources = [...lazy.objects.values()];
  const concurrency = 16;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
    while (next < sources.length) {
      const source = sources[next++]!;
      objects.set(source.hash, await source.bytes());
    }
  }));
  return { root: lazy.root, objects };
}

export async function snapshotDirectory(
  inputRoot: string,
  boundaries: ReadonlyMap<string, string> = new Map(),
  excludedRoots: readonly string[] = [],
  describeCollectionFile?: DescribeSnapshotCollectionFile,
  objectIndex?: SnapshotObjectIndex,
): Promise<LazyTreeSnapshot> {
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
  const objects = new Map<ObjectHash, WireObjectSource>();

  const store = (object: WireObject): ObjectHash => {
    const bytes = encodeWireObject(object);
    decodeWireObject(bytes);
    const hash = hashObject(bytes);
    objects.set(hash, { hash, kind: object.type, bytes: () => Promise.resolve(bytes) });
    return hash;
  };

  const readFileObject = async (absolute: string): Promise<{ hash: ObjectHash; bytes: Uint8Array }> => {
    const bytes = encodeWireObject({ type: "file", bytes: await readFile(absolute) });
    return { hash: hashObject(bytes), bytes };
  };

  /** A file's object: cached bytes when read now, otherwise a verified on-demand loader. */
  const fileSource = async (absolute: string, name: string): Promise<ObjectHash> => {
    const info = objectIndex ? await stat(absolute, { bigint: true }) : undefined;
    const cached = info && !markdownName(name) ? objectIndex!.fileHash(absolute, info) : undefined;
    if (cached) {
      let loaded: Promise<Uint8Array> | undefined;
      objects.set(cached, {
        hash: cached,
        kind: "file",
        bytes: () => loaded ??= readFileObject(absolute).then(({ hash, bytes }) => {
          if (hash !== cached) {
            loaded = undefined;
            throw new Error(`File changed after its snapshot was taken: ${absolute}`);
          }
          return bytes;
        }),
      });
      return cached;
    }
    const { hash, bytes } = await readFileObject(absolute);
    objects.set(hash, { hash, kind: "file", bytes: () => Promise.resolve(bytes) });
    if (info) objectIndex!.remember(absolute, "file", info, hash);
    return hash;
  };

  const walk = async (directory: string): Promise<ObjectHash> => {
    const entries: WireDirectoryEntry[] = [];
    let childrenSource: CollectionFileDescriptor | undefined;
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
        entries.push({ name: entry.name, hash: objectIndex?.directoryHash?.(absolute) ?? await walk(absolute) });
        seen.add(entry.name);
      } else if (entry.isFile()) {
        const source = await fileSource(absolute, entry.name);
        const description = describeCollectionFile && ["_store.csv", "_store.json", "_store.jsonl"].includes(entry.name)
          ? await describeCollectionFile(directory, entry.name)
          : null;
        if (description) {
          if (childrenSource) throw new Error(`Directory has more than one collection file: ${directory}`);
          childrenSource = {
            version: 1,
            type: "collection-file",
            source: entry.name as CollectionFileDescriptor["source"],
            schemaSource: "schema.ts",
            ...description,
          };
        }
        entries.push({ name: entry.name, hash: source });
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
    const hash = store({
      type: "directory",
      entries: entries.sort((a, b) => compareWireNames(a.name, b.name)),
      ...(childrenSource ? { childrenSource } : {}),
    });
    objectIndex?.remember(directory, "directory", undefined, hash);
    return hash;
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
      await writeAtomic(path, object.bytes);
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
