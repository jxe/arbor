import { test, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSourceAdmission, SourceAdmissionQueue, type SourceAdmissionIntent, type SourceAdmissionRecord } from "@overstory/client";
import { decodeTreeSnapshotJSON, encodeWireDirectory, hashObject, type SourceOperation, type TreeSnapshot, decodeCandidateUpdateJSON, applySourceEdits, type SourceEdit } from "@overstory/protocol";
import { executeExactSourceEdits } from "../../packages/canopyd/src/updates/source-edits.ts";
import { singleStep } from "./canopyd-merge/fixture.ts";

const fixture = JSON.parse(await readFile(new URL("../../docs/overstory-spec/conformance/source-admission-queue.json", import.meta.url), "utf8"));
/** A record's whole authored contribution, in order, across its frames. */
const authored = (update: { trace: Array<{ operations: SourceOperation[] }> | null }) =>
  (update.trace ?? []).flatMap(frame => frame.operations);
function initial(): TreeSnapshot {
  const file = new TextEncoder().encode(fixture.source), hash = hashObject(file);
  const nested = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file: hash }] }), directory = hashObject(nested);
  const root = encodeWireDirectory({ type: "directory", entries: [{ name: "nested", directory }] });
  return { root: hashObject(root), objects: new Map([[hash, file], [directory, nested], [hashObject(root), root]]) };
}
type Prepared = ReturnType<typeof prepareSourceAdmission> & { intent: SourceAdmissionIntent };
/** Records carry no sources; tests keep the captured intent beside each one,
 * non-enumerable so it never reaches the journal or equality checks. */
