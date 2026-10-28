import { decodeProtocolDirectory, protocolObjectReferences, type ObjectHash } from "../objects.ts";
import { objectDelta } from "./delta.ts";
import { treeReader, walkTreeDiff, type LoadObject, type TreeReader } from "./tree-diff.ts";
import type { ObjectDelta, TransitionPayload } from "./types.ts";

/** Objects larger than this are always transferred complete rather than diffed. */
export const MAX_DELTA_SOURCE_BYTES = 64 * 1024 * 1024;

/** Length of standard padded base64 for `bytes` bytes. */
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * The JSON length one object adds to an encoded transition payload, complete
 * or as a delta, computed without encoding it. Hashes, base64 and integers
 * need no JSON escaping, so these equal the `encodeTransitionPayloadJSON`
 * lengths; only the comparison between the two forms matters.
 */
function completeLength(hash: ObjectHash, bytes: Uint8Array): number {
  return '{"hash":"","bytes":""}'.length + hash.length + base64Length(bytes.byteLength);
}

function deltaLength(delta: ObjectDelta): number {
  let length = '{"base":"","result":"","instructions":[]}'.length + delta.base.length + delta.result.length
    + Math.max(0, delta.instructions.length - 1);
  for (const instruction of delta.instructions) {
    length += "copy" in instruction
      ? '{"copy":{"offset":,"length":}}'.length + String(instruction.copy.offset).length + String(instruction.copy.length).length
      : '{"insert":""}'.length + base64Length(instruction.insert.byteLength);
  }
  return length;
}

/**
 * The sparse transition from `before` to `after`. Every changed object,
 * directory or file, is sent as a delta against its predecessor at the same
 * path in `before` whenever that is smaller than the complete object, so each
 * delta base is reachable from `before`. Objects in `known`, which the
 * receiver already holds, are neither sent nor walked into.
 */
export async function transitionPayload(
  before: ObjectHash,
  after: ObjectHash,
  load: LoadObject | TreeReader,
  options: { known?: ReadonlySet<ObjectHash> } = {},
): Promise<TransitionPayload> {
  const reader = treeReader(load);
  const provided = new Set<ObjectHash>(options.known);
  const objects: TransitionPayload["objects"] = [];
  const deltas: ObjectDelta[] = [];

  const provide = async (beforeHash: ObjectHash | undefined, afterHash: ObjectHash): Promise<void> => {
    if (beforeHash === afterHash || provided.has(afterHash)) return;
    provided.add(afterHash);
    const next = await reader.bytes(afterHash);
    const base = beforeHash && next.byteLength <= MAX_DELTA_SOURCE_BYTES ? await reader.bytes(beforeHash) : undefined;
    if (base && base.byteLength <= MAX_DELTA_SOURCE_BYTES) {
      const candidate: ObjectDelta = { base: beforeHash!, result: afterHash, instructions: objectDelta(base, next) };
      if (deltaLength(candidate) < completeLength(afterHash, next)) { deltas.push(candidate); return; }
    }
    objects.push({ hash: afterHash, bytes: next });
  };

  // A collection's tables and row chunks, each against the same model's table
  // and the chunk at the same place in it before.
  const collection = async (beforeHash: ObjectHash | undefined, afterHash: ObjectHash): Promise<void> => {
    const tables = decodeProtocolDirectory(await reader.bytes(afterHash)).collection?.tables;
    if (!tables) return;
    const prior = beforeHash ? new Map((decodeProtocolDirectory(await reader.bytes(beforeHash)).collection?.tables ?? []).map((t) => [t.model, t.table])) : new Map();
    for (const { model, table } of tables) {
      const was = prior.get(model);
      if (was === table || provided.has(table)) continue;
      await provide(was, table);
      const chunks = protocolObjectReferences("table", await reader.bytes(table));
      const priorChunks = was ? protocolObjectReferences("table", await reader.bytes(was)) : [];
      for (const [index, chunk] of chunks.entries()) await provide(priorChunks[index]?.hash, chunk.hash);
    }
  };

  await walkTreeDiff(before, after, reader, {
    directory: async ({ before, after }) => {
      if (!after) return;
      const fresh = !provided.has(after.hash) && before?.hash !== after.hash;
      await provide(before?.hash, after.hash);
      if (fresh) await collection(before?.hash, after.hash);
    },
    entry: async ({ before: prior, after: entry }) => {
      const content = entry?.file ?? entry?.page;
      if (content) await provide(prior?.file ?? prior?.page ?? prior?.directory, content);
      // A directory already provided at another path, or already known, is
      // not walked again; removed entries need nothing.
      return !!entry?.directory && !provided.has(entry.directory);
    },
  });
  return { objects, deltas };
}
