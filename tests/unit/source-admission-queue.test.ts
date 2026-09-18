import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSourceAdmission, SourceAdmissionQueue, type SourceAdmissionRecord } from "@arbor/canopy-client";
import { decodeTreeSnapshotJSON, encodeWireDirectory, hashObject, type TreeSnapshot } from "@arbor/wire";
import { executeExactSourceEdits } from "../../packages/canopy/src/updates/source-edits.ts";
import { decodeCandidateUpdateJSON } from "@arbor/wire";

const fixture = JSON.parse(await readFile(new URL("../../conformance/source-admission-queue.json", import.meta.url), "utf8"));
function initial(): TreeSnapshot {
  const file = new TextEncoder().encode(fixture.source), hash = hashObject(file);
  const nested = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file: hash }] }), directory = hashObject(nested);
  const root = encodeWireDirectory({ type: "directory", entries: [{ name: "nested", directory }] });
  return { root: hashObject(root), objects: new Map([[hash, file], [directory, nested], [hashObject(root), root]]) };
}
function records(): Array<ReturnType<typeof prepareSourceAdmission>> {
  const result: Array<ReturnType<typeof prepareSourceAdmission>> = [];
  for (const change of fixture.changes) {
    const parent = result.find(r => r.change === change.basis.change), graph = parent ? decodeTreeSnapshotJSON(parent.candidate) : initial();
    const source = parent?.intent?.source ?? fixture.source;
    const bytes = Buffer.from(source), candidate = Buffer.concat([bytes.subarray(0, change.offset), Buffer.from(change.replacement), bytes.subarray(change.offset + change.length)]).toString();
    result.push(prepareSourceAdmission({ change: change.change, tree: fixture.tree, graph, sourcePath: fixture.sourcePath,
      basis: parent ? change.basis : { ...change.basis, root: graph.root },
      intent: { basis: { tree: fixture.tree, path: "/nested/note", revision: change.revision, source },
        edits: [{ offset: change.offset, length: change.length, expected: change.expected, replacement: change.replacement }], source: candidate } }));
  }
  return result;
}
async function withQueue(body: (q: SourceAdmissionQueue, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "arbor-source-queue-"));
  try { await body(new SourceAdmissionQueue(fixture.tree, root), root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("shared source queue preserves dependency identity, exact candidate bytes and restart", async () => withQueue(async (q, root) => {
  const all = records();
  for (const record of all) await q.retain(record);
  expect(all[0]!.candidate.root).toBe(all[1]!.candidate.root);
  expect(all[0]!.candidate.root).toBe(all[2]!.candidate.root);
  const reopened = new SourceAdmissionQueue(fixture.tree, root);
  expect(await reopened.retained()).toEqual(all);
  await reopened.retain(all[0]!);
  expect((await reopened.retained()).length).toBe(3);
  for (const record of all) {
    const prepared = await reopened.request(record.change);
    expect(prepared.request).toEqual(fixture.requests[record.change]);
    // Independent server execution checks that client-generated operations explain every byte.
    const update = decodeCandidateUpdateJSON(record.update), graph = decodeTreeSnapshotJSON(record.graph);
    const executed = await executeExactSourceEdits(graph.root, update.operations!, async hash => graph.objects.get(hash)!);
    expect(executed.root).toBe(record.candidate.root);
  }
  expect((await reopened.request("change-b")).request.updates.map(u => u.change)).toEqual(["change-a", "change-b"]);
  expect((await reopened.request("change-c")).base.update).toBe("up_r2");
}));

test("missing parents, altered candidates, wrong trees and reused identities cannot modify the journal", async () => withQueue(async q => {
  const [a, b, c] = records();
  await expect(q.retain(b!)).rejects.toThrow();
  expect(await q.retained()).toEqual([]);
  await q.retain(a!);
  await expect(q.retain({ ...a!, update: c!.update })).rejects.toThrow();
  await expect(q.retain({ ...c!, tree: "tr_other" })).rejects.toThrow();
  await expect(q.retain({ ...c!, candidate: a!.graph })).rejects.toThrow();
  expect(await q.retained()).toEqual([a!]);
}));

test("two queue instances serialize retention and corrupt restart never rewrites recovery evidence", async () => withQueue(async (q, root) => {
  const [a, , c] = records(), other = new SourceAdmissionQueue(fixture.tree, root);
  await Promise.all([q.retain(a!), other.retain(c!)]);
  expect((await q.retained()).length).toBe(2);
  const corrupt = '[{"change":"broken"}]';
  await writeFile(q.path, corrupt);
  await expect(other.retained()).rejects.toThrow();
  await expect(other.retain(a!)).rejects.toThrow();
  expect(await readFile(q.path, "utf8")).toBe(corrupt);
}));

test("disk failure cannot acknowledge an admission or erase its captured graph", async () => withQueue(async (q, root) => {
  const [a] = records();
  await writeFile(join(root, "sync"), "blocked directory");
  await expect(q.retain(a!)).rejects.toThrow();
  await rm(join(root, "sync"));
  await q.retain(a!);
  expect(await q.retained()).toEqual([a!]);
}));

test("exact source guards reject split scalars, forged bases and boundary traversal", async () => withQueue(async q => {
  const [a] = records(), graph = initial();
  expect(() => prepareSourceAdmission({ ...a!, graph, intent: { ...a!.intent,
    edits: [{ offset: 8, length: 0, replacement: "" }], source: fixture.source } })).toThrow("scalar");
  expect(() => prepareSourceAdmission({ ...a!, graph, sourcePath: "/nested/../note.md" })).toThrow("path");
  expect(() => prepareSourceAdmission({ ...a!, graph, intent: { ...a!.intent,
    basis: { ...a!.intent.basis, source: "Forged source" } } })).toThrow();
  await expect(q.retain({ ...a!, basis: { kind: "accepted", root: a!.candidate.root, update: "up_r1" } })).rejects.toThrow("basis");
  expect(await q.retained()).toEqual([]);
}));

test("prepared records round-trip optional guards and reject unrepresentable replacement text", async () => withQueue(async q => {
  const [a] = records();
  const record = prepareSourceAdmission({ ...a!, change: "unguarded", graph: initial(),
    intent: { ...a!.intent, edits: a!.intent.edits.map(e => ({ ...e, expected: undefined })) } });
  await q.retain(record);
  await q.retain(record);
  expect(await q.retained()).toEqual([record]);
  expect(() => prepareSourceAdmission({ ...a!, graph: initial(), intent: { ...a!.intent,
    edits: [{ offset: 0, length: Buffer.byteLength(fixture.source), replacement: "\ud800" }], source: "\ufffd" } })).toThrow("intent");
}));

test("first directory-body save retains an exact snapshot without inventing source material", async () => withQueue(async q => {
  const bytes = encodeWireDirectory({ type: "directory", entries: [] }), root = hashObject(bytes);
  const graph = { root, objects: new Map([[root, bytes]]) };
  const record = prepareSourceAdmission({ tree: fixture.tree, graph, basis: { kind: "accepted", root, update: "empty" }, sourcePath: "/_index.md",
    intent: { basis: { tree: fixture.tree, path: "/", revision: "empty-body", source: "" }, source: "Exact\r\n", edits: [{ offset: 0, length: 0, replacement: "Exact\r\n" }] } });
  expect(record.update.operations).toBeNull();
  await q.retain(record);
  expect((await q.retained())[0]).toEqual(record);
  expect(decodeTreeSnapshotJSON(record.candidate).objects.has(hashObject(Buffer.from("Exact\r\n")))).toBe(true);
}));

test("journal references platform objects and compacts only dependency-free settlements", async () => withQueue(async (_q, root) => {
  const note = Buffer.from(fixture.source), noteHash = hashObject(note), asset = Buffer.alloc(1_000_000, 0x5a), assetHash = hashObject(asset);
  const nested = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file: noteHash }] }), nestedHash = hashObject(nested);
  const rootBytes = encodeWireDirectory({ type: "directory", entries: [{ name: "asset.bin", file: assetHash }, { name: "nested", directory: nestedHash }] });
  const initialGraph: TreeSnapshot = { root: hashObject(rootBytes), objects: new Map([[assetHash, asset], [noteHash, note], [nestedHash, nested], [hashObject(rootBytes), rootBytes]]) };
  const platform = { bytes: async (hash: string) => initialGraph.objects.get(hash) };
  const q = new SourceAdmissionQueue(fixture.tree, root, platform);
  let graph = initialGraph;
  const all: SourceAdmissionRecord[] = [];
  for (const change of fixture.changes) {
    const parent = all.find(record => record.change === change.basis.change), source = parent?.intent?.source ?? fixture.source;
    graph = parent ? decodeTreeSnapshotJSON(parent.candidate) : initialGraph;
    const candidate = Buffer.concat([Buffer.from(source).subarray(0, change.offset), Buffer.from(change.replacement), Buffer.from(source).subarray(change.offset + change.length)]).toString();
    all.push(prepareSourceAdmission({ change: change.change, tree: fixture.tree, graph, sourcePath: fixture.sourcePath,
      basis: parent ? change.basis : { ...change.basis, root: graph.root }, intent: { basis: { tree: fixture.tree, path: "/nested/note", revision: change.revision, source },
        edits: [{ offset: change.offset, length: change.length, expected: change.expected, replacement: change.replacement }], source: candidate } }));
  }
  for (const record of all) await q.retain(record);
  expect((await stat(q.path)).size).toBeLessThan(100_000);
  expect(await readFile(q.path, "utf8")).not.toContain('"bytes"');
  await expect(stat(join(q.objectsPath, assetHash.slice("sha256:".length)))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await new SourceAdmissionQueue(fixture.tree, root, platform).retained()).toEqual(all);
  await q.compact(new Set([all[0]!.change, all[1]!.change]));
  expect((await q.retained()).map(record => record.change)).toEqual([all[2]!.change]);
  expect(await q.compact(new Set([all[2]!.change]), false)).toBe(true);
  expect(await q.retained()).toEqual([]);
  expect(await readdir(q.objectsPath)).toEqual([]);
}));

