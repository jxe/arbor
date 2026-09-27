import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { accountChallengeBytes, personProfileTreeID, ProtocolClient, validateAccountChallenge, type AccountChallenge } from "@overstory/protocol";
import fixtures from "../../docs/overstory-spec/conformance/protocol-account-challenges.json";

test("community, exact account, invitation and placement requests retain their signed account target", async () => {
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
  expect(fixtures.cases.find((c) => c.name === "placement")?.response.homeHost).toBe("https://home.example");
});

test("a home challenge and a placement challenge sign different bytes, and neither signature stands in for the other", () => {
  const { signing } = fixtures;
  const publicKey = Buffer.from(signing.publicKey, "base64url");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), format: "der", type: "spki" });
  const [home, placement] = signing.challenges as Array<{ name: string; challenge: AccountChallenge; canonicalCBORHex: string; signature: string }>;
  expect(home!.name).toBe("home");
  expect(placement!.name).toBe("placement");
  expect(personProfileTreeID(publicKey)).toBe(home!.challenge.profileTree);
  expect(placement!.challenge).toEqual({ ...home!.challenge, homeHost: placement!.challenge.homeHost! });
  for (const entry of [home!, placement!]) {
    expect(Buffer.from(accountChallengeBytes(entry.challenge)).toString("hex")).toBe(entry.canonicalCBORHex);
    expect(verify(null, Buffer.from(entry.canonicalCBORHex, "hex"), key, Buffer.from(entry.signature, "base64url"))).toBe(true);
  }
  expect(home!.canonicalCBORHex).not.toBe(placement!.canonicalCBORHex);
  expect(verify(null, Buffer.from(placement!.canonicalCBORHex, "hex"), key, Buffer.from(home!.signature, "base64url"))).toBe(false);
  expect(verify(null, Buffer.from(home!.canonicalCBORHex, "hex"), key, Buffer.from(placement!.signature, "base64url"))).toBe(false);
  // A challenge naming its own origin as the home host is malformed.
  expect(() => validateAccountChallenge({ ...placement!.challenge, homeHost: placement!.challenge.origin })).toThrow("Malformed account challenge");
});
