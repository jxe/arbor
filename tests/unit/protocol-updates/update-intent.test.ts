import { expect, test } from "bun:test";
import fixtures from "../../../docs/overstory-spec/conformance/protocol-authored-transport.json";
import oldIntent from "../../../docs/overstory-spec/conformance/protocol-update-intent.json";
import deltas from "../../../docs/overstory-spec/conformance/protocol-object-deltas.json";
import { decodeObjectDeltas, decodeUpdateRequestJSON, encodeUpdateRequestJSON, updateRequestDigest, updateRequestDigests } from "@overstory/protocol";

for (const c of fixtures.cases) test(`active transport: ${c.name}`, () => {
  if (!c.valid) { expect(() => decodeUpdateRequestJSON(c.value)).toThrow(); return; }
  const request = decodeUpdateRequestJSON(c.value);
  expect<unknown>(encodeUpdateRequestJSON(request)).toEqual(c.value);
  expect(updateRequestDigests(fixtures.tree,request)).toEqual(c.identities!.map(x => x.digest));
});
test("every authored field and the tree bind the active digest", () => {
  const request = decodeUpdateRequestJSON(fixtures.cases[0]!.value);
  const intent = {...request.updates[0]!,base:request.base};
  const original = updateRequestDigest(fixtures.tree,intent);
  for (const patch of [
    {change:"other-change"}, {candidate:fixtures.basis.root}, {base:"other-base"},
    {ifCurrent:"same-root-different-accepted-state"},
    {resolves:[{state:"reviewed",conflict:"d",alternatives:["a","b"]}]},
    {trace:[frame(fixtures.basis.root,intent.candidate,"first","Mon")]},
  ]) expect(updateRequestDigest(fixtures.tree,{...intent,...patch})).not.toBe(original);
  expect(updateRequestDigest("another-tree",intent)).not.toBe(original);
});
const other = "sha256:" + "a".repeat(64);
function frame(before: string, after: string, key: string, text: string) {
  return {before,after,operations:[{key,kind:"editSource" as const,
    source:{material:{kind:"basis" as const,path:"/page.md",object:before},range:[0,0] as [number,number]},text}]};
}
test("every frame's before, after and operations bind the digest", () => {
  const request = decodeUpdateRequestJSON(fixtures.cases[0]!.value);
  const candidate = request.updates[0]!.candidate;
  const trace = [frame(fixtures.basis.root,other,"first","Mon"), frame(other,candidate,"second","Tue")];
  const intent = {...request.updates[0]!,base:request.base,trace};
  const original = updateRequestDigest(fixtures.tree,intent);
  // Each frame is evidence in its own right, so no field of any frame — nor the
  // number of frames — can change without changing what the change claims.
  for (const variant of [
    [frame(other,other,"first","Mon"), trace[1]!],
    [{...trace[0]!,after:candidate}, trace[1]!],
    [frame(fixtures.basis.root,other,"first","Tue"), trace[1]!],
    [trace[0]!, frame(other,candidate,"renamed","Tue")],
    [trace[0]!, {...trace[1]!,before:candidate}],
    [{...trace[0]!,operations:[...trace[0]!.operations,...trace[1]!.operations]}, trace[1]!],
    [{...trace[0]!,after:candidate}],
  ]) expect(updateRequestDigest(fixtures.tree,{...intent,trace:variant})).not.toBe(original);
  // The same operations in one frame are a different claim from two.
  expect(updateRequestDigest(fixtures.tree,{...intent,trace:[
    {before:fixtures.basis.root,after:candidate,operations:[...trace[0]!.operations,...trace[1]!.operations]},
  ]})).not.toBe(original);
  expect(updateRequestDigest(fixtures.tree,{...intent,trace:null})).not.toBe(original);
  expect(updateRequestDigest(fixtures.tree,{...intent,trace:[]})).not.toBe(original);
});
test("active prefix identities survive appending and repacking transport", () => {
  const full = decodeUpdateRequestJSON(fixtures.cases[5]!.value);
  const digests = updateRequestDigests(fixtures.tree,full);
  expect(updateRequestDigests(fixtures.tree,{...full,updates:full.updates.slice(0,1)})).toEqual(digests.slice(0,1));
  const complete = decodeUpdateRequestJSON(fixtures.cases[0]!.value);
  const sparse = decodeUpdateRequestJSON(fixtures.cases[1]!.value);
  expect(updateRequestDigests(fixtures.tree,complete)).toEqual(updateRequestDigests(fixtures.tree,sparse));
});
test("old request intent is rejected without rewriting its identity", () => {
  const {tree: _tree,base,canonicalCBORBase64: _bytes,digest: _digest,...update} = oldIntent.identity;
  const body = {base,updates:[{...update,objects:[],deltas:[]}]};
  const original = JSON.stringify(body);
  expect(() => decodeUpdateRequestJSON(body)).toThrow();
  expect(JSON.stringify(body)).toBe(original);
});
test("shared invalid deltas remain invalid independent of authored grammar", () => {
  expect(decodeObjectDeltas([deltas.valid])).toHaveLength(1);
  for (const c of deltas.invalid) expect(() => decodeObjectDeltas(c.deltas),c.name).toThrow();
});
