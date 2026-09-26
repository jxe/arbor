import type { BigIntStats } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { CollectionFileDescriptor, Hash } from "@overstory/protocol";
import {
  compareProtocolNames,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  type LazyTreeSnapshot,
  type ObjectHash,
  type TreeSnapshot,
  type ProtocolDirectoryEntry,
  type ProtocolDirectory,
  type ProtocolObjectSource,
} from "@overstory/protocol";
import { toTreePath } from "@overstory/protocol/path";
import { writeAtomic } from "@overstory/protocol/file-ops";
import {
  isCloudPlaceholderName,
  isPlatformMetadataName,
  isTransactionTemporaryName,
  MANDATORY_DIRECTORY_NAMES,
  type SkipPath,
} from "./ignore-policy.ts";

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
  /** Leaves out ignored, untracked content; see `membershipSkip`. Nested tree boundaries are never skipped. */
  skip?: SkipPath,
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
  const objects = new Map<ObjectHash, ProtocolObjectSource>();

  const store = (object: ProtocolDirectory): ObjectHash => {
    const bytes = encodeProtocolDirectory(object);
    decodeProtocolDirectory(bytes);
    const hash = hashObject(bytes);
    objects.set(hash, { hash, bytes: () => Promise.resolve(bytes) });
    return hash;
  };

  const readFileObject = async (absolute: string): Promise<{ hash: ObjectHash; bytes: Uint8Array }> => {
    const bytes = await readFile(absolute);
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
    objects.set(hash, { hash, bytes: () => Promise.resolve(bytes) });
    if (info) objectIndex!.remember(absolute, "file", info, hash);
    return hash;
  };

  /** `treePath` is `directory` relative to the walked root, for `skip`. */
  const walk = async (directory: string, treePath: string): Promise<ObjectHash> => {
    const childPath = (name: string) => `${treePath === "/" ? "" : treePath}/${name}`;
    const entries: ProtocolDirectoryEntry[] = [];
    let childrenSource: CollectionFileDescriptor | undefined;
    const seen = new Set<string>();
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compareProtocolNames(a.name, b.name))) {
      if (isTransactionTemporaryName(entry.name) || isPlatformMetadataName(entry.name)) continue;
      if (isCloudPlaceholderName(entry.name)) {
        // An evicted file that is not tree content is not needed.
        const logical = join(directory, entry.name.slice(1, -".icloud".length));
        if (skip && await skip(childPath(basename(logical)), false)) continue;
        throw new UnavailableCloudContentError(join(directory, entry.name));
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && MANDATORY_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (isExcluded(absolute)) continue;
      const boundary = normalizedBoundaries.get(absolute);
      if (!boundary && skip && (entry.isDirectory() || entry.isFile()) && await skip(childPath(entry.name), entry.isDirectory())) continue;
      if (boundary) {
        entries.push({ name: entry.name, tree: boundary });
        seen.add(entry.name);
      } else if (entry.isDirectory()) {
        entries.push({ name: entry.name, directory: objectIndex?.directoryHash?.(absolute) ?? await walk(absolute, childPath(entry.name)) });
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
            schemaSource: "schema.cddl",
            ...description,
          };
        }
        entries.push({ name: entry.name, file: source });
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
    for (const [name, tree] of [...virtualChildren].sort(([a], [b]) => compareProtocolNames(a, b))) {
      entries.push(tree
        ? { name, tree }
        : { name, directory: await walkVirtual(join(directory, name)) });
    }
    const hash = store({
      type: "directory",
      entries: entries.sort((a, b) => compareProtocolNames(a.name, b.name)),
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
    const entries: ProtocolDirectoryEntry[] = [];
    for (const [name, tree] of [...children].sort(([a], [b]) => compareProtocolNames(a, b))) {
      entries.push(tree ? { name, tree } : { name, directory: await walkVirtual(join(directory, name)) });
    }
    return store({ type: "directory", entries });
  };

  return { root: await walk(root, "/"), objects };
}

function contained(root: string, path: string): string {
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "..") throw new Error(`Wire object escapes destination: ${path}`);
  return target;
}

/**
 * `root` as a folder can hold it: without platform metadata, which a root
 * written before it was excluded may still hold. Unchanged roots keep their
 * hash; directory objects load through `load`.
 */
export async function withoutPlatformMetadata(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<ObjectHash> {
  const visit = async (hash: ObjectHash): Promise<ObjectHash> => {
    const directory = decodeProtocolDirectory(await load(hash));
    let changed = false;
    const entries: ProtocolDirectoryEntry[] = [];
    for (const entry of directory.entries) {
      if (isPlatformMetadataName(entry.name)) { changed = true; continue; }
      const nested = entry.directory ? await visit(entry.directory) : undefined;
      if (nested && nested !== entry.directory) { changed = true; entries.push({ name: entry.name, directory: nested }); continue; }
      entries.push(entry);
    }
    return changed ? hashObject(encodeProtocolDirectory({ ...directory, entries })) : hash;
  };
  return visit(root);
}

export async function materializeTree(
  root: string,
  rootHash: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  onBoundary?: (path: string, tree: string) => Promise<void>,
  excludedRoots: readonly string[] = [],
  /**
   * Keeps local content the tree does not own: cleanup never deletes a path
   * `skip` leaves out. Entries of the written root are always written, except
   * platform metadata.
   */
  skip?: SkipPath,
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
  const visit = async (path: string, hash: ObjectHash, kind: "file" | "directory"): Promise<void> => {
    if (isExcluded(path)) return;
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
    if (kind === "file") {
      await mkdir(dirname(path), { recursive: true });
      const existing = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing?.equals(Buffer.from(bytes))) return;
      await writeAtomic(path, bytes);
      return;
    }
    const object = decodeProtocolDirectory(bytes);
    await mkdir(path, { recursive: true });
    const expected = new Set(object.entries.map((entry) => entry.name));
    for (const existing of await readdir(path, { withFileTypes: true })) {
      if (MANDATORY_DIRECTORY_NAMES.has(existing.name) || isPlatformMetadataName(existing.name) || expected.has(existing.name) || isExcluded(join(path, existing.name))) continue;
      if (skip && await skip(toTreePath(canonicalDestination, join(path, existing.name)), existing.isDirectory())) continue;
      await rm(contained(canonicalDestination, join(path, existing.name)), { recursive: true, force: true });
    }
    for (const entry of object.entries) {
      // A root written before platform metadata was excluded may still hold
      // some; the system owns the local file, so it is neither written nor removed.
      if (isPlatformMetadataName(entry.name)) continue;
      const target = contained(canonicalDestination, join(path, entry.name));
      if (isExcluded(target)) continue;
      if (entry.tree) await onBoundary?.(target, entry.tree);
      else if (entry.file) await visit(target, entry.file, "file");
      else if (entry.directory) await visit(target, entry.directory, "directory");
    }
  };
  await visit(canonicalDestination, rootHash, "directory");
}