function withIntent(record: ReturnType<typeof prepareSourceAdmission>, intent: SourceAdmissionIntent): Prepared {
  Object.defineProperty(record, "intent", { value: intent, enumerable: false });
  return record as Prepared;
}
function records(): Prepared[] {
  const result: Prepared[] = [];
  for (const change of fixture.changes) {
    const parent = result.find(r => r.change === change.basis.change), graph = parent ? decodeTreeSnapshotJSON(parent.candidate) : initial();
    const source = parent?.intent.source ?? fixture.source;
    const bytes = Buffer.from(source), candidate = Buffer.concat([bytes.subarray(0, change.offset), Buffer.from(change.replacement), bytes.subarray(change.offset + change.length)]).toString();
    const intent: SourceAdmissionIntent = { basis: { tree: fixture.tree, path: "/nested/note", revision: change.revision, source },
      edits: [{ offset: change.offset, length: change.length, expected: change.expected, replacement: change.replacement }], source: candidate };
    result.push(withIntent(prepareSourceAdmission({ change: change.change, tree: fixture.tree, graph, sourcePath: fixture.sourcePath,
      basis: parent ? change.basis : { ...change.basis, root: graph.root }, intent }), intent));
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
    const executed = await executeExactSourceEdits(graph.root, authored(update), async hash => graph.objects.get(hash)!);
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
  expect(() => prepareSourceAdmission({ ...a!, graph, intent: a!.intent, sourcePath: "/nested/../note.md" })).toThrow("path");
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

test("first directory-body save adds the body without inventing source material", async () => withQueue(async q => {
  const bytes = encodeWireDirectory({ type: "directory", entries: [] }), root = hashObject(bytes);
  const graph = { root, objects: new Map([[root, bytes]]) };
  const record = prepareSourceAdmission({ tree: fixture.tree, graph, basis: { kind: "accepted", root, update: "empty" }, sourcePath: "/_index.md",
    intent: { basis: { tree: fixture.tree, path: "/", revision: "empty-body", source: "" }, source: "Exact\r\n", edits: [{ offset: 0, length: 0, replacement: "Exact\r\n" }] } });
  const body = hashObject(Buffer.from("Exact\r\n"));
  expect(record.update.trace).toEqual([{ before: root, after: record.update.candidate, operations: [
    { key: "add-0", kind: "addEntry", destination: { parent: { material: { kind: "basis", path: "/", object: root } }, name: "_index.md" }, value: { file: body } },
  ] }]);
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
  const all: SourceAdmissionRecord[] = [], sources = new Map<string, string>();
  for (const change of fixture.changes) {
    const parent = all.find(record => record.change === change.basis.change), source = (parent && sources.get(parent.change)) ?? fixture.source;
    graph = parent ? decodeTreeSnapshotJSON(parent.candidate) : initialGraph;
    const candidate = Buffer.concat([Buffer.from(source).subarray(0, change.offset), Buffer.from(change.replacement), Buffer.from(source).subarray(change.offset + change.length)]).toString();
    all.push(prepareSourceAdmission({ change: change.change, tree: fixture.tree, graph, sourcePath: fixture.sourcePath,
      basis: parent ? change.basis : { ...change.basis, root: graph.root }, intent: { basis: { tree: fixture.tree, path: "/nested/note", revision: change.revision, source },
        edits: [{ offset: change.offset, length: change.length, expected: change.expected, replacement: change.replacement }], source: candidate } }));
    sources.set(change.change, candidate);
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

test("source preservation fixtures retain verified lineage across queue restart", async () => {
  const data=JSON.parse(await readFile(new URL("../../docs/overstory-spec/conformance/source-preservation.json",import.meta.url),"utf8"));
  for(const value of data.cases) await withQueue(async (queue,root) => {
    const bytes=Buffer.from(value.source),file=hashObject(bytes),directory=encodeWireDirectory({type:"directory",entries:[{name:"note.md",file}]});
    const graph={root:hashObject(directory),objects:new Map([[file,bytes],[hashObject(directory),directory]])};
    const prepare=()=>prepareSourceAdmission({tree:fixture.tree,graph,basis:{kind:"accepted",root:graph.root,update:"basis"},sourcePath:"/note.md",intent:{basis:{tree:fixture.tree,path:"/note",revision:"revision",source:value.source},source:value.replacement,edits:[{offset:0,length:bytes.length,replacement:value.replacement,lineage:value.lineage}]}});
    if(!value.valid){expect(prepare).toThrow();return;}
    const record=prepare();await queue.retain(record);
    const reopened=new SourceAdmissionQueue(fixture.tree,root);
    expect(await reopened.retained()).toEqual([record]);
    const operation=authored(decodeCandidateUpdateJSON(record.update))[0]!;
    expect(operation.kind).toBe("editSource");
    if(operation.kind==="editSource")expect(operation.lineage?.map(l=>({source:l.source.range,replacement:l.range}))).toEqual(value.lineage);
  });
});

test("explicit entry moves and copies retain different intent through restart", async () => {
  const {prepareEntryAdmission}=await import("@overstory/client");
  const graph=initial();
  for(const kind of ["moveEntry","copyEntry"] as const) await withQueue(async(queue,root)=>{
    const record=prepareEntryAdmission({tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"entry-basis"},graph,entryTransfer:{kind,source:"/nested/note.md",parent:"/",name:"moved.md"}});
    await queue.retain(record);
    expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
    expect(authored(decodeCandidateUpdateJSON(record.update))[0]?.kind).toBe(kind);
    const {MergeTool}=await import("../../packages/canopyd/src/merge-tool.ts");
    const tool=new MergeTool(root),candidate=decodeTreeSnapshotJSON(record.candidate);
    const evaluated=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,trace:singleStep(graph.root,candidate.root,authored(decodeCandidateUpdateJSON(record.update)))},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
    expect(evaluated.response.result.object).toBe(candidate.root);
    expect(()=>prepareEntryAdmission({tree:fixture.tree,basis:record.basis,graph,entryTransfer:{kind,source:"/nested",parent:"/nested",name:"loop"}})).toThrow();
  });
});

test("copy metadata edits bind to operation output and survive recovery", async () => withQueue(async(queue,root)=>{
  const {prepareEntryAdmission,prepareEntryTransfer}=await import("@overstory/client");
  const graph=initial(),entryTransfer={kind:"copyEntry" as const,source:"/nested/note.md",parent:"/",name:"copy.md"};
  const pure=prepareEntryTransfer(graph,entryTransfer).candidate;
  const bytes=Buffer.from("New page identity\r\n"),file=hashObject(bytes);
  const {decodeWireDirectory}=await import("@overstory/protocol");
  const directory=decodeWireDirectory(pure.objects.get(pure.root)!);directory.entries.find(e=>e.name==="copy.md")!.file=file;
  const encoded=encodeWireDirectory(directory),candidate={root:hashObject(encoded),objects:new Map([...pure.objects,[file,bytes],[hashObject(encoded),encoded]])};
  const record=prepareEntryAdmission({tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"basis"},graph,candidate,entryTransfer:{...entryTransfer,rewrites:{"":file}}});
  await queue.retain(record);expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
  const operations=authored(decodeCandidateUpdateJSON(record.update));
  expect(operations.map(op=>op.kind)).toEqual(["copyEntry","editSource"]);
  const {MergeTool}=await import("../../packages/canopyd/src/merge-tool.ts");
  const evaluated=await new MergeTool(root).evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,trace:singleStep(graph.root,candidate.root,operations)},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
  expect(evaluated.response.result.object).toBe(candidate.root);
}));

test("compound entry fixtures retain one basis and execute atomically after restart",async()=>{
  const fixtures=await Bun.file(new URL("../../docs/overstory-spec/conformance/entry-actions.json",import.meta.url)).json();
  const {prepareEntryAdmission}=await import("@overstory/client");
  const {MergeTool}=await import("../../packages/canopyd/src/merge-tool.ts");
  for(const value of fixtures.cases)await withQueue(async(queue,root)=>{
    const graph=decodeTreeSnapshotJSON(fixtures.graph);
    const record=prepareEntryAdmission({change:fixtures.change,tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"basis"},graph,entryActions:value.actions});
    expect(record.candidate).toEqual(value.candidate);
    expect(authored(decodeCandidateUpdateJSON(record.update))).toEqual(value.operations);
    await queue.retain(record);expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
    const candidate=decodeTreeSnapshotJSON(record.candidate);
    const evaluated=await new MergeTool(root).evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,trace:singleStep(graph.root,candidate.root,value.operations)},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
    expect(evaluated.response.result.object).toBe(candidate.root);
    expect(()=>prepareEntryAdmission({tree:fixture.tree,basis:record.basis,graph,entryActions:{transfers:[],removals:["/pair","/pair/child.md"]}})).toThrow();
  });
});

