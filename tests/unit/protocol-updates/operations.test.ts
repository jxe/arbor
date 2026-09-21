import { expect, test } from "bun:test";
import fixtures from "../../../docs/overstory-spec/conformance/protocol-authored-updates.json";
import { canonicalUpdateIntent, decodeUpdateRequestJSON, encodeUpdateRequestJSON, updateRequestDigest, updateRequestDigests } from "@overstory/protocol";
import type { UpdateIntentBase } from "@overstory/protocol";

for (const fixture of fixtures.cases) test(`active authored grammar: ${fixture.name}`, () => {
  const value = { ...fixture.value, updates: fixture.value.updates.map(u => ({...u,objects:[],deltas:[]})) };
  if (!fixture.valid) { expect(() => decodeUpdateRequestJSON(value)).toThrow(); return; }
  const request = decodeUpdateRequestJSON(value);
  expect<unknown>(encodeUpdateRequestJSON(request)).toEqual(value);
  const digests = updateRequestDigests(fixtures.tree,request);
  expect(digests).toEqual(fixture.identities!.map(x => x.digest));
  let base: UpdateIntentBase = request.base;
  for (const [i,u] of request.updates.entries()) {
    const intent = {...u,base};
    expect(updateRequestDigest(fixtures.tree,intent)).toBe(digests[i]!);
    expect(Buffer.from(canonicalUpdateIntent(fixtures.tree,intent)).toString("base64")).toBe(fixture.identities![i]!.canonicalCBORBase64);
    base = {requestDigest:digests[i]!,candidate:u.candidate};
  }
});