test("fully settled embedded-object journals upgrade directly to an empty hash journal", async () => withQueue(async (q, root) => {
  const all = records();
  await mkdir(join(root, "sync"), { recursive: true });
  await writeFile(q.path, JSON.stringify(all));
  const legacySize = (await stat(q.path)).size;
  expect(await q.compact(new Set(all.map(record => record.change)), false)).toBe(true);
  expect((await stat(q.path)).size).toBeLessThan(legacySize);
  expect(JSON.parse(await readFile(q.path, "utf8"))).toMatchObject({ schema: 2, tree: fixture.tree, records: [] });
}));

test("pending legacy migration remains self-contained when its old platform basis is gone", async () => withQueue(async (q, root) => {
  const all = records();
  await mkdir(join(root, "sync"), { recursive: true });
  await writeFile(q.path, JSON.stringify(all));
  const unavailable = { bytes: async (_hash: string) => undefined };
  const migrated = new SourceAdmissionQueue(fixture.tree, root, unavailable);
  expect(await migrated.retained()).toEqual(all);
  expect(await new SourceAdmissionQueue(fixture.tree, root, unavailable).retained()).toEqual(all);
}));

test("source preservation fixtures retain verified lineage across queue restart", async () => {
  const data=JSON.parse(await readFile(new URL("../../conformance/source-preservation.json",import.meta.url),"utf8"));
  for(const value of data.cases) await withQueue(async (queue,root) => {
    const bytes=Buffer.from(value.source),file=hashObject(bytes),directory=encodeWireDirectory({type:"directory",entries:[{name:"note.md",file}]});
    const graph={root:hashObject(directory),objects:new Map([[file,bytes],[hashObject(directory),directory]])};
    const prepare=()=>prepareSourceAdmission({tree:fixture.tree,graph,basis:{kind:"accepted",root:graph.root,update:"basis"},sourcePath:"/note.md",intent:{basis:{tree:fixture.tree,path:"/note",revision:"revision",source:value.source},source:value.replacement,edits:[{offset:0,length:bytes.length,replacement:value.replacement,lineage:value.lineage}]}});
    if(!value.valid){expect(prepare).toThrow();return;}
    const record=prepare();await queue.retain(record);
    const reopened=new SourceAdmissionQueue(fixture.tree,root);
    expect(await reopened.retained()).toEqual([record]);
    const operation=decodeCandidateUpdateJSON(record.update).operations![0]!;
    expect(operation.kind).toBe("editSource");
    if(operation.kind==="editSource")expect(operation.lineage?.map(l=>({source:l.source.range,replacement:l.range}))).toEqual(value.lineage);
  });
});

