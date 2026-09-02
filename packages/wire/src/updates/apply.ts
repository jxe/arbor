import type { ObjectDelta, TransitionPayload } from "./types.ts";
import { hashObject, type ObjectHash } from "../objects.ts";

const MAX_RESULT_BYTES = 1_000_000_000;

/** Reconstruct the canonical bytes of `delta.result` from the canonical bytes of its base. */
export function applyObjectDelta(base: Uint8Array, delta: ObjectDelta): Uint8Array {
  if (!delta.instructions.length) throw new Error("Object delta instructions must not be empty");
  const chunks: Uint8Array[] = [];
  let resultLength = 0;
  for (const instruction of delta.instructions) {
    const chunk = "copy" in instruction
      ? (() => {
        const { offset, length } = instruction.copy;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0
          || offset > base.byteLength || length > base.byteLength - offset) {
          throw new Error("Object delta copy is out of bounds");
        }
        return base.subarray(offset, offset + length);
      })()
      : instruction.insert;
    if (!chunk.byteLength) throw new Error("Object delta instruction is empty");
    resultLength += chunk.byteLength;
    if (!Number.isSafeInteger(resultLength) || resultLength > MAX_RESULT_BYTES) {
      throw new Error("Object delta result exceeds the storage quota");
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(resultLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Apply one transition payload to a basis graph: complete objects are added
 * after their hashes are verified, and each delta is applied against an object
 * already present, in order, with its result verified. Throws on any mismatch.
 */
export function applyTransitionPayload(
  basis: ReadonlyMap<ObjectHash, Uint8Array>,
  payload: TransitionPayload,
): Map<ObjectHash, Uint8Array> {
  const objects = new Map(basis);
  for (const object of payload.objects) {
    if (hashObject(object.bytes) !== object.hash) throw new Error(`Transition object hash mismatch: ${object.hash}`);
    objects.set(object.hash, object.bytes);
  }
  for (const delta of payload.deltas) {
    const base = objects.get(delta.base);
    if (!base) throw new Error(`Object delta base is not available: ${delta.base}`);
    const bytes = applyObjectDelta(base, delta);
    if (hashObject(bytes) !== delta.result) throw new Error(`Object delta result hash mismatch: ${delta.result}`);
    objects.set(delta.result, bytes);
  }
  return objects;
}
