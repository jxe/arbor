import { sha256 as digest } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function sha256(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  // Bun's native SHA-256 avoids repeatedly hashing large retained objects in JS.
  // Browsers and other runtimes retain the same portable implementation.
  if (typeof Bun !== "undefined") return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return bytesToHex(digest(bytes));
}

export function revisionOf(value: string | Uint8Array): string {
  return `sha256:${sha256(value)}`;
}