test("compound move transports a concurrent child edit without changing the sibling body",async()=>withQueue(async(_queue,root)=>{
  const fixtures=await Bun.file(new URL("../../docs/overstory-spec/conformance/entry-actions.json",import.meta.url)).json();
  const {prepareEntryAdmission}=await import("@overstory/client");
  const {MergeTool}=await import("../../packages/canopyd/src/merge-tool.ts");
  const {decodeWireDirectory}=await import("@overstory/protocol");
  const graph=decodeTreeSnapshotJSON(fixtures.graph),basis={kind:"accepted" as const,root:graph.root,update:"basis"};
  const source="child é\r\n",text="Peer child é\r\n";
  const peer=prepareSourceAdmission({tree:fixture.tree,basis,graph,sourcePath:"/pair/child.md",intent:{basis:{tree:fixture.tree,path:"/pair/child",revision:"r",source},edits:[{offset:0,length:0,replacement:"Peer "}],source:text}});
  const move=prepareEntryAdmission({tree:fixture.tree,basis,graph,entryActions:fixtures.cases[0].actions});
  const current=decodeTreeSnapshotJSON(peer.candidate),incoming=decodeTreeSnapshotJSON(move.candidate);
  const objects=new Map([...graph.objects,...current.objects,...incoming.objects]);
  const tool=new MergeTool(root);
  const accepted=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:peer.change,object:current.root,trace:singleStep(graph.root,current.root,authored(decodeCandidateUpdateJSON(peer.update)))},rules:{id:"tree-default",revision:1}},objects);
  for(const [hash,bytes] of accepted.objects)objects.set(hash,bytes);
  const result=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:accepted.response.result,incoming:{change:move.change,object:incoming.root,trace:singleStep(graph.root,incoming.root,authored(decodeCandidateUpdateJSON(move.update)))},rules:{id:"tree-default",revision:1}},objects);
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
  const fixtures=await Bun.file(new URL("../../docs/overstory-spec/conformance/source-copy.json",import.meta.url)).json();
  for(const c of fixtures.cases)await withQueue(async(queue,root)=>{
    const bytes=Buffer.from(c.source),file=hashObject(bytes),directory=encodeWireDirectory({type:"directory",entries:[{name:"note.md",file}]});
    const graph={root:hashObject(directory),objects:new Map([[file,bytes],[hashObject(directory),directory]])};
    const prepare=()=>prepareSourceAdmission({tree:fixture.tree,basis:{kind:"accepted",root:graph.root,update:"basis"},graph,sourcePath:"/note.md",intent:{basis:{tree:fixture.tree,path:"/note",revision:"r",source:c.source},edits:[{offset:0,length:bytes.length,replacement:c.replacement,copies:c.copies,...(c.lineage?{lineage:c.lineage}:{})}],source:c.replacement}});
    if(!c.valid){expect(prepare).toThrow();return;}
    const record=prepare();await queue.retain(record);expect(await new SourceAdmissionQueue(fixture.tree,root).retained()).toEqual([record]);
    const {MergeTool}=await import("../../packages/canopyd/src/merge-tool.ts");
    const candidate=decodeTreeSnapshotJSON(record.candidate),operations=authored(decodeCandidateUpdateJSON(record.update));
    expect(operations.filter(o=>o.kind==="copySource").length).toBe(c.copies.length);
    const evaluated=await new MergeTool(root).evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:record.change,object:candidate.root,trace:singleStep(graph.root,candidate.root,operations)},rules:{id:"tree-default",revision:1}},new Map([...graph.objects,...candidate.objects]));
    expect(evaluated.response.result.object).toBe(candidate.root);
  });
});

