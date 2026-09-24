import { expect, test } from "bun:test";
import { ProtocolClient } from "@overstory/protocol";
import fixtures from "../../docs/overstory-spec/conformance/protocol-account-challenges.json";

test("community and exact account requests retain their signed account target", async () => {
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
