import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import transport from "../../../docs/overstory-spec/conformance/protocol-authored-transport.json";
import semantics from "../../../docs/overstory-spec/conformance/protocol-authored-updates.json";
import { decodeUpdateRequestJSON, encodeUpdateRequestJSON } from "../../../packages/protocol/src/updates/json.ts";
import { updateRequestIdentities } from "../../../packages/protocol/src/updates/intent.ts";
import { applyObjectDelta } from "../../../packages/protocol/src/updates/apply.ts";
import { decodeObjectEnvelopes, verifyTreeSnapshotGraph } from "../../../packages/protocol/src/updates/json.ts";

for (const c of transport.cases) test(`authored transport: ${c.name}`, () => {
  if (!c.valid) { expect(() => decodeUpdateRequestJSON(c.value)).toThrow(); return; }
  const request = decodeUpdateRequestJSON(c.value);
  expect<unknown>(encodeUpdateRequestJSON(request)).toEqual(c.value);
  expect(updateRequestIdentities(transport.tree, request).map(x => ({digest:String(x.digest),canonicalCBORBase64:Buffer.from(x.bytes).toString("base64")}))).toEqual(c.identities!);
});
for (const c of semantics.cases) test(`authored transport preserves semantic grammar: ${c.name}`, () => {
  const raw = { ...c.value, updates: c.value.updates.map(u => ({...u,objects:[],deltas:[]})) };
  if (!c.valid) { expect(() => decodeUpdateRequestJSON(raw)).toThrow(); return; }
  const request = decodeUpdateRequestJSON(raw);
  expect(updateRequestIdentities(semantics.tree, request).map(x => ({digest:String(x.digest),canonicalCBORBase64:Buffer.from(x.bytes).toString("base64")}))).toEqual(c.identities!);
});
test("complete and sparse requests reconstruct the same exact candidate with the same digest", () => {
  const complete = decodeUpdateRequestJSON(transport.cases[0]!.value);
  const sparse = decodeUpdateRequestJSON(transport.cases[1]!.value);
  const basis = new Map(decodeObjectEnvelopes(transport.basis.objects).map(x => [x.hash,x.bytes]));
  const update = sparse.updates[0]!;
  const objects = new Map(update.objects.map(x => [x.hash,x.bytes]));
  for (const delta of update.deltas) objects.set(delta.result, applyObjectDelta(basis.get(delta.base)!,delta));
  const graph = verifyTreeSnapshotGraph({root:update.candidate,objects});
  expect(graph.objects).toEqual(new Map(complete.updates[0]!.objects.map(x => [x.hash,x.bytes])));
  expect(updateRequestIdentities(transport.tree,complete)[0]!.digest).toBe(updateRequestIdentities(transport.tree,sparse)[0]!.digest);
});
test("serialized request survives restart and append without rewriting the transmitted prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(),"story-authored-request-"));
  try {
    const path = join(directory,"pending.json");
    const full = decodeUpdateRequestJSON(transport.cases[5]!.value);
    const prefix = {...full,updates:full.updates.slice(0,1)};
    const original = JSON.stringify(encodeUpdateRequestJSON(prefix));
    const digest = updateRequestIdentities(transport.tree,prefix)[0]!.digest;
    await writeFile(path,original);
    const restored = decodeUpdateRequestJSON(JSON.parse(await readFile(path,"utf8")));
    restored.updates.push(full.updates[1]!);
    expect(updateRequestIdentities(transport.tree,restored)[0]!.digest).toBe(digest);
    expect(JSON.stringify(encodeUpdateRequestJSON({...restored,updates:restored.updates.slice(0,1)}))).toBe(original);
    await writeFile(path,JSON.stringify(encodeUpdateRequestJSON(restored)));
    expect(updateRequestIdentities(transport.tree,decodeUpdateRequestJSON(JSON.parse(await readFile(path,"utf8"))))).toEqual(updateRequestIdentities(transport.tree,full));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test("in-process builders cannot encode invalid transport or activation guards", () => {
  const value = decodeUpdateRequestJSON(transport.cases[0]!.value);
  value.updates[0]!.objects[0]!.bytes = new Uint8Array([0]);
  expect(() => encodeUpdateRequestJSON(value)).toThrow();
  const activation = decodeUpdateRequestJSON(transport.cases[3]!.value);
  activation.updates[0]!.ifCurrent = "old-state";
  expect(() => encodeUpdateRequestJSON(activation)).toThrow();
});
