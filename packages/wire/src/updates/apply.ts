import type { ObjectDelta } from "./types.ts";

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
