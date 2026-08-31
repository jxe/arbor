import type { ObjectHash } from "../objects.ts";
import type {
  AcceptedTransition,
  AcceptedTransitionPayload,
  FileDelta,
  FilePatch,
  UpdateRequest,
} from "./types.ts";

export interface ObjectEnvelopeJSON {
  hash: ObjectHash;
  bytes: string;
}

export interface UpdateRequestJSON {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: ObjectEnvelopeJSON[];
  filePatches?: Array<{
    base: ObjectHash;
    result: ObjectHash;
    edits: Array<{ offset: number; length: number; bytes: string }>;
  }>;
  returnSnapshot?: true | "if-result-differs";
}

export interface TransitionPayloadJSON {
  objects: ObjectEnvelopeJSON[];
  filePatches?: UpdateRequestJSON["filePatches"];
  fileDeltas?: Array<{
    base: ObjectHash;
    result: ObjectHash;
    instructions: Array<{ copy: { offset: number; length: number } } | { insert: string }>;
  }>;
}

export interface AcceptedTransitionJSON extends TransitionPayloadJSON {
  update: AcceptedTransition["update"];
  requestDigest?: ObjectHash;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_FILE_PATCHES = 10_000;
const MAX_FILE_PATCH_EDITS = 100_000;
const MAX_FILE_PATCH_REPLACEMENT_BYTES = 64 * 1024 * 1024;
const MAX_FILE_DELTA_INSTRUCTIONS = 100_000;
const MAX_FILE_DELTA_INSERT_BYTES = 64 * 1024 * 1024;

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Object bytes must use standard padded base64");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (encodeBase64(bytes) !== value) throw new Error("Object bytes are not canonical base64");
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function decodeObjectEnvelopes(value: unknown): Array<{ hash: ObjectHash; bytes: Uint8Array }> {
  if (!Array.isArray(value)) throw new Error("Expected objects");
  const objects = new Map<ObjectHash, Uint8Array>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("Invalid object envelope");
    const record = item as { hash?: unknown; bytes?: unknown };
    if (typeof record.hash !== "string" || typeof record.bytes !== "string") throw new Error("Invalid object envelope");
    const hash = record.hash as ObjectHash;
    const bytes = decodeBase64(record.bytes);
    const existing = objects.get(hash);
    if (existing && !bytesEqual(existing, bytes)) throw new Error(`Object ${hash} was supplied with different bytes`);
    objects.set(hash, bytes);
  }
  return [...objects].map(([hash, bytes]) => ({ hash, bytes }));
}

export function encodeObjectEnvelopes(objects: Iterable<readonly [ObjectHash, Uint8Array]>): ObjectEnvelopeJSON[] {
  return [...objects].map(([hash, bytes]) => ({ hash, bytes: encodeBase64(bytes) }));
}

export function decodeFilePatches(value: unknown): FilePatch[] {
  if (!Array.isArray(value)) throw new Error("filePatches must be an array");
  if (value.length > MAX_FILE_PATCHES) throw new Error("filePatches exceeds the patch quota");
  const results = new Set<ObjectHash>();
  let editCount = 0;
  let replacementBytes = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid file patch");
    const record = item as { base?: unknown; result?: unknown; edits?: unknown };
    if (typeof record.base !== "string" || !HASH.test(record.base)
      || typeof record.result !== "string" || !HASH.test(record.result)
      || !Array.isArray(record.edits) || record.edits.length === 0) {
      throw new Error("Invalid file patch");
    }
    const result = record.result as ObjectHash;
    if (results.has(result)) throw new Error(`Duplicate file patch result: ${result}`);
    results.add(result);
    editCount += record.edits.length;
    if (editCount > MAX_FILE_PATCH_EDITS) throw new Error("filePatches exceeds the edit quota");
    let previousEnd = 0;
    const edits = record.edits.map((edit) => {
      if (!edit || typeof edit !== "object") throw new Error("Invalid file patch edit");
      const value = edit as { offset?: unknown; length?: unknown; bytes?: unknown };
      if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0
        || !Number.isSafeInteger(value.length) || (value.length as number) < 0
        || typeof value.bytes !== "string") throw new Error("Invalid file patch edit");
      const offset = value.offset as number;
      const length = value.length as number;
      const end = offset + length;
      if (!Number.isSafeInteger(end) || offset < previousEnd) throw new Error("File patch edits overlap or overflow");
      previousEnd = end;
      const bytes = decodeBase64(value.bytes);
      replacementBytes += bytes.byteLength;
      if (replacementBytes > MAX_FILE_PATCH_REPLACEMENT_BYTES) {
        throw new Error("filePatches exceeds the replacement-byte quota");
      }
      return { offset, length, bytes };
    });
    return { base: record.base as ObjectHash, result, edits };
  });
}

