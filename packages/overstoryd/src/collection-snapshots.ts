// Collections §1.1: the tree's host snapshots a collection when the changes in its log
// since the last snapshot outgrow its rows, so a replica or a cold load applies at most
// about as many changes as the collection has rows. A snapshot is an entry naming a SQLite
// file of every row, with the same row count and rows hash as the entry before it, written
// in an accepted update the host makes itself with no other effect.

import { compareProtocolNames, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectory } from "@ovst/protocol";
import { changesSinceSnapshot, loadDirectoryCollection, snapshotEntry, type CollectionSchemaCache } from "@ovst/collection-schema";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/** A collection is snapshotted once its log since the last snapshot holds at least this many changes, and at least as many as it has rows. */
export const SNAPSHOT_MIN_CHANGES = 1_000;

/** The collection folders whose log `after` changed from `before`, as path names. Only changed directories are read. */
export async function changedCollectionFolders(before: ObjectHash | null, after: ObjectHash, load: Load): Promise<string[][]> {
  const out: string[][] = [];
  const walk = async (was: ObjectHash | null, is: ObjectHash, names: string[]): Promise<void> => {
    if (was === is) return;
    const directory = decodeProtocolDirectory(await load(is));
    const old = was ? decodeProtocolDirectory(await load(was)) : null;
    if (directory.collection && directory.collection.log !== old?.collection?.log) out.push(names);
    const prior = new Map(old?.entries.map((e) => [e.name, e.directory ?? null]) ?? []);
    for (const entry of directory.entries) {
      if (entry.directory && entry.directory !== prior.get(entry.name)) await walk(prior.get(entry.name) ?? null, entry.directory, [...names, entry.name]);
    }
  };
  await walk(before, after, []);
  return out;
}

/**
 * `root` with a snapshot entry at the head of each collection in `folders` that needs one,
 * or null when none does. The new objects (entries, files, directories) join `objects`.
 */
export async function snapshotCollections(
  root: ObjectHash,
  folders: readonly string[][],
  load: Load,
  objects: Map<ObjectHash, Uint8Array>,
  schemas: CollectionSchemaCache,
  minChanges = SNAPSHOT_MIN_CHANGES,
): Promise<ObjectHash | null> {
  const read: Load = async (hash) => objects.get(hash) ?? load(hash);
  let next = root;
  for (const names of folders) {
    const directory = await directoryAt(next, names, read);
    if (!directory?.collection) continue;
    const pending = await changesSinceSnapshot(directory.collection.log, read);
    if (pending < minChanges) continue;
    const collection = await loadDirectoryCollection(directory, read, schemas);
    if (!collection || pending < collection.state.rows) continue;
    const snapshot = snapshotEntry(collection.schema, collection.state);
    objects.set(snapshot.file.hash as ObjectHash, snapshot.file.bytes);
    objects.set(snapshot.hash as ObjectHash, snapshot.bytes);
    next = await withDirectory(next, names, { ...directory, collection: { ...directory.collection, log: snapshot.hash } }, read, objects);
  }
  return next === root ? null : next;
}

async function directoryAt(root: ObjectHash, names: readonly string[], load: Load): Promise<ProtocolDirectory | null> {
  let at = root;
  for (const name of names) {
    const entry = decodeProtocolDirectory(await load(at)).entries.find((e) => e.name === name);
    if (!entry?.directory) return null;
    at = entry.directory;
  }
  return decodeProtocolDirectory(await load(at));
}

/** `root` with the directory at `names` replaced by `directory`, each directory above it rewritten. */
async function withDirectory(root: ObjectHash, names: readonly string[], directory: ProtocolDirectory, load: Load, objects: Map<ObjectHash, Uint8Array>): Promise<ObjectHash> {
  if (!names.length) {
    const bytes = encodeProtocolDirectory(directory), hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  }
  const parent = decodeProtocolDirectory(await load(root));
  const [name, ...rest] = names as [string, ...string[]];
  const entry = parent.entries.find((e) => e.name === name)!;
  const child = await withDirectory(entry.directory!, rest, directory, load, objects);
  const entries = parent.entries.map((e) => (e.name === name ? { name, directory: child } : e)).sort((a, b) => compareProtocolNames(a.name, b.name));
  return withDirectory(root, [], { ...parent, entries }, load, objects);
}