test("explicit entry moves and copies retain different intent through restart", async () => {
  const {prepareEntryAdmission}=await import("@arbor/canopy-client");
  const graph=initial();
  for(const kind of ["moveEntry","copyEntry"] as const) await withQueue(async(queue,root)=>{
    const record=prepareEntryAdmission({tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"entry-basis"},graph,entryTransfer:{kind,source:"/nested/note.md",parent:"/",name:"moved.md"}});
    await queue.retain(record);
    expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
    expect(decodeCandidateUpdateJSON(record.update).operations?.[0]?.kind).toBe(kind);
    const {MergeTool}=await import("../../packages/canopy/src/merge-tool.ts");
    const tool=new MergeTool(root),candidate=decodeTreeSnapshotJSON(record.candidate);
    const evaluated=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,operations:decodeCandidateUpdateJSON(record.update).operations!},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
    expect(evaluated.response.result.object).toBe(candidate.root);
    expect(()=>prepareEntryAdmission({tree:fixture.tree,basis:record.basis,graph,entryTransfer:{kind,source:"/nested",parent:"/nested",name:"loop"}})).toThrow();
  });
});

test("copy metadata edits bind to operation output and survive recovery", async () => withQueue(async(queue,root)=>{
  const {prepareEntryAdmission,prepareEntryTransfer}=await import("@arbor/canopy-client");
  const graph=initial(),entryTransfer={kind:"copyEntry" as const,source:"/nested/note.md",parent:"/",name:"copy.md"};
  const pure=prepareEntryTransfer(graph,entryTransfer).candidate;
  const bytes=Buffer.from("New page identity\r\n"),file=hashObject(bytes);
  const {decodeWireDirectory}=await import("@arbor/wire");
  const directory=decodeWireDirectory(pure.objects.get(pure.root)!);directory.entries.find(e=>e.name==="copy.md")!.file=file;
  const encoded=encodeWireDirectory(directory),candidate={root:hashObject(encoded),objects:new Map([...pure.objects,[file,bytes],[hashObject(encoded),encoded]])};
  const record=prepareEntryAdmission({tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"basis"},graph,candidate,entryTransfer:{...entryTransfer,rewrites:{"":file}}});
  await queue.retain(record);expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
  const operations=decodeCandidateUpdateJSON(record.update).operations!;
  expect(operations.map(op=>op.kind)).toEqual(["copyEntry","editSource"]);
  const {MergeTool}=await import("../../packages/canopy/src/merge-tool.ts");
  const evaluated=await new MergeTool(root).evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,operations},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
  expect(evaluated.response.result.object).toBe(candidate.root);
}));