test.each(["note.txt","note.md"])("source copy keeps a concurrent source edit under the %s merge policy",async(name)=>withQueue(async(_queue,root)=>{
  const source="abc\n\n",bytes=Buffer.from(source),file=hashObject(bytes),directory=encodeWireDirectory({type:"directory",entries:[{name,file}]});
  const graph={root:hashObject(directory),objects:new Map([[file,bytes],[hashObject(directory),directory]])},basis={kind:"accepted" as const,root:hashObject(directory),update:"basis"};
  const base={tree:fixture.tree,path:"/note",revision:"r",source};
  const copy=prepareSourceAdmission({tree:fixture.tree,basis,graph,sourcePath:"/"+name,intent:{basis:base,edits:[{offset:0,length:5,replacement:source+source,lineage:[{source:[0,5],replacement:[0,5]}],copies:[{source:[0,5],replacement:[5,10]}]}],source:source+source}});
  const peer=prepareSourceAdmission({tree:fixture.tree,basis,graph,sourcePath:"/"+name,intent:{basis:base,edits:[{offset:0,length:1,replacement:"X"}],source:"Xbc\n\n"}});
  const {MergeTool}=await import("../../packages/canopyd/src/merge-tool.ts");
  const tool=new MergeTool(root),current=decodeTreeSnapshotJSON(peer.candidate),incoming=decodeTreeSnapshotJSON(copy.candidate);
  const objects=new Map([...graph.objects,...current.objects,...incoming.objects]),rules={id:"tree-default",revision:1 as const};
  const accepted=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:{object:graph.root},incoming:{change:peer.change,object:current.root,trace:singleStep(graph.root,current.root,authored(decodeCandidateUpdateJSON(peer.update)))},rules},objects);
  for(const [hash,bytes] of accepted.objects)objects.set(hash,bytes);
  const result=await tool.evaluate({kind:"tree",tree:fixture.tree,base:{object:graph.root},current:accepted.response.result,incoming:{change:copy.change,object:incoming.root,trace:singleStep(graph.root,incoming.root,authored(decodeCandidateUpdateJSON(copy.update)))},rules},objects);
  for(const [hash,bytes] of result.objects)objects.set(hash,bytes);
  const {decodeWireDirectory}=await import("@overstory/protocol");
  const hash=decodeWireDirectory(objects.get(result.response.result.object)!).entries[0]!.file!;
  if(!("decisions" in result.response))throw Error("Expected evaluated intent response");
  expect(result.response.decisions).toEqual([]);
  expect(Buffer.from(objects.get(hash)!).toString()).toBe("Xbc\n\nabc\n\n");
}));


