import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { deviceSessionChallengeBytes, validateDeviceSessionChallenge, type DeviceSession } from "../model/device-keys.ts";
import { ProtocolClient } from "../transport.ts";

/**
 * An installation's own device key (accounts §5): an Ed25519 seed kept in
 * operating-system credential storage, whose public half is the `key` of its
 * `devices.yaml` entry. Local clients never hold it; they get sessions.
 */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX_LENGTH = 12;

function privateKey(seed: string) {
  const bytes = Buffer.from(seed, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== seed) throw new Error("Device key seed must be 32 bytes of unpadded base64url");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes]), format: "der", type: "pkcs8" });
}

export function generateDeviceKeySeed(): string {
  return randomBytes(32).toString("base64url");
}

/** The `devices.yaml` spelling of a seed's public key. */
export function deviceKeyFromSeed(seed: string): string {
  // Node derives the public half from a PKCS#8 private key; Bun's declarations omit that input.
  const spki = createPublicKey(privateKey(seed) as never).export({ format: "der", type: "spki" });
  return `ed25519:${Buffer.from(spki).subarray(SPKI_PREFIX_LENGTH).toString("base64url")}`;
}

/**
 * Open a session at `origin` for `device` of `profileTree`: ask for a
 * challenge, check it names exactly that host, profile and device, and sign
 * its canonical bytes.
 */
export async function openDeviceSession(origin: string, profileTree: string, device: string, seed: string): Promise<DeviceSession> {
  const host = new ProtocolClient(origin);
  const challenge = validateDeviceSessionChallenge(await host.createDeviceSessionChallenge({ profileTree, device }));
  if (challenge.origin !== new URL(origin).origin || challenge.profileTree !== profileTree || challenge.device !== device) {
    throw new Error("The host's session challenge names another host, profile or device");
  }
  const signature = sign(null, deviceSessionChallengeBytes(challenge), privateKey(seed)).toString("base64url");
  const session = await host.openDeviceSession(challenge, signature);
  if (session.device !== device || typeof session.token !== "string" || !Number.isSafeInteger(session.expiresAt)) {
    throw new Error("The host opened a session for another device");
  }
  return session;
}