test("compound entry fixtures retain one basis and execute atomically after restart",async()=>{
  const fixtures=await Bun.file(new URL("../../conformance/entry-actions.json",import.meta.url)).json();
  const {prepareEntryAdmission}=await import("@arbor/canopy-client");
  const {MergeTool}=await import("../../packages/canopy/src/merge-tool.ts");
  for(const value of fixtures.cases)await withQueue(async(queue,root)=>{
    const graph=decodeTreeSnapshotJSON(fixtures.graph);
    const record=prepareEntryAdmission({change:fixtures.change,tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"basis"},graph,entryActions:value.actions});
    expect(record.candidate).toEqual(value.candidate);
    expect(decodeCandidateUpdateJSON(record.update).operations).toEqual(value.operations);
    await queue.retain(record);expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
    const candidate=decodeTreeSnapshotJSON(record.candidate);
    const evaluated=await new MergeTool(root).evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,operations:value.operations},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
    expect(evaluated.response.result.object).toBe(candidate.root);
    expect(()=>prepareEntryAdmission({tree:fixture.tree,basis:record.basis,graph,entryActions:{transfers:[],removals:["/pair","/pair/child.md"]}})).toThrow();
  });
});

test("compound move transports a concurrent child edit without changing the sibling body",async()=>withQueue(async(_queue,root)=>{
  const fixtures=await Bun.file(new URL("../../conformance/entry-actions.json",import.meta.url)).json();
  const {prepareEntryAdmission}=await import("@arbor/canopy-client");
  const {MergeTool}=await import("../../packages/canopy/src/merge-tool.ts");
  const {decodeWireDirectory}=await import("@arbor/wire");
  const graph=decodeTreeSnapshotJSON(fixtures.graph),basis={kind:"accepted" as const,root:graph.root,update:"basis"};
  const source="child é\r\n",text="Peer child é\r\n";
  const peer=prepareSourceAdmission({tree:fixture.tree,basis,graph,sourcePath:"/pair/child.md",intent:{basis:{tree:fixture.tree,path:"/pair/child",revision:"r",source},edits:[{offset:0,length:0,replacement:"Peer "}],source:text}});
  const move=prepareEntryAdmission({tree:fixture.tree,basis,graph,entryActions:fixtures.cases[0].actions});
  const current=decodeTreeSnapshotJSON(peer.candidate),incoming=decodeTreeSnapshotJSON(move.candidate);
  const objects=new Map([...graph.objects,...current.objects,...incoming.objects]);
  const tool=new MergeTool(root);
  const accepted=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:peer.change,object:current.root,operations:decodeCandidateUpdateJSON(peer.update).operations!},rules:{id:"tree-default",revision:1}},objects);
  for(const [hash,bytes] of accepted.objects)objects.set(hash,bytes);
  const result=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:accepted.response.result,incoming:{change:move.change,object:incoming.root,operations:decodeCandidateUpdateJSON(move.update).operations!},rules:{id:"tree-default",revision:1}},objects);
  for(const [hash,bytes] of result.objects)objects.set(hash,bytes);
  let hash=result.response.result.object;
  for(const part of ["archive","moved","child.md"]){const entry=decodeWireDirectory(objects.get(hash)!).entries.find(e=>e.name===part)!;hash=(entry.file??entry.directory)!;}
  expect(Buffer.from(objects.get(hash)!).toString()).toBe(text);
  const rootEntries=decodeWireDirectory(objects.get(result.response.result.object)!).entries;
  const archive=rootEntries.find(e=>e.name==="archive")!.directory!;
  const body=decodeWireDirectory(objects.get(archive)!).entries.find(e=>e.name==="moved.md")!.file;
  const originalBody=decodeWireDirectory(graph.objects.get(graph.root)!).entries.find(e=>e.name==="pair.md")!.file;
  expect(body).toBe(originalBody);
}));

