import {
  decodeWireObject,
  encodeTransitionPayloadJSON,
  hashObject,
  objectDelta,
  type AcceptedTransitionPayload,
  type ObjectDelta,
  type ObjectHash,
  type WireDirectoryEntry,
  type WireObject,
} from "@arbor/wire";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/** Objects larger than this are always transferred complete rather than diffed. */
const MAX_DELTA_SOURCE_BYTES = 64 * 1024 * 1024;

function encodedSize(payload: AcceptedTransitionPayload): number {
  return Buffer.byteLength(JSON.stringify(encodeTransitionPayloadJSON(payload)));
}

function matchingEntry(entry: WireDirectoryEntry, entries: WireDirectoryEntry[]): WireDirectoryEntry | undefined {
  return entries.find((candidate) => candidate.name === entry.name);
}

/**
 * Derive one replayable sparse transition from the authority's actual accepted
 * endpoints. Every changed object, directory or file, is sent as a delta
 * against its predecessor at the same path whenever that is smaller than the
 * complete object. This deliberately does not fold history: callers invoke it
 * once for each accepted root, including merged results.
 */
export async function buildAcceptedTransitionPayload(
  previousRoot: ObjectHash,
  targetRoot: ObjectHash,
  load: Load,
): Promise<AcceptedTransitionPayload> {
  const cache = new Map<ObjectHash, { bytes: Uint8Array; object: WireObject }>();
  const provided = new Set<ObjectHash>();
  const objects: AcceptedTransitionPayload["objects"] = [];
  const deltas: ObjectDelta[] = [];

  const loaded = async (hash: ObjectHash) => {
    const existing = cache.get(hash);
    if (existing) return existing;
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash) throw new Error(`Transition object hash mismatch: ${hash}`);
    const value = { bytes, object: decodeWireObject(bytes) };
    cache.set(hash, value);
    return value;
  };

  const visit = async (beforeHash: ObjectHash | undefined, afterHash: ObjectHash): Promise<void> => {
    if (beforeHash === afterHash || provided.has(afterHash)) return;
    provided.add(afterHash);
    const after = await loaded(afterHash);
    const before = beforeHash ? await loaded(beforeHash) : undefined;

    let delta: ObjectDelta | undefined;
    if (before && before.bytes.byteLength <= MAX_DELTA_SOURCE_BYTES && after.bytes.byteLength <= MAX_DELTA_SOURCE_BYTES) {
      const candidate: ObjectDelta = { base: beforeHash!, result: afterHash, instructions: objectDelta(before.bytes, after.bytes) };
      const complete = encodedSize({ objects: [{ hash: afterHash, bytes: after.bytes }] });
      if (encodedSize({ objects: [], deltas: [candidate] }) < complete) delta = candidate;
    }
    if (delta) deltas.push(delta);
    else objects.push({ hash: afterHash, bytes: after.bytes });

    if (after.object.type === "directory") {
      const beforeEntries = before?.object.type === "directory" ? before.object.entries : [];
      for (const entry of after.object.entries) {
        const prior = matchingEntry(entry, beforeEntries);
        if (entry.hash) await visit(prior?.hash, entry.hash);
      }
    }
  };

  await visit(previousRoot, targetRoot);
  const payload: AcceptedTransitionPayload = {
    objects,
    ...(deltas.length ? { deltas } : {}),
  };
  // Exercise the exact persisted/wire encoding here; generated objects and
  // delta results were already hash-checked while walking the canonical graph.
  encodeTransitionPayloadJSON(payload);
  return payload;
}
