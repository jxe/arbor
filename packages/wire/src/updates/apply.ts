import type { FileDelta, FilePatch } from "./types.ts";

const MAX_RESULT_BYTES = 1_000_000_000;

export function applyFilePatch(base: Uint8Array, patch: FilePatch): Uint8Array {
  if (!patch.edits.length) throw new Error("File patch edits must not be empty");
  let previousEnd = 0;
  let resultLength = base.byteLength;
  for (const edit of patch.edits) {
    if (!Number.isSafeInteger(edit.offset) || edit.offset < previousEnd
      || !Number.isSafeInteger(edit.length) || edit.length < 0) {
      throw new Error("Invalid or overlapping file patch edit");
    }
    const end = edit.offset + edit.length;
    if (!Number.isSafeInteger(end) || end > base.byteLength) throw new Error("File patch edit is out of bounds");
    resultLength += edit.bytes.byteLength - edit.length;
    if (!Number.isSafeInteger(resultLength) || resultLength < 0 || resultLength > MAX_RESULT_BYTES) {
      throw new Error("File patch result exceeds the storage quota");
    }
    previousEnd = end;
  }
  const result = new Uint8Array(resultLength);
  let sourceOffset = 0;
  let resultOffset = 0;
  for (const edit of patch.edits) {
    const unchanged = base.subarray(sourceOffset, edit.offset);
    result.set(unchanged, resultOffset);
    resultOffset += unchanged.byteLength;
    result.set(edit.bytes, resultOffset);
    resultOffset += edit.bytes.byteLength;
    sourceOffset = edit.offset + edit.length;
  }
  result.set(base.subarray(sourceOffset), resultOffset);
  return result;
}

export function applyFileDelta(base: Uint8Array, delta: FileDelta): Uint8Array {
  if (!delta.instructions.length) throw new Error("File delta instructions must not be empty");
  const chunks: Uint8Array[] = [];
  let resultLength = 0;
  for (const instruction of delta.instructions) {
    const chunk = "copy" in instruction
      ? (() => {
        const { offset, length } = instruction.copy;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0
          || offset > base.byteLength || length > base.byteLength - offset) {
          throw new Error("File delta copy is out of bounds");
        }
        return base.subarray(offset, offset + length);
      })()
      : instruction.insert;
    if (!chunk.byteLength) throw new Error("File delta instruction is empty");
    resultLength += chunk.byteLength;
    if (!Number.isSafeInteger(resultLength) || resultLength > MAX_RESULT_BYTES) {
      throw new Error("File delta result exceeds the storage quota");
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
