import { sha256 } from "@arbor/core";
import { ProtocolError } from "./protocol-error.ts";

/** Opaque continuation cursor bound to its route's complete query. */
export function encodePageCursor(key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ key: sha256(key), offset })).toString("base64url");
}

export function decodePageCursor(cursor: string | null | undefined, key: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { key?: string; offset?: number };
    if (value.key !== sha256(key) || !Number.isSafeInteger(value.offset) || value.offset! < 0) throw new Error();
    return value.offset!;
  } catch {
    throw new ProtocolError("invalid-reference", "The page cursor does not belong to this query", 400);
  }
}