test("explicit source copies validate, survive recovery, and execute through the merge process",async()=>{
  const fixtures=await Bun.file(new URL("../../conformance/source-copy.json",import.meta.url)).json();
  for(const c of fixtures.cases)await withQueue(async(queue,root)=>{
    const bytes=Buffer.from(c.source),file=hashObject(bytes),directory=encodeWireDirectory({type:"directory",entries:[{name:"note.md",file}]});
    const graph={root:hashObject(directory),objects:new Map([[file,bytes],[hashObject(directory),directory]])};
    const prepare=()=>prepareSourceAdmission({tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"basis"},graph,sourcePath:"/note.md",intent:{basis:{tree:fixture.tree,path:"/note",revision:"r",source:c.source},edits:[{offset:0,length:bytes.length,replacement:c.replacement,copies:c.copies,...(c.lineage?{lineage:c.lineage}:{})}],source:c.replacement}});
    if(!c.valid){expect(prepare).toThrow();return;}
    const record=prepare();await queue.retain(record);expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
    const {MergeTool}=await import("../../packages/canopy/src/merge-tool.ts");
    const candidate=decodeTreeSnapshotJSON(record.candidate),operations=decodeCandidateUpdateJSON(record.update).operations!;
    expect(operations.filter(o=>o.kind==="copySource").length).toBe(c.copies.length);
    const evaluated=await new MergeTool(root).evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,operations},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
    expect(evaluated.response.result.object).toBe(candidate.root);
  });
});

