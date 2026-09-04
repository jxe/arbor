import { decodeCBOR, encodeCanonicalCBOR } from "@arbor/core";
import { decodeWireObject, hashObject, type ObjectHash, type TreeSnapshot } from "./objects.ts";
import { verifyTreeSnapshotGraph } from "./updates/json.ts";

const HASH = /^sha256:[a-f0-9]{64}$/;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Encode one complete tree graph as the canonical immutable snapshot bundle. */
export function encodeSnapshotBundle(snapshot: TreeSnapshot): Uint8Array {
  verifyTreeSnapshotGraph(snapshot);
  const seen = new Set<ObjectHash>();
  const objects = [...snapshot.objects].map(([declaredHash, bytes]) => {
    const actualHash = hashObject(bytes);
    if (actualHash !== declaredHash) throw new Error(`Snapshot object hash mismatch: ${declaredHash}`);
    if (seen.has(actualHash)) throw new Error(`Snapshot contains duplicate object: ${actualHash}`);
    seen.add(actualHash);
    return { hash: actualHash, bytes };
  }).sort((left, right) => left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0);
  return encodeCanonicalCBOR({ version: 1, objects: objects.map(({ bytes }) => bytes) });
}

/** Decode and fully verify a canonical immutable snapshot bundle for the URL root. */
export function decodeSnapshotBundle(root: string, bytes: Uint8Array): TreeSnapshot {
  if (!HASH.test(root)) throw new Error("Snapshot root hash is invalid");
  const value = decodeCBOR(bytes);
  if (!value || typeof value !== "object" || value instanceof Uint8Array || Array.isArray(value)) {
    throw new Error("Snapshot bundle must be a map");
  }
  const record = value as Record<string, unknown>;
  if (!bytesEqual(encodeCanonicalCBOR(value), bytes)) throw new Error("Snapshot bundle is not canonical CBOR");
  if (Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.objects)) {
    throw new Error("Snapshot bundle fields are invalid");
  }

  const objects = new Map<ObjectHash, Uint8Array>();
  let previous: ObjectHash | undefined;
  for (const objectBytes of record.objects) {
    if (!(objectBytes instanceof Uint8Array)) throw new Error("Snapshot object must be a CBOR byte string");
    const hash = hashObject(objectBytes);
    if (previous && hash <= previous) throw new Error("Snapshot objects are not ordered by hash");
    previous = hash;
    if (objects.has(hash)) throw new Error(`Snapshot contains duplicate object: ${hash}`);
    decodeWireObject(objectBytes);
    objects.set(hash, objectBytes);
  }

  return verifyTreeSnapshotGraph({ root: root as ObjectHash, objects });
}
