import { canonicalNodePath, normalizeTreePath } from "./model/logical-path.ts";
import { decodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectory, type ProtocolDirectoryEntry } from "./objects.ts";
import { checkEntryTimes, decodeBundle, decodeSparseSnapshotBundle, encodeSparseSnapshotBundle, type EntryTimes } from "./snapshots.ts";

/**
 * Path reads (tree operations §1.2.4): the directory objects from an accepted
 * root down to one logical path, and the objects of the entries that path
 * names, in one bundle. A reader that opens one page at a time (Browse) gets a
 * page and everything it needs to edit it in one round trip.
 *
 * The walk is the same for every producer (overstoryd, Story Sync on
 * loopback) and every consumer, so it lives here once.
 */

const INDEX_NAMES = ["_index.md"] as const;

/** Whether an entry addresses an object (rather than a nested tree's boundary). */
function entryObject(entry: ProtocolDirectoryEntry): { hash: ObjectHash; directory: boolean } | null {
  if (entry.directory !== undefined) return { hash: entry.directory, directory: true };
  if (entry.page !== undefined) return { hash: entry.page, directory: false };
  if (entry.file !== undefined) return { hash: entry.file, directory: false };
  return null;
}

/** The path's components as the walk follows them; `/` has none. */
export function pathReadComponents(path: string): string[] {
  const normalized = normalizeTreePath(path);
  // `x.md`, `x/` and `x/_index.md` are spellings of node `x` (locators §2);
  // a literal file such as `photo.bin` stays as it is.
  const node = /(?:^|\/)_index\.md$|\.md$/.test(normalized) ? canonicalNodePath(normalized) : normalized;
  return node.split("/").filter(Boolean);
}

/**
 * The entries of `directory` that the last component `name` names: an entry
 * of that exact name, and the page body of node `name` (`name.md`). A
 * directory named `name` brings its own index page too.
 */
function namedEntries(directory: ProtocolDirectory, name: string): ProtocolDirectoryEntry[] {
  const names = new Set([name, `${name}.md`]);
  return directory.entries.filter((entry) => names.has(entry.name));
}

function indexEntries(directory: ProtocolDirectory): ProtocolDirectoryEntry[] {
  return directory.entries.filter((entry) => (INDEX_NAMES as readonly string[]).includes(entry.name));
}

/**
 * Which objects a path read of `path` under `root` holds, in walk order.
 *
 * - every directory from the root down to the path's parent, as far as the
 *   path exists;
 * - for the last component, the objects of the entries it names (exact name,
 *   `.md`), and when one of them is a directory, that directory's
 *   index page;
 * - for `/`, the root directory and its index page.
 *
 * A missing component or a nested tree's boundary ends the walk: the bundle
 * then holds the directories down to the deepest one that exists, which is
 * enough for the reader to see that the entry is absent or in another tree.
 * `read` returns null for an object it does not have; the walk then stops
 * there and the caller decides whether that is an error.
 */
export async function pathReadObjects(
  root: ObjectHash,
  path: string,
  read: (hash: ObjectHash) => Promise<Uint8Array | null | undefined>,
): Promise<Map<ObjectHash, Uint8Array>> {
  const objects = new Map<ObjectHash, Uint8Array>();
  const load = async (hash: ObjectHash): Promise<Uint8Array | null> => {
    const known = objects.get(hash);
    if (known) return known;
    const bytes = await read(hash);
    if (!bytes) return null;
    if (hashObject(bytes) !== hash) throw new Error(`Path read object hash mismatch: ${hash}`);
    objects.set(hash, bytes);
    return bytes;
  };
  const rootBytes = await load(root);
  if (!rootBytes) throw new PathReadMissingRoot(root);
  let directory = decodeProtocolDirectory(rootBytes);
  const components = pathReadComponents(path);
  const addIndex = async (of: ProtocolDirectory) => {
    for (const entry of indexEntries(of)) {
      const object = entryObject(entry);
      if (object) await load(object.hash);
    }
  };
  if (!components.length) {
    await addIndex(directory);
    return objects;
  }
  for (const [index, component] of components.entries()) {
    const last = index === components.length - 1;
    if (!last) {
      const entry = directory.entries.find((candidate) => candidate.name === component);
      const object = entry ? entryObject(entry) : null;
      if (!object?.directory) return objects;
      const bytes = await load(object.hash);
      if (!bytes) return objects;
      directory = decodeProtocolDirectory(bytes);
      continue;
    }
    for (const entry of namedEntries(directory, component)) {
      const object = entryObject(entry);
      if (!object) continue;
      const bytes = await load(object.hash);
      if (bytes && object.directory) await addIndex(decodeProtocolDirectory(bytes));
    }
  }
  return objects;
}

export class PathReadMissingRoot extends Error {
  constructor(readonly root: ObjectHash) {
    super(`Path read root is not available: ${root}`);
  }
}

/** The bundle a path read answers with: the snapshot bundle's exact shape (sparse). */
export function encodePathReadBundle(objects: Map<ObjectHash, Uint8Array>, times?: EntryTimes): Uint8Array {
  return encodeSparseSnapshotBundle(objects, times);
}

/**
 * Decode and check a path read's bundle: canonical, hash-ordered, the root a
 * present directory, and exactly the objects the walk of `path` from `root`
 * reaches (no more, and none it needed is missing).
 */
export async function decodePathReadBundle(root: ObjectHash, path: string, bytes: Uint8Array): Promise<Map<ObjectHash, Uint8Array>> {
  return checkPathReadObjects(root, path, decodeSparseSnapshotBundle(bytes));
}

/** Decode and check a timed path read's bundle (`?times`): the objects as
 * `decodePathReadBundle` checks them, and times for exactly its directories' entries. */
export async function decodeTimedPathReadBundle(root: ObjectHash, path: string, bytes: Uint8Array): Promise<{ objects: Map<ObjectHash, Uint8Array>; times: EntryTimes }> {
  const { objects, times } = decodeBundle(bytes);
  if (!times) throw new Error("Path read bundle has no times");
  await checkPathReadObjects(root, path, objects);
  return { objects, times: checkEntryTimes(root, objects, times) };
}

async function checkPathReadObjects(root: ObjectHash, path: string, supplied: Map<ObjectHash, Uint8Array>): Promise<Map<ObjectHash, Uint8Array>> {
  if (!supplied.has(root)) throw new Error("Path read bundle does not hold its root");
  const missing: ObjectHash[] = [];
  const walked = await pathReadObjects(root, path, async (hash) => {
    const bytes = supplied.get(hash);
    if (!bytes) missing.push(hash);
    return bytes ?? null;
  });
  // A bundle may not stop short of a path that exists, nor carry anything else.
  if (missing.length) throw new Error(`Path read bundle is missing ${missing[0]}`);
  for (const hash of supplied.keys()) {
    if (!walked.has(hash)) throw new Error(`Path read bundle holds an object off the path: ${hash}`);
  }
  return supplied;
}

/** The logical path in a path read's URL: each segment percent-decoded exactly once (locators §3). */
export function decodePathReadPath(encoded: string): string {
  const segments = encoded.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments.some((segment) => segment.includes("/"))) throw new Error("A path segment may not hold a slash");
  return normalizeTreePath(`/${segments.join("/")}`);
}

/** The URL suffix for a path read of `path`: each segment encoded once. */
export function encodePathReadPath(path: string): string {
  const segments = normalizeTreePath(path).split("/").filter(Boolean);
  return segments.length ? `/${segments.map(encodeURIComponent).join("/")}` : "";
}