test("undo is a plain edit; records keep no sources and settled records drop without a release step", async () => withQueue(async (queue, root) => {
  const graph = initial(), text = fixture.source;
  const edits = [{ offset: 0, length: 6, replacement: "After", expected: "Before" }], edited = "After" + text.slice(6);
  const first = prepareSourceAdmission({ change: "edit", tree: fixture.tree, graph, sourcePath: fixture.sourcePath, basis: { kind: "accepted", root: graph.root, update: "up_r1" },
    intent: { basis: { tree: fixture.tree, path: "/nested/note", revision: "r1", source: text }, edits, source: edited } });
  // The editor's undo is an ordinary patch against the latest candidate.
  const undo = prepareSourceAdmission({ change: "undo", tree: fixture.tree, graph: decodeTreeSnapshotJSON(first.candidate), sourcePath: fixture.sourcePath,
    basis: { kind: "authored", change: first.change },
    intent: { basis: { tree: fixture.tree, path: "/nested/note", revision: "c1", source: edited }, edits: [{ offset: 0, length: 5, replacement: "Before", expected: "After" }], source: text } });
  expect(authored(undo.update).every(op => op.kind === "editSource")).toBe(true);
  expect(undo.candidate.root).toBe(graph.root);
  expect(JSON.stringify(undo)).not.toContain(text.trim());
  expect(undo.document.intentDigest).toMatch(/^sha256:/);
  await queue.retain([first, undo]);
  expect(await new SourceAdmissionQueue(fixture.tree, root).retained()).toEqual([first, undo]);
  const journal = JSON.parse(await readFile(join(root, "sync", "source-admissions.json"), "utf8"));
  expect(journal.schema).toBe(4);
  expect(journal.records.every((record: Record<string, unknown>) => !("intent" in record) && !("transaction" in record) && !("undoOf" in record))).toBe(true);
  // Settled records go once nothing pending depends on them; the preserved
  // tail keeps the newest record per document and its authored ancestry.
  await queue.compact(new Set([first.change]));
  expect((await queue.retained()).map(record => record.change)).toEqual([first.change, undo.change]);
  await queue.compact(new Set([first.change, undo.change]));
  expect((await queue.retained()).map(record => record.change)).toEqual([first.change, undo.change]);
  expect(await queue.compact(new Set([first.change, undo.change]), false)).toBe(true);
  expect(await queue.retained()).toEqual([]);
}));

test("cross-document copies bind the captured source path and reject changed source bytes", () => {
  const graph = initial(), original = fixture.source as string;
  const target = Buffer.from("Destination\n"), targetHash = hashObject(target);
  const directory = encodeWireDirectory({type:"directory",entries:[{name:"dest.md",file:targetHash},{name:"source.md",file:hashObject(Buffer.from(original))}]});
  graph.root=hashObject(directory); graph.objects=new Map([[graph.root,directory],[targetHash,target],[hashObject(Buffer.from(original)),Buffer.from(original)]]);
  const build=(source:string)=>prepareSourceAdmission({tree:fixture.tree,change:"cross-copy",graph,sourcePath:"/dest.md",basis:{kind:"accepted",root:graph.root,update:"r1"},intent:{basis:{tree:fixture.tree,path:"/dest",revision:"r1",source:target.toString()},source:target.toString()+original,edits:[{offset:target.length,length:0,replacement:original,copies:[{source:[0,Buffer.byteLength(original)],replacement:[0,Buffer.byteLength(original)],document:{path:"/source.md",source}}]}]}});
  const record=build(original);
  expect(authored(record.update)[0]).toMatchObject({kind:"copySource",source:{material:{path:"/source.md"}},at:{material:{path:"/dest.md"}}});
  expect(()=>build("Changed")).toThrow();
});

test("shared cross-document fixture validates exact UTF-8 material", async () => {
  const f=await Bun.file(new URL("../../docs/overstory-spec/conformance/cross-document-copy.json",import.meta.url)).json();
  const source=Buffer.from(f.original), destination=Buffer.from(f.destination);
  const directory=encodeWireDirectory({type:"directory",entries:[{name:"destination.md",file:hashObject(destination)},{name:"source.md",file:hashObject(source)}]});
  const graph={root:hashObject(directory),objects:new Map([[hashObject(directory),directory],[hashObject(source),source],[hashObject(destination),destination]])};
  const record=prepareSourceAdmission({tree:f.tree,change:"shared-cross-copy",graph,sourcePath:f.destinationPath,basis:{kind:"accepted",root:graph.root,update:"r1"},intent:{basis:{tree:f.tree,path:"/destination",source:f.destination,revision:"r1"},source:f.destination+f.edit.replacement,edits:[f.edit]}});
  expect(authored(record.update)[0]).toMatchObject({kind:"copySource",source:{material:{path:f.sourcePath},range:f.edit.copies[0].source}});
});

