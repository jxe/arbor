import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  deviceKeySPKI,
  deviceSessionChallengeBytes,
  deviceSignatureBytes,
  parseDeviceKey,
  personProfileTreeID,
  profileResetChallengeBytes,
  validateDeviceSessionChallenge,
  validateProfileResetChallenge,
  type DeviceSessionChallenge,
  type ProfileResetChallenge,
} from "@overstory/protocol";
import vectors from "../../docs/overstory-spec/conformance/device-keys.json";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const publicKey = (key: string) => createPublicKey({ key: Buffer.from(deviceKeySPKI(key)), format: "der", type: "spki" });
function verifies(key: string, message: Uint8Array, signature: string): boolean {
  const bytes = Buffer.from(deviceSignatureBytes(signature));
  return parseDeviceKey(key).algorithm === "ed25519"
    ? verify(null, message, publicKey(key), bytes)
    : verify("sha256", message, { key: publicKey(key), dsaEncoding: "ieee-p1363" }, bytes);
}
const ed25519Private = (seedHex: string) => createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8",
});

describe("device-keys.json", () => {
  test("parses each valid key to its DER public key", () => {
    for (const vector of vectors.keys.valid) expect(hex(deviceKeySPKI(vector.key)), vector.name).toBe(vector.spkiHex);
  });

  test("rejects each invalid key", () => {
    for (const vector of vectors.keys.invalid) expect(() => parseDeviceKey(vector.key), vector.name).toThrow();
  });

  test("encodes session challenges exactly and verifies their signatures", () => {
    for (const vector of vectors.sessionChallenges) {
      const bytes = deviceSessionChallengeBytes(vector.challenge as DeviceSessionChallenge);
      expect(hex(bytes), vector.name).toBe(vector.cborHex);
      expect(verifies(vector.key, bytes, vector.signature), vector.name).toBe(true);
      expect(verifies(vector.key, bytes, vector.tamperedSignature), vector.name).toBe(false);
      if (vector.deterministic) expect(sign(null, bytes, ed25519Private(vector.seedHex!)).toString("base64url")).toBe(vector.signature);
    }
  });

  test("rejects each malformed session challenge", () => {
    for (const vector of vectors.invalidSessionChallenges) expect(() => validateDeviceSessionChallenge(vector.challenge), vector.name).toThrow();
  });

  test("encodes reset challenges exactly and verifies the profile key's signature", () => {
    for (const vector of vectors.resetChallenges) {
      const challenge = vector.challenge as ProfileResetChallenge;
      const bytes = profileResetChallengeBytes(challenge);
      expect(hex(bytes), vector.name).toBe(vector.cborHex);
      expect(personProfileTreeID(Buffer.from(vector.profilePublicKey, "base64url"))).toBe(challenge.profileTree);
      expect(verifies(`ed25519:${vector.profilePublicKey}`, bytes, vector.signature)).toBe(true);
      expect(sign(null, bytes, ed25519Private(vector.profileSeedHex)).toString("base64url")).toBe(vector.signature);
    }
  });

  test("rejects each malformed reset challenge", () => {
    for (const vector of vectors.invalidResetChallenges) expect(() => validateProfileResetChallenge(vector.challenge), vector.name).toThrow();
  });

  test("a session challenge never validates as a reset challenge", () => {
    const session = vectors.sessionChallenges[0]!.challenge;
    expect(() => validateProfileResetChallenge(session)).toThrow();
    expect(() => validateDeviceSessionChallenge(vectors.resetChallenges[0]!.challenge)).toThrow();
  });
});