test.each(["note.txt","note.md"])("source copy keeps a concurrent source edit under the %s merge policy",async(name)=>withQueue(async(_queue,root)=>{
  const source="abc\n\n",bytes=Buffer.from(source),file=hashObject(bytes),directory=encodeWireDirectory({type:"directory",entries:[{name,file}]});
  const graph={root:hashObject(directory),objects:new Map([[file,bytes],[hashObject(directory),directory]])},basis={kind:"accepted" as const,root:hashObject(directory),update:"basis"};
  const base={tree:fixture.tree,path:"/note",revision:"r",source};
  const copy=prepareSourceAdmission({tree:fixture.tree,basis,graph,sourcePath:"/"+name,intent:{basis:base,edits:[{offset:0,length:5,replacement:source+source,lineage:[{source:[0,5],replacement:[0,5]}],copies:[{source:[0,5],replacement:[5,10]}]}],source:source+source}});
  const peer=prepareSourceAdmission({tree:fixture.tree,basis,graph,sourcePath:"/"+name,intent:{basis:base,edits:[{offset:0,length:1,replacement:"X"}],source:"Xbc\n\n"}});
  const {MergeTool}=await import("../../packages/canopy/src/merge-tool.ts");
  const tool=new MergeTool(root),current=decodeTreeSnapshotJSON(peer.candidate),incoming=decodeTreeSnapshotJSON(copy.candidate);
  const objects=new Map([...graph.objects,...current.objects,...incoming.objects]),rules={id:"tree-default",revision:1 as const};
  const accepted=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:peer.change,object:current.root,operations:decodeCandidateUpdateJSON(peer.update).operations!},rules},objects);
  for(const [hash,bytes] of accepted.objects)objects.set(hash,bytes);
  const result=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:accepted.response.result,incoming:{change:copy.change,object:incoming.root,operations:decodeCandidateUpdateJSON(copy.update).operations!},rules},objects);
  for(const [hash,bytes] of result.objects)objects.set(hash,bytes);
  const {decodeWireDirectory}=await import("@arbor/wire");
  const hash=decodeWireDirectory(objects.get(result.response.result.object)!).entries[0]!.file!;
  if(!("decisions" in result.response))throw Error("Expected evaluated intent response");
  if(name.endsWith(".txt")) {
    expect(result.response.decisions).toEqual([]);
    expect(Buffer.from(objects.get(hash)!).toString()).toBe("Xbc\n\nabc\n\n");
  } else {
    // The deployed Markdown policy reviews changed host structure. Both inputs
    // remain accepted evidence; client capture does not bypass format policy.
    expect(result.response.decisions.length).toBeGreaterThan(0);
    const alternatives=result.response.decisions.flatMap(d=>"alternatives" in d ? d.alternatives.map(a=>a.object) : []);
    expect(alternatives).toContain(current.root);
    expect(alternatives).toContain(incoming.root);
  }
}));
