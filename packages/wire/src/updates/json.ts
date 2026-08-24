import type { ObjectHash } from "../objects.ts";
import type { UpdateRequest } from "./types.ts";

export interface ObjectEnvelopeJSON {
  hash: ObjectHash;
  bytes: string;
}

export interface UpdateRequestJSON {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: ObjectEnvelopeJSON[];
  returnSnapshot?: boolean;
}

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

export function decodeUpdateRequestJSON(value: unknown): UpdateRequest {
  if (!value || typeof value !== "object") throw new Error("Update body must be a JSON object");
  const body = value as { base?: unknown; candidate?: unknown; objects?: unknown; returnSnapshot?: unknown };
  const base = body.base as { root?: unknown; update?: unknown } | null;
  if (!base || typeof base.root !== "string" || typeof base.update !== "string" || typeof body.candidate !== "string") {
    throw new Error("Update requires base root/update and candidate root");
  }
  if (body.returnSnapshot !== undefined && typeof body.returnSnapshot !== "boolean") {
    throw new Error("returnSnapshot must be boolean when present");
  }
  return {
    base: { root: base.root, update: base.update },
    candidate: body.candidate,
    objects: decodeObjectEnvelopes(body.objects),
    ...(body.returnSnapshot === true ? { returnSnapshot: true } : {}),
  };
}

export function encodeUpdateRequestJSON(request: UpdateRequest): UpdateRequestJSON {
  return {
    base: request.base,
    candidate: request.candidate,
    objects: request.objects.map(({ hash, bytes }) => ({ hash, bytes: encodeBase64(bytes) })),
    ...(request.returnSnapshot ? { returnSnapshot: true } : {}),
  };
}
