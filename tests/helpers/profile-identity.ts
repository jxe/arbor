import { generateKeyPairSync, sign } from "node:crypto";
import { accountChallengeBytes, personProfileTreeID, type AccountChallenge } from "@arbor/core";

export interface TestProfileIdentity {
  profileTree: string;
  publicKey: string;
  sign(challenge: AccountChallenge): string;
}

export function testProfileIdentity(): TestProfileIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const raw = der.subarray(Buffer.from("302a300506032b6570032100", "hex").byteLength);
  return {
    profileTree: personProfileTreeID(raw),
    publicKey: raw.toString("base64url"),
    sign: (challenge) => sign(null, accountChallengeBytes(challenge), privateKey).toString("base64url"),
  };
}
