import {
  decodeWireDirectory,
  encodeTransitionPayloadJSON,
  hashObject,
  objectDelta,
  type AcceptedTransitionPayload,
  type ObjectDelta,
  type ObjectHash,
  type WireDirectoryEntry,
  type WireDirectory,
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
 * complete object. Endpoints may be adjacent accepted roots or span a backlog;
 * intermediate history is not read or rewritten.
 */
export async function buildAcceptedTransitionPayload(
  previousRoot: ObjectHash,
  targetRoot: ObjectHash,
  load: Load,
): Promise<AcceptedTransitionPayload> {
  const cache = new Map<ObjectHash, { bytes: Uint8Array; object?: WireDirectory }>();
  const provided = new Set<ObjectHash>();
  const objects: AcceptedTransitionPayload["objects"] = [];
  const deltas: ObjectDelta[] = [];

  const loaded = async (hash: ObjectHash, kind: "file" | "directory") => {
    const existing = cache.get(`${kind}:${hash}`);
    if (existing) return existing;
    const bytes = await load(hash);
    if (hashObject(bytes) !== hash) throw new Error(`Transition object hash mismatch: ${hash}`);
    const value = { bytes, object: kind === "directory" ? decodeWireDirectory(bytes) : undefined };
    cache.set(`${kind}:${hash}`, value);
    return value;
  };

  const visit = async (beforeHash: ObjectHash | undefined, afterHash: ObjectHash, afterKind: "file" | "directory", beforeKind: "file" | "directory" = afterKind): Promise<void> => {
    if (beforeHash === afterHash || provided.has(afterHash)) return;
    provided.add(afterHash);
    const after = await loaded(afterHash, afterKind);
    const before = beforeHash ? await loaded(beforeHash, beforeKind) : undefined;

    let delta: ObjectDelta | undefined;
    if (before && before.bytes.byteLength <= MAX_DELTA_SOURCE_BYTES && after.bytes.byteLength <= MAX_DELTA_SOURCE_BYTES) {
      const candidate: ObjectDelta = { base: beforeHash!, result: afterHash, instructions: objectDelta(before.bytes, after.bytes) };
      const complete = encodedSize({ objects: [{ hash: afterHash, bytes: after.bytes }], deltas: [] });
      if (encodedSize({ objects: [], deltas: [candidate] }) < complete) delta = candidate;
    }
    if (delta) deltas.push(delta);
    else objects.push({ hash: afterHash, bytes: after.bytes });

    if (after.object) {
      const beforeEntries = before?.object?.entries ?? [];
      for (const entry of after.object.entries) {
        const prior = matchingEntry(entry, beforeEntries);
        if (entry.file || entry.directory) await visit(prior?.file ?? prior?.directory, (entry.file ?? entry.directory)!, entry.file ? "file" : "directory", prior?.file ? "file" : "directory");
      }
    }
  };

  await visit(previousRoot, targetRoot, "directory");
  const payload: AcceptedTransitionPayload = {
    objects,
    deltas,
  };
  // Exercise the exact persisted/wire encoding here; generated objects and
  // delta results were already hash-checked while walking the canonical graph.
  encodeTransitionPayloadJSON(payload);
  return payload;
}
