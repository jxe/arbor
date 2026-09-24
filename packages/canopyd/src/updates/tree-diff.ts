import {
  compareWireNames,
  decodeWireDirectory,
  hashObject,
  type ObjectHash,
  type WireDirectory,
  type WireDirectoryEntry,
} from "@overstory/protocol";

export type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/**
 * Reads each object once, checks its hash once, and decodes each directory
 * once, however many walks share it. A loader that already verifies what it
 * returns, such as the object store's `read`, is passed as `verified` so its
 * bytes are not hashed again; bytes a client proposed are always checked.
 */
export class TreeReader {
  private readonly objects = new Map<ObjectHash, Promise<Uint8Array>>();
  private readonly directories = new Map<ObjectHash, Promise<WireDirectory>>();

  constructor(private readonly load: Load, private readonly options: { verified?: boolean } = {}) {}

  bytes(hash: ObjectHash): Promise<Uint8Array> {
    let bytes = this.objects.get(hash);
    if (!bytes) {
      bytes = this.load(hash).then((value) => {
        if (!this.options.verified && hashObject(value) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
        return value;
      });
      this.objects.set(hash, bytes);
    }
    return bytes;
  }

  directory(hash: ObjectHash): Promise<WireDirectory> {
    let directory = this.directories.get(hash);
    if (!directory) {
      directory = this.bytes(hash).then(decodeWireDirectory);
      this.directories.set(hash, directory);
    }
    return directory;
  }
}

export function treeReader(load: Load | TreeReader): TreeReader {
  return load instanceof TreeReader ? load : new TreeReader(load);
}

/** One directory level of a walk: either side is absent where that side has no directory. */
interface DirectoryPair {
  path: string;
  depth: number;
  before: { hash: ObjectHash; directory: WireDirectory } | null;
  after: { hash: ObjectHash; directory: WireDirectory } | null;
}

/** One name whose entry differs between the two sides. */
interface EntryPair {
  /** `/`-joined from the walk's root, without a trailing slash; the root is `""`. */
  path: string;
  parent: string;
  name: string;
  depth: number;
  before?: WireDirectoryEntry;
  after?: WireDirectoryEntry;
}

interface TreeDiffVisitor {
  directory?(pair: DirectoryPair): void | Promise<void>;
  /** Return true to walk into the entry's directory on each side that has one. */
  entry(pair: EntryPair): boolean | void | Promise<boolean | void>;
}

/** A wire entry is its name and exactly one of `file`, `directory`, `tree`
 * (`decodeWireDirectory` admits no other key), so those fields decide equality. */
function sameEntry(a: WireDirectoryEntry | undefined, b: WireDirectoryEntry | undefined): boolean {
  return a === b || (!!a && !!b && a.name === b.name && a.file === b.file && a.directory === b.directory && a.tree === b.tree);
}

/**
 * Walk two directory graphs together. Identical directory hashes are skipped
 * whole; within a directory, names are visited in canonical order and an
 * entry identical on both sides is skipped. Either root may be null, so an
 * added or removed subtree is walked against nothing.
 */
export async function walkTreeDiff(
  before: ObjectHash | null,
  after: ObjectHash | null,
  load: Load | TreeReader,
  visitor: TreeDiffVisitor,
): Promise<void> {
  const reader = treeReader(load);
  const walk = async (left: ObjectHash | null, right: ObjectHash | null, path: string, depth: number): Promise<void> => {
    if (left === right) return;
    const [a, b] = await Promise.all([left ? reader.directory(left) : null, right ? reader.directory(right) : null]);
    await visitor.directory?.({
      path: path || "/",
      depth,
      before: left && a ? { hash: left, directory: a } : null,
      after: right && b ? { hash: right, directory: b } : null,
    });
    const old = new Map((a?.entries ?? []).map((entry) => [entry.name, entry]));
    const next = new Map((b?.entries ?? []).map((entry) => [entry.name, entry]));
    const names = [...new Set([...old.keys(), ...next.keys()])].sort(compareWireNames);
    for (const name of names) {
      const x = old.get(name), y = next.get(name);
      if (sameEntry(x, y)) continue;
      const child = `${path}/${name}`;
      const descend = await visitor.entry({ path: child, parent: path || "/", name, depth, before: x, after: y });
      if (descend && (x?.directory || y?.directory))
        await walk(x?.directory ?? null, y?.directory ?? null, child, depth + 1);
    }
  };
  await walk(before, after, "", 0);
}
