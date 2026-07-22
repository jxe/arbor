import { sha256 as digest } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function sha256(value: string | Uint8Array): string {
  return bytesToHex(digest(typeof value === "string" ? new TextEncoder().encode(value) : value));
}

export function revisionOf(value: string | Uint8Array): string {
  return `sha256:${sha256(value)}`;
}
