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
 * once, however many walks share it. One reader serves every diff of one
 * accepted update, so the transition and the entry changes of the same two
 * roots read the graph once.
 */
export class TreeReader {
  private readonly objects = new Map<ObjectHash, Promise<Uint8Array>>();
  private readonly directories = new Map<ObjectHash, Promise<WireDirectory>>();

  constructor(private readonly load: Load) {}

  bytes(hash: ObjectHash): Promise<Uint8Array> {
    let bytes = this.objects.get(hash);
    if (!bytes) {
      bytes = this.load(hash).then((value) => {
        if (hashObject(value) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
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

function sameEntry(a: WireDirectoryEntry | undefined, b: WireDirectoryEntry | undefined): boolean {
  return a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
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

/** The paths whose entries differ between two roots. A changed file, nested
 * tree or entry kind stays at its entry; a directory whose own metadata
 * changed is named itself. Physical changes are evidence of a change, never
 * of an editor operation. */
export async function changedEntryPaths(before: ObjectHash, after: ObjectHash, load: Load | TreeReader): Promise<string[]> {
  const paths: string[] = [];
  const metadata = ({ entries: _entries, ...rest }: WireDirectory) => JSON.stringify(rest);
  const value = (entry?: WireDirectoryEntry) =>
    entry?.file ? `file:${entry.file}` : entry?.directory ? `directory:${entry.directory}` : entry?.tree ? `tree:${entry.tree}` : "absent";
  await walkTreeDiff(before, after, load, {
    directory: ({ path, before: old, after: next }) => {
      if (old && next && metadata(old.directory) !== metadata(next.directory)) paths.push(path);
    },
    entry: ({ path, before: a, after: b }) => {
      if (a?.directory && b?.directory) return true;
      if (value(a) !== value(b)) paths.push(path);
    },
  });
  return paths;
}
