import { encodeCanonicalCBOR } from "./cbor.ts";
import { isGeneratedArborID } from "./identity.ts";

/**
 * A key device's public key as `devices.yaml` spells it: an algorithm tag and
 * the raw public key in unpadded base64url. `ed25519` keys are 32 bytes;
 * `p256` keys are 33-byte compressed SEC1 points, signing with ECDSA over
 * SHA-256 as the 64-byte concatenation of `r` and `s`.
 */
export type DeviceKeyAlgorithm = "ed25519" | "p256";

export interface DeviceKey {
  algorithm: DeviceKeyAlgorithm;
  publicKey: Uint8Array;
}

const KEY_LENGTHS: Record<DeviceKeyAlgorithm, number> = { ed25519: 32, p256: 33 };
/** DER SubjectPublicKeyInfo prefixes; the raw key follows. */
const SPKI_PREFIXES: Record<DeviceKeyAlgorithm, string> = {
  ed25519: "302a300506032b6570032100",
  p256: "3039301306072a8648ce3d020106082a8648ce3d030107032200",
};

function base64urlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); } catch { return null; }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return base64url(bytes) === value ? bytes : null;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Parse a `key` value; throws unless it is canonical. */
export function parseDeviceKey(value: string): DeviceKey {
  const match = /^(ed25519|p256):(.+)$/.exec(value);
  const algorithm = match?.[1] as DeviceKeyAlgorithm | undefined;
  const publicKey = match ? base64urlBytes(match[2]!) : null;
  if (!algorithm || !publicKey || publicKey.byteLength !== KEY_LENGTHS[algorithm]) throw new Error(`Malformed device key: ${value}`);
  if (algorithm === "p256" && publicKey[0] !== 2 && publicKey[0] !== 3) throw new Error(`Malformed device key: ${value}`);
  return { algorithm, publicKey };
}

export function isDeviceKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { parseDeviceKey(value); return true; } catch { return false; }
}

export function formatDeviceKey(key: DeviceKey): string {
  return `${key.algorithm}:${base64url(key.publicKey)}`;
}

/** The key's DER SubjectPublicKeyInfo, which verifiers load. A `p256` key
 * stays compressed; OpenSSL and CryptoKit both accept that form. */
export function deviceKeySPKI(value: string): Uint8Array {
  const key = parseDeviceKey(value);
  const prefix = SPKI_PREFIXES[key.algorithm];
  const bytes = new Uint8Array(prefix.length / 2 + key.publicKey.byteLength);
  for (let index = 0; index < prefix.length / 2; index++) bytes[index] = Number.parseInt(prefix.slice(index * 2, index * 2 + 2), 16);
  bytes.set(key.publicKey, prefix.length / 2);
  return bytes;
}

/** Whether a signature has the shape its key's algorithm produces: 64 bytes,
 * unpadded base64url, for both algorithms. */
export function deviceSignatureBytes(signature: string): Uint8Array {
  const bytes = base64urlBytes(signature);
  if (!bytes || bytes.byteLength !== 64) throw new Error("Malformed device signature");
  return bytes;
}

function nonceIsValid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function timesAreValid(issuedAt: unknown, expiresAt: unknown): boolean {
  return typeof issuedAt === "number" && Number.isSafeInteger(issuedAt)
    && typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > issuedAt;
}

function originIsCanonical(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).origin === value; } catch { return false; }
}

function exactKeys(value: object, keys: string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

/** What a key device signs to open a session at `origin` (accounts §5.1). */
export interface DeviceSessionChallenge {
  version: 1;
  purpose: "device-session";
  id: string;
  origin: string;
  profileTree: string;
  device: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function validateDeviceSessionChallenge(value: unknown): DeviceSessionChallenge {
  const fail = () => new Error("Malformed device session challenge");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const challenge = value as Partial<DeviceSessionChallenge>;
  if (
    !exactKeys(challenge, ["version", "purpose", "id", "origin", "profileTree", "device", "nonce", "issuedAt", "expiresAt"])
    || challenge.version !== 1 || challenge.purpose !== "device-session"
    || typeof challenge.id !== "string" || !isGeneratedArborID(challenge.id, "ax")
    || !originIsCanonical(challenge.origin)
    // Any person profile, including one whose TreeID predates self-certifying IDs.
    || typeof challenge.profileTree !== "string" || !/^tr_[a-z2-7]+$/.test(challenge.profileTree)
    || typeof challenge.device !== "string" || !/^dv_[a-z2-7]+$/.test(challenge.device)
    || !nonceIsValid(challenge.nonce) || !timesAreValid(challenge.issuedAt, challenge.expiresAt)
  ) throw fail();
  return challenge as DeviceSessionChallenge;
}

/** Exact bytes a key device signs to open a session. */
export function deviceSessionChallengeBytes(challenge: DeviceSessionChallenge): Uint8Array {
  return encodeCanonicalCBOR(validateDeviceSessionChallenge(challenge));
}

/** A session a key device opened; `token` is a bearer credential for one host. */
export interface DeviceSession {
  token: string;
  device: string;
  expiresAt: number;
}

/** One entry of a home host's published device keys (accounts §5.4). */
export interface PublishedDeviceKey {
  id: string;
  key: string;
  administrator: boolean;
}

export interface PublishedDeviceKeys {
  profileTree: string;
  devices: PublishedDeviceKey[];
}

/** A home host's published device keys for `profileTree`, checked before
 * anyone trusts any of it: the profile it names, and each entry's DeviceID,
 * key and administrator flag. */
export function decodePublishedDeviceKeys(value: unknown, profileTree: string): PublishedDeviceKeys {
  const body = value as Partial<PublishedDeviceKeys> | null;
  if (!body || body.profileTree !== profileTree || !Array.isArray(body.devices)) throw new Error("The home host's device keys name another profile");
  const devices = body.devices.map((entry): PublishedDeviceKey => {
    if (!entry || typeof entry.id !== "string" || !isGeneratedArborID(entry.id, "dv") || typeof entry.key !== "string" || typeof entry.administrator !== "boolean") {
      throw new Error("The home host's device keys are malformed");
    }
    parseDeviceKey(entry.key);
    return { id: entry.id, key: entry.key, administrator: entry.administrator };
  });
  return { profileTree, devices };
}
