import { expect, test } from "bun:test";
import fixtures from "../../../conformance/wire-authored-transport.json";
import oldIntent from "../../../conformance/wire-update-intent.json";
import deltas from "../../../conformance/wire-object-deltas.json";
import { decodeObjectDeltas, decodeUpdateRequestJSON, encodeUpdateRequestJSON, updateRequestDigest, updateRequestDigests } from "@arbor/wire";

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
    {operations:[{key:"undo",kind:"undoOperation" as const,target:{change:"prior",operation:"edit"}}]},
  ]) expect(updateRequestDigest(fixtures.tree,{...intent,...patch})).not.toBe(original);
  expect(updateRequestDigest("another-tree",intent)).not.toBe(original);
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