test("page creation records reproduce their original graph without an undo transaction",async()=>{
  const f=await Bun.file(new URL("../../docs/overstory-spec/conformance/page-conversion-undo.json",import.meta.url)).json();
  const {preparePageCreation}=await import("@overstory/client");
  const source=Buffer.from(f.source),fileSource=hashObject(source);
  const nested=encodeWireDirectory({type:"directory",entries:[{name:"note.md",file:fileSource}]}),nestedHash=hashObject(nested);
  const rootBytes=encodeWireDirectory({type:"directory",entries:[{name:"nested",directory:nestedHash}]});
  const graph={root:hashObject(rootBytes),objects:new Map([[fileSource,source],[nestedHash,nested],[hashObject(rootBytes),rootBytes]])};
  const bytes=Buffer.from(f.createdSource),file=hashObject(bytes);
  const directory=encodeWireDirectory({type:"directory",entries:[{name:f.createdPath.slice(1),file},{name:"nested",directory:nestedHash}]});
  const candidate={root:hashObject(directory),objects:new Map([...graph.objects].filter(([h])=>h!==graph.root))};
  candidate.objects.set(file,bytes);candidate.objects.set(candidate.root,directory);
  const created=preparePageCreation({change:"creation",tree:f.tree,basis:{kind:"accepted",root:graph.root,update:"r1"},graph,candidate,creation:{document:{tree:f.tree,path:f.document},removals:[f.createdPath]}});
  // A creation is traced: one addEntry of the new file under the basis root.
  expect(created.update.trace).toEqual([{before:graph.root,after:candidate.root,operations:[
    {key:"add-0",kind:"addEntry",destination:{parent:{material:{kind:"basis",path:"/",object:graph.root}},name:f.createdPath.slice(1)},value:{file}}]}]);
  expect(()=>preparePageCreation({change:"wrong",tree:f.tree,basis:{kind:"accepted",root:graph.root,update:"r1"},graph,candidate,creation:{document:{tree:f.tree,path:f.document},removals:["/elsewhere"]}})).toThrow();
  const root=await mkdtemp(join(tmpdir(),"page-creation-"));
  try {
    const queue=new SourceAdmissionQueue(f.tree,root);
    await queue.retain([created]);
    expect(await new SourceAdmissionQueue(f.tree,root).retained()).toEqual([created]);
  } finally {await rm(root,{recursive:true,force:true});}
});

type TraceVector = {
  name: string;
  source: string;
  generations: SourceEdit[][];
  frames: NonNullable<SourceAdmissionRecord["update"]["trace"]>;
  compacted: NonNullable<SourceAdmissionRecord["update"]["trace"]> | null;
};
test.each(fixture.traces as TraceVector[])("shared trace vector $name: generation frames and compaction agree", async (value) => {
  const { compactTrace } = await import("@overstory/client");
  const { composeFrames, validateSourceTrace } = await import("../../packages/canopyd/src/updates/source-edits.ts");
  const { MergeTool } = await import("../../packages/canopyd/src/merge-tool.ts");
  expect(fixture.traces.length).toBeGreaterThan(0);
  await withQueue(async (queue, root) => {
    const graph = initial();
    let source = fixture.source as string;
    const chain = value.generations.map((edits: SourceEdit[]) => ({ edits, source: source = applySourceEdits(source, edits) }));
    expect(source).toBe(value.source);
    const intent: SourceAdmissionIntent = { basis: { tree: fixture.tree, path: "/nested/note", revision: "r1", source: fixture.source },
      edits: [{ offset: 0, length: Buffer.byteLength(fixture.source), replacement: source }], source, generations: chain };
    const base = { change: "trace", tree: fixture.tree, graph, sourcePath: fixture.sourcePath, basis: { kind: "accepted" as const, root: graph.root, update: "up_r1" }, intent };
    const plain = prepareSourceAdmission({ ...base, compact: false }), compact = prepareSourceAdmission(base);
    expect(plain.update.trace).toEqual(value.frames);
    expect(compact.update.trace).toEqual(value.compacted);
    expect(compactTrace(value.frames)).toEqual(value.compacted ?? []);
    // Both forms name the same candidate and carry only its objects.
    expect(compact.candidate).toEqual(plain.candidate);
    expect(compact.update.objects).toEqual(plain.update.objects);
    expect(plain.update.trace!.length).toBe(chain.filter((g: {edits: SourceEdit[]}) => g.edits.length).length);
    // Canopy executes both chains to the same root, and composes the plain one to the compacted frame.
    const objects = new Map([...graph.objects, ...decodeTreeSnapshotJSON(plain.candidate).objects]);
    const load = async (hash: string) => { const bytes = objects.get(hash); if (!bytes) throw Error("Object missing " + hash); return bytes; };
    expect((await validateSourceTrace(value.frames, load)).root).toBe(plain.candidate.root);
    if (value.compacted) expect((await validateSourceTrace(value.compacted, load)).root).toBe(plain.candidate.root);
    const lineage = value.frames.some((frame: {operations: SourceOperation[]}) => frame.operations.some(op => op.kind === "editSource" && op.lineage?.length));
    if (!lineage) {
      const composed = await composeFrames(value.frames, load);
      expect(composed.operations).toEqual(value.compacted?.[0]?.operations ?? []);
    }
    // The merge process reaches the same decisions for the chain and its compaction.
    await using tool = new MergeTool(root);
    const rules = { id: "tree-default", revision: 1 as const };
    const evaluate = (record: typeof plain) => tool.evaluate({ kind: "tree", tree: fixture.tree, base: { object: graph.root }, current: { object: graph.root },
      incoming: { change: record.change, object: record.candidate.root, trace: decodeCandidateUpdateJSON(record.update).trace ?? [] }, rules }, objects);
    const [first, second] = await Promise.all([evaluate(plain), evaluate(compact)]);
    expect(first.response.result.object).toBe(plain.candidate.root);
    expect(second.response.result.object).toBe(plain.candidate.root);
    expect("decisions" in second.response ? second.response.decisions : null).toEqual("decisions" in first.response ? first.response.decisions : null);
    await queue.retain([plain]);
    expect(await new SourceAdmissionQueue(fixture.tree, root).retained()).toEqual([plain]);
  });
});

