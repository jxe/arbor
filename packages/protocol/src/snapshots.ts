import { decodeCBOR, encodeCanonicalCBOR } from "./index.ts";
import { decodeProtocolDirectory, hashObject, type ObjectHash, type TreeSnapshot } from "./objects.ts";
import { verifyTreeSnapshotGraph } from "./updates/json.ts";

const HASH = /^sha256:[a-f0-9]{64}$/;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Entry times (tree operations §1.1.2a): directory-entry path → Unix ms. */
export type EntryTimes = Record<string, number>;

/** The canonical bundle shape: version 1 and object bytes sorted by hash,
 * and with `?times` the entry times of its directories. */
function encodeBundle(objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>, times?: EntryTimes): Uint8Array {
  objects.sort((left, right) => left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0);
  return encodeCanonicalCBOR({ version: 1, objects: objects.map(({ bytes }) => bytes), ...(times ? { times } : {}) });
}

/** Encode one complete tree graph as the canonical immutable snapshot bundle. */
export function encodeSnapshotBundle(snapshot: TreeSnapshot, times?: EntryTimes): Uint8Array {
  // The graph check verifies every object's hash and reachability; a map holds no duplicates.
  verifyTreeSnapshotGraph(snapshot);
  return encodeBundle([...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })), times);
}

/**
 * Encode a *sparse* bundle: the same canonical CBOR shape as
 * `encodeSnapshotBundle` without the reachability check, so a producer may
 * omit objects the consumer resolves on demand. Every included object is
 * still hash-checked against its declared hash; a directory spine with file
 * objects left out is the intended use.
 */
export function encodeSparseSnapshotBundle(objects: Iterable<[ObjectHash, Uint8Array]>, times?: EntryTimes): Uint8Array {
  const seen = new Set<ObjectHash>();
  return encodeBundle([...objects].map(([declaredHash, bytes]) => {
    const actualHash = hashObject(bytes);
    if (actualHash !== declaredHash) throw new Error(`Snapshot object hash mismatch: ${declaredHash}`);
    if (seen.has(actualHash)) throw new Error(`Snapshot contains duplicate object: ${actualHash}`);
    seen.add(actualHash);
    return { hash: actualHash, bytes };
  }), times);
}

/** Decode a bundle's objects without verifying reachability; the caller validates the sparse graph. */
export function decodeSparseSnapshotBundle(bytes: Uint8Array): Map<ObjectHash, Uint8Array> {
  const { objects, times } = decodeBundle(bytes);
  if (times) throw new Error("Snapshot bundle fields are invalid");
  return objects;
}

/** Decode a bundle that may carry `times` (asked for with `?times`). Its
 * keys are checked against the bundle's directories by `checkEntryTimes`. */
export function decodeBundle(bytes: Uint8Array): { objects: Map<ObjectHash, Uint8Array>; times?: EntryTimes } {
  const value = decodeCBOR(bytes);
  if (!value || typeof value !== "object" || value instanceof Uint8Array || Array.isArray(value)) {
    throw new Error("Snapshot bundle must be a map");
  }
  const record = value as Record<string, unknown>;
  if (!bytesEqual(encodeCanonicalCBOR(value), bytes)) throw new Error("Snapshot bundle is not canonical CBOR");
  const timed = "times" in record;
  if (Object.keys(record).length !== (timed ? 3 : 2) || record.version !== 1 || !Array.isArray(record.objects)) {
    throw new Error("Snapshot bundle fields are invalid");
  }
  let times: EntryTimes | undefined;
  if (timed) {
    const value = record.times;
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new Error("Snapshot bundle times must be a map");
    for (const [path, at] of Object.entries(value)) {
      if (!path.startsWith("/") || typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) throw new Error(`Snapshot bundle time is invalid: ${path}`);
    }
    times = value as EntryTimes;
  }
  const objects = new Map<ObjectHash, Uint8Array>();
  let previous: ObjectHash | undefined;
  for (const objectBytes of record.objects) {
    if (!(objectBytes instanceof Uint8Array)) throw new Error("Snapshot object must be a CBOR byte string");
    const hash = hashObject(objectBytes);
    if (previous && hash <= previous) throw new Error("Snapshot objects are not ordered by hash");
    previous = hash;
    if (objects.has(hash)) throw new Error(`Snapshot contains duplicate object: ${hash}`);
    objects.set(hash, objectBytes);
  }
  return times ? { objects, times } : { objects };
}

/** Decode and fully verify a canonical immutable snapshot bundle for the URL root. */
export function decodeSnapshotBundle(root: string, bytes: Uint8Array): TreeSnapshot {
  if (!HASH.test(root)) throw new Error("Snapshot root hash is invalid");
  return verifyTreeSnapshotGraph({ root: root as ObjectHash, objects: decodeSparseSnapshotBundle(bytes) });
}

/**
 * The file and page entries of every directory a bundle holds, reached from
 * `root` through directories it holds, as `path → object hash`: exactly the
 * keys a timed bundle's `times` has (tree operations §1.1.2a).
 */
export function bundleEntries(root: ObjectHash, objects: Map<ObjectHash, Uint8Array>): Map<string, ObjectHash> {
  const entries = new Map<string, ObjectHash>();
  const walk = (hash: ObjectHash, path: string) => {
    const bytes = objects.get(hash);
    if (!bytes) return;
    for (const entry of decodeProtocolDirectory(bytes).entries) {
      const child = `${path}/${entry.name}`;
      if (entry.directory !== undefined) walk(entry.directory, child);
      else if (entry.file !== undefined) entries.set(child, entry.file);
      else if (entry.page !== undefined) entries.set(child, entry.page);
    }
  };
  walk(root, "");
  return entries;
}

/** Check a timed bundle's `times` names exactly its directories' file and page entries. */
export function checkEntryTimes(root: ObjectHash, objects: Map<ObjectHash, Uint8Array>, times: EntryTimes): EntryTimes {
  const entries = bundleEntries(root, objects);
  for (const path of Object.keys(times)) if (!entries.has(path)) throw new Error(`Bundle times name an entry it does not hold: ${path}`);
  for (const path of entries.keys()) if (!(path in times)) throw new Error(`Bundle times leave out ${path}`);
  return times;
}

/** Decode and verify a timed snapshot bundle (`?times`). */
export function decodeTimedSnapshotBundle(root: string, bytes: Uint8Array): { snapshot: TreeSnapshot; times: EntryTimes } {
  if (!HASH.test(root)) throw new Error("Snapshot root hash is invalid");
  const { objects, times } = decodeBundle(bytes);
  if (!times) throw new Error("Snapshot bundle has no times");
  const snapshot = verifyTreeSnapshotGraph({ root: root as ObjectHash, objects });
  return { snapshot, times: checkEntryTimes(snapshot.root, snapshot.objects, times) };
}
