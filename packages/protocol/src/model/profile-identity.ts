import { encodeCanonicalCBOR } from "./cbor.ts";
import { isGeneratedArborID, isPersonProfileTreeID } from "./identity.ts";
import { treeConfigurationID } from "../config/tree-config.ts";

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
  /**
   * A placement claim's home host (accounts §1.3): the origin whose published
   * device keys the placement host will trust for this profile. The profile
   * key signs it with the rest of the challenge; it is never `origin`.
   */
  homeHost?: string;
}

/** Whether `value` is an origin a placement host may read device keys from:
 * HTTPS, or plain HTTP on a loopback address for local hosts. */
export function isHomeHostOrigin(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== value) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
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
  if (challenge.homeHost !== undefined
    && (typeof challenge.homeHost !== "string" || !isHomeHostOrigin(challenge.homeHost) || challenge.homeHost === challenge.origin)) {
    throw new Error("Malformed account challenge");
  }
  return challenge as AccountChallenge;
}

/** Exact bytes signed by a person profile key when claiming a Canopy account. */
export function accountChallengeBytes(challenge: AccountChallenge): Uint8Array {
  return encodeCanonicalCBOR(validateAccountChallenge(challenge));
}
