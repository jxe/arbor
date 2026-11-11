import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { accountChallengeBytes, personProfileTreeID, ProtocolClient, validateAccountChallenge, type AccountChallenge } from "@ovst/protocol";
import fixtures from "../../docs/overstory-spec/conformance/protocol-account-challenges.json";

test("community, exact account and invitation requests retain their signed account target", async () => {
  for (const fixture of fixtures.cases) {
    let request: unknown;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(input) {
      request = await input.json();
      return Response.json(fixture.response, { status: 201 });
    } });
    try {
      const { purpose: _purpose, ...input } = fixture.request as typeof fixture.request & { purpose: string };
      const challenge = await new ProtocolClient(server.url.toString().replace(/\/$/, "")).createAccountChallenge(input);
      expect(request).toEqual(fixture.request);
      expect(challenge).toEqual(fixture.response as unknown as AccountChallenge);
    } finally { server.stop(true); }
  }
});

test("a challenge's signature covers its canonical CBOR, purpose included", () => {
  const { signing } = fixtures;
  const publicKey = Buffer.from(signing.publicKey, "base64url");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), format: "der", type: "spki" });
  const challenges = signing.challenges as Array<{ name: string; challenge: AccountChallenge; canonicalCBORHex: string; signature: string }>;
  expect(challenges.map((c) => c.name)).toEqual(["home", "placement"]);
  for (const signed of challenges) {
    expect(personProfileTreeID(publicKey)).toBe(signed.challenge.profileTree);
    expect(Buffer.from(accountChallengeBytes(signed.challenge)).toString("hex")).toBe(signed.canonicalCBORHex);
    expect(verify(null, Buffer.from(signed.canonicalCBORHex, "hex"), key, Buffer.from(signed.signature, "base64url"))).toBe(true);
  }
  const [home, placement] = challenges;
  // The purpose decides what a challenge binds: only a placement's names a profile.
  expect(() => validateAccountChallenge({ ...home!.challenge, profile: placement!.challenge.profile })).toThrow("Malformed account challenge");
  const { profile: _profile, ...unnamed } = placement!.challenge;
  expect(() => validateAccountChallenge(unnamed)).toThrow("Malformed account challenge");
  const { purpose: _purpose, ...purposeless } = home!.challenge;
  expect(() => validateAccountChallenge(purposeless)).toThrow("Malformed account challenge");
  expect(() => validateAccountChallenge({ ...home!.challenge, homeHost: "https://home.example" })).toThrow("Malformed account challenge");
});
