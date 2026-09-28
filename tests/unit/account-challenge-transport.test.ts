import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { accountChallengeBytes, personProfileTreeID, ProtocolClient, validateAccountChallenge, type AccountChallenge } from "@overstory/protocol";
import fixtures from "../../docs/overstory-spec/conformance/protocol-account-challenges.json";

test("community, exact account and invitation requests retain their signed account target", async () => {
  for (const fixture of fixtures.cases) {
    let request: unknown;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(input) {
      request = await input.json();
      return Response.json(fixture.response, { status: 201 });
    } });
    try {
      const challenge = await new ProtocolClient(server.url.toString().replace(/\/$/, "")).createAccountChallenge(fixture.request);
      expect(request).toEqual(fixture.request);
      expect(challenge).toEqual({ ...fixture.response, version: 1 });
    } finally { server.stop(true); }
  }
});

test("a challenge's signature covers its canonical CBOR, and a challenge naming a home host is refused", () => {
  const { signing } = fixtures;
  const publicKey = Buffer.from(signing.publicKey, "base64url");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), format: "der", type: "spki" });
  const [home] = signing.challenges as Array<{ name: string; challenge: AccountChallenge; canonicalCBORHex: string; signature: string }>;
  expect(home!.name).toBe("home");
  expect(personProfileTreeID(publicKey)).toBe(home!.challenge.profileTree);
  expect(Buffer.from(accountChallengeBytes(home!.challenge)).toString("hex")).toBe(home!.canonicalCBORHex);
  expect(verify(null, Buffer.from(home!.canonicalCBORHex, "hex"), key, Buffer.from(home!.signature, "base64url"))).toBe(true);
  // Placement accounts come from reservations (accounts §1.3); the withdrawn
  // placement challenge named a home host.
  expect(() => validateAccountChallenge({ ...home!.challenge, homeHost: "https://home.example" })).toThrow("Malformed account challenge");
});
