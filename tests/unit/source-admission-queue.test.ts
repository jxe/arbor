import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
function records(): SourceAdmissionRecord[] {
  const result: SourceAdmissionRecord[] = [];
  for (const change of fixture.changes) {
    const parent = result.find(r => r.change === change.basis.change), graph = parent ? decodeTreeSnapshotJSON(parent.candidate) : initial();
    const source = parent?.intent.source ?? fixture.source;
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
