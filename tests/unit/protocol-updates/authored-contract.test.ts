import { describe, expect, test } from "bun:test";
import { decodeUpdateRequestJSON } from "../../../packages/protocol/src/updates/json.ts";
import vectors from "../../../conformance/protocol-authored-updates.json";
import { authoredRequestIdentities, decodeAuthoredRequestIntent } from "../../../packages/protocol/src/updates/authored-contract.ts";

describe("target authored update contract", () => {
  for (const c of vectors.cases) test(c.name, () => {
    if (!c.valid) { expect(() => decodeAuthoredRequestIntent(c.value)).toThrow(); return; }
    const request = decodeAuthoredRequestIntent(c.value);
    expect(JSON.parse(JSON.stringify(request))).toEqual(c.value);
    expect(authoredRequestIdentities(vectors.tree, request).map(x => ({digest:String(x.digest), canonicalCBORBase64:Buffer.from(x.bytes).toString("base64")}))).toEqual(c.identities!);
  });
  test("deployed decoder cannot silently drop target resolution declarations", () => {
    const target = vectors.cases[4]!.value;
    expect(() => decodeUpdateRequestJSON({...target, updates:target.updates.map(u => ({...u, ifMatch:"modelHash", objects:[], deltas:[]}))})).toThrow();
  });
  test("resolution and exact-state guards bind identity; prefixes remain stable", () => {
    const request = decodeAuthoredRequestIntent(structuredClone(vectors.cases[14]!.value));
    const full = authoredRequestIdentities(vectors.tree, request);
    expect(authoredRequestIdentities(vectors.tree, {...request,updates:request.updates.slice(0,1)})[0]!.digest).toBe(full[0]!.digest);
    request.updates[0]!.ifCurrent = "another-state";
    expect(authoredRequestIdentities(vectors.tree,request)[0]!.digest).not.toBe(full[0]!.digest);
    expect(authoredRequestIdentities(vectors.tree,request)[1]!.digest).not.toBe(full[1]!.digest);
    const resolution = decodeAuthoredRequestIntent(structuredClone(vectors.cases[4]!.value));
    const before=authoredRequestIdentities(vectors.tree,resolution)[0]!.digest;
    resolution.updates[0]!.resolves[0]!.state="new-review";
    expect(authoredRequestIdentities(vectors.tree,resolution)[0]!.digest).not.toBe(before);
  });
});
