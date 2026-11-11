import { encodeCanonicalCBOR } from "./cbor.ts";
import { isGeneratedOverstoryID, isPersonProfileTreeID } from "./identity.ts";
import { treeConfigurationID } from "../config/tree-config.ts";
import { isHomeHostOrigin } from "./resource-policy.ts";

/** What a profile key signs to join a community (accounts §1.2, federation §3):
 * `account` claims the address as the profile's home, `placement` makes it a
 * member whose home is `profile`, its canonical locator elsewhere. */
export interface AccountChallenge {
  version: 1;
  purpose: "account" | "placement";
  id: string;
  origin: string;
  account: string;
  profileTree: string;
  configurationTree: string;
  /** Only on a placement's challenge: the profile's canonical locator at its home host. */
  profile?: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

const ACCOUNT_CHALLENGE_KEYS = ["version", "purpose", "id", "origin", "account", "profileTree", "configurationTree", "nonce", "issuedAt", "expiresAt"];

export { isHomeHostOrigin };

export function validateAccountChallenge(value: unknown): AccountChallenge {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed account challenge");
  const challenge = value as Partial<AccountChallenge>;
  const keys = challenge.purpose === "placement" ? [...ACCOUNT_CHALLENGE_KEYS, "profile"] : ACCOUNT_CHALLENGE_KEYS;
  const present = Object.keys(challenge);
  if (
    present.length !== keys.length || !keys.every((key) => present.includes(key))
    || challenge.version !== 1
    || (challenge.purpose !== "account" && challenge.purpose !== "placement")
    || (challenge.purpose === "placement" && typeof challenge.profile !== "string")
    || typeof challenge.id !== "string" || !isGeneratedOverstoryID(challenge.id, "ax")
    || typeof challenge.origin !== "string"
    || typeof challenge.account !== "string"
    || typeof challenge.profileTree !== "string" || !isPersonProfileTreeID(challenge.profileTree)
    || typeof challenge.configurationTree !== "string" || challenge.configurationTree !== treeConfigurationID(challenge.profileTree)
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

/** Exact bytes signed by a person profile key when claiming a host account. */
export function accountChallengeBytes(challenge: AccountChallenge): Uint8Array {
  return encodeCanonicalCBOR(validateAccountChallenge(challenge));
}
