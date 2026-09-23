import {
  encodeTransitionPayloadJSON,
  objectDelta,
  type AcceptedTransitionPayload,
  type ObjectDelta,
  type ObjectHash,
} from "@overstory/protocol";
import { treeReader, walkTreeDiff, type Load, type TreeReader } from "./tree-diff.ts";

/** Objects larger than this are always transferred complete rather than diffed. */
const MAX_DELTA_SOURCE_BYTES = 64 * 1024 * 1024;

function encodedSize(payload: AcceptedTransitionPayload): number {
  return Buffer.byteLength(JSON.stringify(encodeTransitionPayloadJSON(payload)));
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
  load: Load | TreeReader,
): Promise<AcceptedTransitionPayload> {
  const reader = treeReader(load);
  const provided = new Set<ObjectHash>();
  const objects: AcceptedTransitionPayload["objects"] = [];
  const deltas: ObjectDelta[] = [];

  const provide = async (beforeHash: ObjectHash | undefined, afterHash: ObjectHash): Promise<void> => {
    if (beforeHash === afterHash || provided.has(afterHash)) return;
    provided.add(afterHash);
    const after = await reader.bytes(afterHash);
    const before = beforeHash ? await reader.bytes(beforeHash) : undefined;
    if (before && before.byteLength <= MAX_DELTA_SOURCE_BYTES && after.byteLength <= MAX_DELTA_SOURCE_BYTES) {
      const candidate: ObjectDelta = { base: beforeHash!, result: afterHash, instructions: objectDelta(before, after) };
      const complete = encodedSize({ objects: [{ hash: afterHash, bytes: after }], deltas: [] });
      if (encodedSize({ objects: [], deltas: [candidate] }) < complete) { deltas.push(candidate); return; }
    }
    objects.push({ hash: afterHash, bytes: after });
  };

  await walkTreeDiff(previousRoot, targetRoot, reader, {
    directory: ({ before, after }) => after ? provide(before?.hash, after.hash) : undefined,
    entry: async ({ before: prior, after: entry }) => {
      if (entry?.file) await provide(prior?.file ?? prior?.directory, entry.file);
      // A directory already provided at another path is not walked again;
      // removed entries need nothing.
      return !!entry?.directory && !provided.has(entry.directory);
    },
  });
  const payload: AcceptedTransitionPayload = {
    objects,
    deltas,
  };
  // Exercise the exact persisted/wire encoding here; every object was
  // hash-checked by the reader while walking the canonical graph.
  encodeTransitionPayloadJSON(payload);
  return payload;
}
