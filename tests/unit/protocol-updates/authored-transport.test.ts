import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import transport from "../../../spec/conformance/protocol-authored-transport.json";
import semantics from "../../../spec/conformance/protocol-authored-updates.json";
import { authoredTransportIdentities, decodeAuthoredUpdateRequestJSON, encodeAuthoredUpdateRequestJSON } from "../../../packages/protocol/src/updates/authored-transport.ts";
import { applyObjectDelta } from "../../../packages/protocol/src/updates/apply.ts";
import { decodeObjectEnvelopes, verifyTreeSnapshotGraph } from "../../../packages/protocol/src/updates/json.ts";

for (const c of transport.cases) test(`authored transport: ${c.name}`, () => {
  if (!c.valid) { expect(() => decodeAuthoredUpdateRequestJSON(c.value)).toThrow(); return; }
  const request = decodeAuthoredUpdateRequestJSON(c.value);
  expect<unknown>(encodeAuthoredUpdateRequestJSON(request)).toEqual(c.value);
  expect(authoredTransportIdentities(transport.tree, request).map(x => ({digest:String(x.digest),canonicalCBORBase64:Buffer.from(x.bytes).toString("base64")}))).toEqual(c.identities!);
});
for (const c of semantics.cases) test(`authored transport preserves semantic grammar: ${c.name}`, () => {
  const raw = { ...c.value, updates: c.value.updates.map(u => ({...u,objects:[],deltas:[]})) };
  if (!c.valid) { expect(() => decodeAuthoredUpdateRequestJSON(raw)).toThrow(); return; }
  const request = decodeAuthoredUpdateRequestJSON(raw);
  expect(authoredTransportIdentities(semantics.tree, request).map(x => ({digest:String(x.digest),canonicalCBORBase64:Buffer.from(x.bytes).toString("base64")}))).toEqual(c.identities!);
});
test("complete and sparse requests reconstruct the same exact candidate with the same digest", () => {
  const complete = decodeAuthoredUpdateRequestJSON(transport.cases[0]!.value);
  const sparse = decodeAuthoredUpdateRequestJSON(transport.cases[1]!.value);
  const basis = new Map(decodeObjectEnvelopes(transport.basis.objects).map(x => [x.hash,x.bytes]));
  const update = sparse.updates[0]!;
  const objects = new Map(update.objects.map(x => [x.hash,x.bytes]));
  for (const delta of update.deltas) objects.set(delta.result, applyObjectDelta(basis.get(delta.base)!,delta));
  const graph = verifyTreeSnapshotGraph({root:update.candidate,objects});
  expect(graph.objects).toEqual(new Map(complete.updates[0]!.objects.map(x => [x.hash,x.bytes])));
  expect(authoredTransportIdentities(transport.tree,complete)[0]!.digest).toBe(authoredTransportIdentities(transport.tree,sparse)[0]!.digest);
});
test("serialized request survives restart and append without rewriting the transmitted prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(),"arbor-authored-request-"));
  try {
    const path = join(directory,"pending.json");
    const full = decodeAuthoredUpdateRequestJSON(transport.cases[5]!.value);
    const prefix = {...full,updates:full.updates.slice(0,1)};
    const original = JSON.stringify(encodeAuthoredUpdateRequestJSON(prefix));
    const digest = authoredTransportIdentities(transport.tree,prefix)[0]!.digest;
    await writeFile(path,original);
    const restored = decodeAuthoredUpdateRequestJSON(JSON.parse(await readFile(path,"utf8")));
    restored.updates.push(full.updates[1]!);
    expect(authoredTransportIdentities(transport.tree,restored)[0]!.digest).toBe(digest);
    expect(JSON.stringify(encodeAuthoredUpdateRequestJSON({...restored,updates:restored.updates.slice(0,1)}))).toBe(original);
    await writeFile(path,JSON.stringify(encodeAuthoredUpdateRequestJSON(restored)));
    expect(authoredTransportIdentities(transport.tree,decodeAuthoredUpdateRequestJSON(JSON.parse(await readFile(path,"utf8"))))).toEqual(authoredTransportIdentities(transport.tree,full));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test("in-process builders cannot encode invalid transport or activation guards", () => {
  const value = decodeAuthoredUpdateRequestJSON(transport.cases[0]!.value);
  value.updates[0]!.objects[0]!.bytes = new Uint8Array([0]);
  expect(() => encodeAuthoredUpdateRequestJSON(value)).toThrow();
  const activation = decodeAuthoredUpdateRequestJSON(transport.cases[3]!.value);
  activation.updates[0]!.ifCurrent = "old-state";
  expect(() => encodeAuthoredUpdateRequestJSON(activation)).toThrow();
});
