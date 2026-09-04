import { describe, expect, test } from "bun:test";
import { accountChallengeBytes, isPersonProfileTreeID, personProfileTreeID } from "@arbor/core";

const ZERO_KEY_PROFILE = "tr_2pnrfg7hncrmqbeojpqt7qzhcf67ofz3vlqse6aw46sr3kxlvsiq";

describe("person profile identity", () => {
  test("derives the full base32 SHA-256 TreeID", () => {
    expect(personProfileTreeID(new Uint8Array(32))).toBe(ZERO_KEY_PROFILE);
    expect(isPersonProfileTreeID(ZERO_KEY_PROFILE)).toBe(true);
    expect(isPersonProfileTreeID("tr_aaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(() => personProfileTreeID(new Uint8Array(31))).toThrow("32 bytes");
  });

  test("canonically encodes every signed challenge field", () => {
    const challenge = {
      version: 1 as const,
      id: "ax_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      origin: "https://arb.example",
      account: "https://arb.example/~joe",
      profileTree: ZERO_KEY_PROFILE,
      configurationTree: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      issuedAt: 1,
      expiresAt: 2,
    };
    const first = Buffer.from(accountChallengeBytes(challenge));
    const second = Buffer.from(accountChallengeBytes({ ...challenge }));
    expect(first.equals(second)).toBe(true);
    expect(first.toString("hex")).toStartWith("a9626964");
    expect(Buffer.from(accountChallengeBytes({ ...challenge, account: "https://arb.example/~mariana" })).equals(first)).toBe(false);
  });
});
