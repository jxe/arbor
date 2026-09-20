import { encodeCanonicalCBOR } from "./cbor.ts";
import { isGeneratedArborID, isPersonProfileTreeID } from "./identity.ts";

export interface AccountChallenge {
  version: 1;
  id: string;
  origin: string;
  account: string;
  profileTree: string;
  configurationTree: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function validateAccountChallenge(value: unknown): AccountChallenge {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed account challenge");
  const challenge = value as Partial<AccountChallenge>;
  if (
    challenge.version !== 1
    || typeof challenge.id !== "string" || !isGeneratedArborID(challenge.id, "ax")
    || typeof challenge.origin !== "string"
    || typeof challenge.account !== "string"
    || typeof challenge.profileTree !== "string" || !isPersonProfileTreeID(challenge.profileTree)
    || typeof challenge.configurationTree !== "string" || !isGeneratedArborID(challenge.configurationTree, "tr")
    || typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)
    || typeof challenge.issuedAt !== "number" || !Number.isSafeInteger(challenge.issuedAt)
    || typeof challenge.expiresAt !== "number" || !Number.isSafeInteger(challenge.expiresAt)
    || challenge.expiresAt <= challenge.issuedAt
  ) throw new Error("Malformed account challenge");
  let account: URL;
  let origin: URL;
  try {
    account = new URL(challenge.account);
    origin = new URL(challenge.origin);
  } catch { throw new Error("Malformed account challenge"); }
  if (origin.origin !== challenge.origin || account.origin !== challenge.origin) {
    throw new Error("Malformed account challenge");
  }
  return challenge as AccountChallenge;
}

/** Exact bytes signed by a person profile key when claiming a Canopy account. */
export function accountChallengeBytes(challenge: AccountChallenge): Uint8Array {
  return encodeCanonicalCBOR(validateAccountChallenge(challenge));
}