export function decodeFileDeltas(value: unknown): FileDelta[] {
  if (!Array.isArray(value)) throw new Error("fileDeltas must be an array");
  if (value.length > MAX_FILE_PATCHES) throw new Error("fileDeltas exceeds the delta quota");
  const results = new Set<ObjectHash>();
  let instructionCount = 0;
  let insertedBytes = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid file delta");
    const record = item as { base?: unknown; result?: unknown; instructions?: unknown };
    if (typeof record.base !== "string" || !HASH.test(record.base)
      || typeof record.result !== "string" || !HASH.test(record.result)
      || !Array.isArray(record.instructions) || record.instructions.length === 0) {
      throw new Error("Invalid file delta");
    }
    const result = record.result as ObjectHash;
    if (results.has(result)) throw new Error(`Duplicate file delta result: ${result}`);
    results.add(result);
    instructionCount += record.instructions.length;
    if (instructionCount > MAX_FILE_DELTA_INSTRUCTIONS) throw new Error("fileDeltas exceeds the instruction quota");
    const instructions = record.instructions.map((instruction) => {
      if (!instruction || typeof instruction !== "object") throw new Error("Invalid file delta instruction");
      const value = instruction as { copy?: unknown; insert?: unknown };
      if ((value.copy === undefined) === (value.insert === undefined)) throw new Error("File delta instruction requires exactly one operation");
      if (value.copy !== undefined) {
        if (!value.copy || typeof value.copy !== "object") throw new Error("Invalid file delta copy");
        const copy = value.copy as { offset?: unknown; length?: unknown };
        if (!Number.isSafeInteger(copy.offset) || (copy.offset as number) < 0
          || !Number.isSafeInteger(copy.length) || (copy.length as number) <= 0
          || !Number.isSafeInteger((copy.offset as number) + (copy.length as number))) {
          throw new Error("Invalid file delta copy");
        }
        return { copy: { offset: copy.offset as number, length: copy.length as number } };
      }
      if (typeof value.insert !== "string") throw new Error("Invalid file delta insert");
      const insert = decodeBase64(value.insert);
      if (insert.byteLength === 0) throw new Error("File delta insert is empty");
      insertedBytes += insert.byteLength;
      if (insertedBytes > MAX_FILE_DELTA_INSERT_BYTES) throw new Error("fileDeltas exceeds the insert-byte quota");
      return { insert };
    });
    return { base: record.base as ObjectHash, result, instructions };
  });
}

export function decodeTransitionPayloadJSON(value: unknown): AcceptedTransitionPayload {
  if (!value || typeof value !== "object") throw new Error("Transition payload must be an object");
  const record = value as { objects?: unknown; filePatches?: unknown; fileDeltas?: unknown };
  const objects = decodeObjectEnvelopes(record.objects);
  const filePatches = record.filePatches === undefined ? undefined : decodeFilePatches(record.filePatches);
  const fileDeltas = record.fileDeltas === undefined ? undefined : decodeFileDeltas(record.fileDeltas);
  const results = new Set(objects.map(({ hash }) => hash));
  for (const result of [...(filePatches ?? []), ...(fileDeltas ?? [])].map(({ result }) => result)) {
    if (results.has(result)) throw new Error(`Transition result supplied more than once: ${result}`);
    results.add(result);
  }
  return {
    objects,
    ...(filePatches?.length ? { filePatches } : {}),
    ...(fileDeltas?.length ? { fileDeltas } : {}),
  };
}

export function encodeTransitionPayloadJSON(payload: AcceptedTransitionPayload): TransitionPayloadJSON {
  return {
    objects: payload.objects.map(({ hash, bytes }) => ({ hash, bytes: encodeBase64(bytes) })),
    ...(payload.filePatches?.length ? { filePatches: payload.filePatches.map((patch) => ({
      base: patch.base,
      result: patch.result,
      edits: patch.edits.map((edit) => ({ offset: edit.offset, length: edit.length, bytes: encodeBase64(edit.bytes) })),
    })) } : {}),
    ...(payload.fileDeltas?.length ? { fileDeltas: payload.fileDeltas.map((delta) => ({
      base: delta.base,
      result: delta.result,
      instructions: delta.instructions.map((instruction) => "copy" in instruction
        ? { copy: instruction.copy }
        : { insert: encodeBase64(instruction.insert) }),
    })) } : {}),
  };
}

export function encodeAcceptedTransitionJSON(transition: AcceptedTransition): AcceptedTransitionJSON {
  return {
    update: transition.update,
    ...encodeTransitionPayloadJSON(transition),
    ...(transition.requestDigest ? { requestDigest: transition.requestDigest } : {}),
  };
}

export function decodeUpdateRequestJSON(value: unknown): UpdateRequest {
  if (!value || typeof value !== "object") throw new Error("Update body must be a JSON object");
  const body = value as { base?: unknown; candidate?: unknown; objects?: unknown; filePatches?: unknown; returnSnapshot?: unknown };
  const base = body.base as { root?: unknown; update?: unknown } | null;
  if (!base || typeof base.root !== "string" || typeof base.update !== "string" || typeof body.candidate !== "string") {
    throw new Error("Update requires base root/update and candidate root");
  }
  if (body.returnSnapshot !== undefined && body.returnSnapshot !== true && body.returnSnapshot !== "if-result-differs") {
    throw new Error('returnSnapshot must be true or "if-result-differs" when present');
  }
  const objects = decodeObjectEnvelopes(body.objects);
  const filePatches = body.filePatches === undefined ? undefined : decodeFilePatches(body.filePatches);
  if (filePatches) {
    const objectHashes = new Set(objects.map(({ hash }) => hash));
    for (const patch of filePatches) {
      if (objectHashes.has(patch.result)) throw new Error(`File patch result also supplied as a complete object: ${patch.result}`);
    }
  }
  return {
    base: { root: base.root, update: base.update },
    candidate: body.candidate,
    objects,
    ...(filePatches ? { filePatches } : {}),
    ...(body.returnSnapshot ? { returnSnapshot: body.returnSnapshot } : {}),
  };
}

export function encodeUpdateRequestJSON(request: UpdateRequest): UpdateRequestJSON {
  return {
    base: request.base,
    candidate: request.candidate,
    objects: request.objects.map(({ hash, bytes }) => ({ hash, bytes: encodeBase64(bytes) })),
    ...(request.filePatches ? { filePatches: request.filePatches.map((patch) => ({
      base: patch.base,
      result: patch.result,
      edits: patch.edits.map((edit) => ({ offset: edit.offset, length: edit.length, bytes: encodeBase64(edit.bytes) })),
    })) } : {}),
    ...(request.returnSnapshot ? { returnSnapshot: request.returnSnapshot } : {}),
  };
}
