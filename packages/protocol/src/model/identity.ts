import { sha256 } from "./hash.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += BASE32[(value << (5 - bits)) & 31];
  return result;
}

/** Generate a 128-bit lowercase base32 Arbor identity with the supplied stable prefix. */
export function generateArborID(prefix: "tr" | "dv" | "ac" | "pa" | "pp" | "ax" | "up" | "ob"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${encodeBase32(bytes)}`;
}

export function isGeneratedArborID(value: string, prefix: "tr" | "dv" | "pp" | "ax"): boolean {
  return new RegExp(`^${prefix}_[a-z2-7]{26}$`).test(value);
}

const PERSON_PROFILE_DOMAIN = new TextEncoder().encode("arbor-person-profile-v1\0");

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** Derive the public self-certifying TreeID for a raw 32-byte Ed25519 public key. */
export function personProfileTreeID(publicKey: Uint8Array): string {
  if (publicKey.byteLength !== 32) throw new Error("A person profile public key must be 32 bytes");
  const input = new Uint8Array(PERSON_PROFILE_DOMAIN.byteLength + publicKey.byteLength);
  input.set(PERSON_PROFILE_DOMAIN);
  input.set(publicKey, PERSON_PROFILE_DOMAIN.byteLength);
  return `tr_${encodeBase32(hexBytes(sha256(input)))}`;
}

export function isPersonProfileTreeID(value: string): boolean {
  return /^tr_[a-z2-7]{52}$/.test(value);
}
