import {
  compareProtocolNames,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  type ObjectHash,
  type ProtocolDirectory,
  type ProtocolDirectoryEntry,
} from "@overstory/protocol";

/**
 * Declined folder paths. A folder change is a whole-folder snapshot, so what a
 * declined change touched is a set of paths, and the folder can keep syncing
 * everywhere else: it publishes the accepted state at declined paths and never
 * writes accepted bytes over them. Paths are tree-relative (`/a/b`).
 */

export type LoadObject = (hash: ObjectHash) => Promise<Uint8Array>;
type Entry = ProtocolDirectoryEntry | null;

const EMPTY_FILE = hashObject(new Uint8Array());

function entryKey(entry: Entry): string {
  if (!entry) return "none";
  if (entry.file !== undefined) return `file:${entry.file}`;
  if (entry.directory !== undefined) return `directory:${entry.directory}`;
  return `tree:${entry.tree}`;
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function join(parent: string, name: string): string {
  return `${parent === "/" ? "" : parent}/${name}`;
}

/** Whether `path` is `ancestor` or lies beneath it. */
export function within(path: string, ancestor: string): boolean {
  return ancestor === "/" || path === ancestor || path.startsWith(`${ancestor}/`);
}

async function directory(hash: ObjectHash, load: LoadObject): Promise<ProtocolDirectory> {
  const object = decodeProtocolDirectory(await load(hash));
  if (object.type !== "directory") throw new Error(`Expected a directory: ${hash}`);
  return object;
}

async function children(hash: ObjectHash | undefined, load: LoadObject): Promise<Map<string, ProtocolDirectoryEntry>> {
  if (!hash) return new Map();
  return new Map((await directory(hash, load)).entries.map((entry) => [entry.name, entry]));
}

/** The entry at `path` beneath `root`, or null when nothing is there. The root itself is a directory entry named "". */
export async function entryAt(root: ObjectHash, path: string, load: LoadObject): Promise<Entry> {
  let entry: Entry = { name: "", directory: root };
  for (const name of segments(path)) {
    if (!entry?.directory) return null;
    entry = (await children(entry.directory, load)).get(name) ?? null;
  }
  return entry;
}

/** The smallest entries that differ between two roots: a differing pair of directories is described by its differing children. */
export async function differences(before: ObjectHash, after: ObjectHash, load: LoadObject, at = "/"): Promise<string[]> {
  if (before === after) return [];
  const [left, right] = await Promise.all([children(before, load), children(after, load)]);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort(compareProtocolNames);
  const result: string[] = [];
  for (const name of names) {
    const a = left.get(name) ?? null, b = right.get(name) ?? null;
    if (entryKey(a) === entryKey(b)) continue;
    const path = join(at, name);
    if (a?.directory && b?.directory) result.push(...await differences(a.directory, b.directory, load, path));
    else result.push(path);
  }
  return result;
}

/**
 * Where `path` is declined now: the path itself while the folder and the accepted
 * state both have directories above it, otherwise the highest point where
 * they stop agreeing on that. A declined file whose parent was deleted on disk
 * holds the whole deleted directory, never a partial deletion of it.
 */
export async function declinedPoint(path: string, disk: ObjectHash, accepted: ObjectHash, load: LoadObject): Promise<string> {
  let local: ObjectHash | undefined = disk, remote: ObjectHash | undefined = accepted, at = "/";
  const names = segments(path);
  for (const [index, name] of names.entries()) {
    at = join(at, name);
    if (index === names.length - 1) return at;
    const [mine, theirs]: Map<string, ProtocolDirectoryEntry>[] = await Promise.all([children(local, load), children(remote, load)]);
    local = mine!.get(name)?.directory;
    remote = theirs!.get(name)?.directory;
    if (!local || !remote) return at;
  }
  return at;
}

/** Every file hash beneath an entry. Child-tree boundaries contribute nothing. */
async function contents(entry: Entry, load: LoadObject, into = new Set<string>()): Promise<Set<string>> {
  if (entry?.file !== undefined) into.add(entry.file);
  else if (entry?.directory !== undefined) {
    for (const child of (await directory(entry.directory, load)).entries) await contents(child, load, into);
  }
  return into;
}

function minimal(paths: Iterable<string>): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const path of sorted) if (!kept.some((ancestor) => within(path, ancestor))) kept.push(path);
  return kept.sort();
}

export interface DeclinedView {
  /** Where declined work is now: recorded paths still declined, and content they moved elsewhere. */
  points: string[];
  /** Recorded paths where the folder now agrees with the accepted state. */
  lifted: string[];
}

/**
 * Resolve recorded declined paths against the folder and the accepted state. A
 * recorded path lifts once the folder matches the accepted state there. The
 * accepted content a declined path no longer holds on disk may have moved, so a
 * new or changed entry elsewhere that carries any of that content is declined too:
 * snapshots have no move identity, and publishing the destination of a
 * declined move alone would split it.
 */
export async function resolveDeclined(recorded: readonly string[], disk: ObjectHash, accepted: ObjectHash, load: LoadObject): Promise<DeclinedView> {
  const points: string[] = [], lifted: string[] = [];
  const displaced = new Set<string>();
  for (const path of recorded) {
    const point = await declinedPoint(path, disk, accepted, load);
    const [local, remote] = await Promise.all([entryAt(disk, point, load), entryAt(accepted, point, load)]);
    if (entryKey(local) === entryKey(remote)) { lifted.push(path); continue; }
    points.push(point);
    const kept = await contents(local, load);
    for (const hash of await contents(remote, load)) if (!kept.has(hash)) displaced.add(hash);
  }
  displaced.delete(EMPTY_FILE);
  if (displaced.size) {
    for (const path of await differences(accepted, disk, load)) {
      if (points.some((point) => within(path, point))) continue;
      const found = await contents(await entryAt(disk, path, load), load);
      if ([...found].some((hash) => displaced.has(hash))) points.push(path);
    }
  }
  return { points: minimal(points), lifted };
}

/**
 * The folder as it may be published: `disk` with the accepted state's entry
 * (or its absence) at every declined point. Returns the new root and the
 * directory objects it introduces.
 */
export async function maskDeclined(disk: ObjectHash, accepted: ObjectHash, points: readonly string[], load: LoadObject): Promise<{ root: ObjectHash; objects: Map<ObjectHash, Uint8Array> }> {
  const objects = new Map<ObjectHash, Uint8Array>();
  if (points.includes("/")) return { root: accepted, objects };
  const rewrite = async (local: ObjectHash, remote: ObjectHash | undefined, at: string): Promise<ObjectHash> => {
    const here = points.filter((point) => within(point, at) && point !== at);
    if (!here.length) return local;
    const object = await directory(local, load);
    const theirs = await children(remote, load);
    const entries = new Map(object.entries.map((entry) => [entry.name, entry]));
    const names = new Set(here.map((point) => segments(point)[segments(at).length]!));
    for (const name of names) {
      const path = join(at, name);
      const mine = entries.get(name), accepted = theirs.get(name);
      if (points.includes(path) || !mine?.directory || !accepted?.directory) {
        if (accepted) entries.set(name, accepted); else entries.delete(name);
      } else {
        entries.set(name, { name, directory: await rewrite(mine.directory, accepted.directory, path) });
      }
    }
    const bytes = encodeProtocolDirectory({ ...object, entries: [...entries.values()].sort((a, b) => compareProtocolNames(a.name, b.name)) });
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  return { root: await rewrite(disk, accepted, "/"), objects };
}
