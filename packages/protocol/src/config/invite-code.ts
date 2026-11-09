import { randomBytes } from "node:crypto";
import { sha256 } from "../model/hash.ts";

/**
 * An invitation code (accounts §1.2): 16 random bytes in unpadded base64url.
 * The code is the secret in a join link (`#overstory-invite=<code>`); the
 * community's root `_index.md` keeps only its digest, in a `members` entry of
 * exactly `handle` and `inviteDigest`. The host never holds the code.
 */
const INVITE_CODE = /^[A-Za-z0-9_-]{22}$/;

export function generateInviteCode(): string {
  return randomBytes(16).toString("base64url");
}

export function isInviteCode(value: string): boolean {
  return INVITE_CODE.test(value);
}

/** The digest a well-formed invitation code is reserved under: `sha256:` and
 * the hex SHA-256 of the code's text. */
export function inviteCodeDigest(code: string): string {
  if (!isInviteCode(code)) throw new Error("Invitation code is invalid");
  return `sha256:${sha256(code)}`;
}