test("a long plain generation burst coalesces to the same candidate and capture", () => {
  const graph = initial();
  let source = fixture.source as string;
  const generations = Array.from({ length: 60 }, (_, index) => {
    const edits = [{ offset: Buffer.byteLength(source), length: 0, replacement: ` ${index}` }];
    source = applySourceEdits(source, edits);
    return { edits, source };
  });
  const input = { change: "burst", tree: fixture.tree, graph, sourcePath: fixture.sourcePath,
    basis: { kind: "accepted" as const, root: graph.root, update: "up_r1" },
    intent: { basis: { tree: fixture.tree, path: "/nested/note", revision: "r1", source: fixture.source },
      edits: [{ offset: 0, length: Buffer.byteLength(fixture.source), replacement: source }], source, generations } };
  const plain = prepareSourceAdmission({ ...input, compact: false }), compact = prepareSourceAdmission(input);
  expect(plain.update.trace).toHaveLength(60);
  expect(compact.update.trace).toHaveLength(1);
  expect(compact.candidate).toEqual(plain.candidate);
  expect(compact.document).toEqual(plain.document);
});

test("a generation list validates as a chain and drops generations that changed nothing", () => {
  const graph = initial(), source = fixture.source as string;
  const basis = { tree: fixture.tree, path: "/nested/note", revision: "r1", source };
  const first = applySourceEdits(source, [{ offset: 0, length: 6, replacement: "After" }]);
  const build = (generations: Array<{edits: SourceEdit[]; source: string}>, final = first) => prepareSourceAdmission({ tree: fixture.tree, graph, sourcePath: fixture.sourcePath,
    basis: { kind: "accepted", root: graph.root, update: "up_r1" }, intent: { basis, edits: [{ offset: 0, length: 6, replacement: "After" }], source: final, generations } });
  expect(build([{ edits: [], source }, { edits: [{ offset: 0, length: 6, replacement: "After" }], source: first }]).update.trace).toHaveLength(1);
  expect(() => build([{ edits: [{ offset: 0, length: 6, replacement: "Other" }], source: first }])).toThrow();
  expect(() => build([{ edits: [{ offset: 0, length: 6, replacement: "After" }], source: first }, { edits: [{ offset: 0, length: 0, replacement: "!" }], source: "!" + first }])).toThrow();
  expect(() => build([{ edits: [], source }])).toThrow();
  // A no-op inside the emoji must not disappear into a valid composed edit.
  expect(() => build([
    { edits: [{ offset: 8, length: 0, replacement: "" }], source },
    { edits: [{ offset: 0, length: 6, replacement: "After" }], source: first },
  ])).toThrow();
});
