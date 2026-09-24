import { CANOPY_SCHEMA_VERSION } from "../../../packages/canopyd/src/schema.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient, WireUpdateConflict, decodeWireDirectory, encodeWireDirectory, hashObject, type CandidateUpdate, type ObjectHash } from "@overstory/protocol";
import { executeExactSourceEdits } from "../../../packages/canopyd/src/updates/source-edits.ts";
/** A request's whole authored contribution, in order, across its frames. */
const authored = (u: CandidateUpdate) => (u.trace ?? []).flatMap(frame => frame.operations);

let dir: string, running: Awaited<ReturnType<typeof serveCanopy>>, client: WireClient;
let tree: string, base: string, root: ObjectHash, objects: Map<ObjectHash, Uint8Array>;
const token = "source-test-owner";
async function start(mergeTool?: import("../../../packages/canopyd/src/merge-tool.ts").MergeToolOptions) {
  running = await serveCanopy({ dataRoot: dir, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0, mergeTool: {contentChoices: "file", ...mergeTool} });
  client = new WireClient(running.url, token);
}
async function stop() { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); }
beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/arbor-source-accept-`); await start();
  tree = (await client.account()).account.community.id;
  const descriptor = await client.descriptor(tree);
  const snapshot = await client.snapshot(tree, descriptor.tree.root);
  objects = new Map(snapshot.objects);
  const bytes = new TextEncoder().encode("abc\r\n"), file = hashObject(bytes);
  const directory = decodeWireDirectory(objects.get(snapshot.root)!);
  directory.entries.push({ name: "note.md", file });
  directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const encoded = encodeWireDirectory(directory); root = hashObject(encoded);
  objects.set(file, bytes); objects.set(root, encoded);
  base = (await client.submitUpdate(tree, descriptor.tree.update, { root, objects })).update.id;
});
afterEach(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
async function edit(text: string, basis = root, range: [number, number] = [0, 3]): Promise<CandidateUpdate> {
  return editAt("/note.md", text, basis, range);
}
async function editAt(path: string, text: string, basis = root, range: [number, number] = [0, 3]): Promise<CandidateUpdate> {
  let directory = decodeWireDirectory(objects.get(basis)!);
  const parts = path.slice(1).split("/"), name = parts.pop()!;
  for (const part of parts) directory = decodeWireDirectory(objects.get(directory.entries.find(e => e.name === part)!.directory!)!);
  const file = directory.entries.find(e => e.name === name)!.file!;
  const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path, object: file }, range }, text }];
  const executed = await executeExactSourceEdits(basis, operations, async hash => objects.get(hash)!);
  for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
  return { change: crypto.randomUUID(), candidate: executed.root, trace: [{ before: basis, after: executed.root, operations }], resolves: [], objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
}
function records() {
  const db = new Database(`${dir}/canopy.sqlite3`);
  try { return db.query("SELECT u.change_id, u.base_root AS basis_root, u.candidate_root, m.record_json FROM accepted_merge_states m JOIN accepted_updates u ON u.id=m.accepted_id WHERE u.tree_id = ? AND json_extract(m.record_json, '$.request.trace') IS NOT NULL").all(tree); } finally { db.close(); }
}
test("accepts exact source, retains evidence across restart, and replays after snapshot advancement", async () => {
  const update = await edit("ABC"), request = { base, updates: [update] };
  const accepted = await client.submitUpdates(tree, request);
  expect(accepted.results[0]!.outcome).toBe("accepted");
  expect(accepted.results[0]!.update.root).toBe(update.candidate);
  expect(records()).toHaveLength(1);
  const snapshot = await edit("XYZ", update.candidate);
  await client.submitUpdates(tree, { base: accepted.results[0]!.update.id, updates: [{ ...snapshot, trace: null }] });
  await stop(); await start();
  const replay = await client.submitUpdates(tree, request);
  expect(replay.results[0]!.update.id).toBe(accepted.results[0]!.update.id);
  expect(records()).toHaveLength(1);
  await running.canopy.verifyIntegrity();
});
test("equal-byte edits create accepted provenance and subsequent batch edits use preceding candidates", async () => {
  const same = await edit("abc"), changed = await edit("ABC", same.candidate);
  const response = await client.submitUpdates(tree, { base, updates: [same, changed] });
  expect(response.results.map(r => r.outcome)).toEqual(["accepted", "accepted"]);
  expect(response.results[0]!.update.root).toBe(root);
  expect(response.results[0]!.update.id).not.toBe(base);
  expect(records()).toHaveLength(2);
});
test("preflight is reused only for the same retained material; divergent heads still merge", async () => {
  const first = await edit("ABC");
  const accepted = (await client.submitUpdates(tree, {base, updates: [first]})).results[0]!.update;
  await stop();
  let workers = 0;
  await start({onTiming: (phase) => { if (phase === "worker-process") workers++; }});
  const next = await edit("AAA", first.candidate);
  const peer = await edit("BBB", first.candidate);
  const forward = (await client.submitUpdates(tree, {base: accepted.id, updates: [next]})).results[0]!.update;
  expect(forward.root).toBe(next.candidate);
  expect(workers).toBe(1);
  workers = 0;
  const merged = (await client.submitUpdates(tree, {base: accepted.id, updates: [peer]})).results[0]!.update;
  expect(merged.conflicted).toBe(true);
  expect(workers).toBe(2);
  const count = records().length;
  await expect(client.submitUpdates(tree, {base: accepted.id, updates: [{...await edit("CCC", first.candidate), ifCurrent: accepted.id}]})).rejects.toThrow();
  expect(records()).toHaveLength(count);
  await running.canopy.verifyIntegrity();
});
test("concurrent range edits retain both accepted alternatives", async () => {
  const a = await edit("AAA"), b = await edit("BBB");
  const results = await Promise.allSettled([client.submitUpdates(tree, { base, updates: [a] }), client.submitUpdates(tree, { base, updates: [b] })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
  const current = (await client.descriptor(tree)).tree;
  expect(current.conflicted).toBe(true);
  const decision = (await client.conflicts(tree, current.update, current.root)).decisions[0]!;
  expect(decision.alternatives.map(a => a.value)).toEqual(expect.arrayContaining([
    { file: hashObject(new TextEncoder().encode("AAA\r\n")) },
    { file: hashObject(new TextEncoder().encode("BBB\r\n")) },
  ]));
  expect(records()).toHaveLength(2);
  await running.canopy.verifyIntegrity();
});
test("a stale equal-root basis cannot erase newer intent", async () => {
  await client.submitUpdates(tree, { base, updates: [await edit("abc")] });
  const accepted = (await client.submitUpdates(tree, { base, updates: [await edit("ABC")] })).results[0]!.update;
  expect(accepted.conflicted).toBe(true);
  expect(accepted.root).toBe(root);
  expect((await client.conflicts(tree, accepted.id, accepted.root)).decisions[0]!.alternatives).toHaveLength(2);
  expect(records()).toHaveLength(2);
});

type RangeEdit = { range: [number, number]; text: string };
async function rangeCandidate(edits: RangeEdit[]): Promise<CandidateUpdate> {
  const file = decodeWireDirectory(objects.get(root)!).entries.find(e => e.name === "note.md")!.file!;
  const operations = edits.map((edit, i) => ({ key: `range-${i}`, kind: "editSource" as const,
    source: { material: { kind: "basis" as const, path: "/note.md", object: file }, range: edit.range }, text: edit.text }));
  const result = await executeExactSourceEdits(root, operations, async hash => objects.get(hash)!);
  for (const object of result.generated) objects.set(...object);
  return { change: crypto.randomUUID(), candidate: result.root, trace: [{ before: root, after: result.root, operations }], resolves: [],
    objects: [...result.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
}
const rangeCases: Array<{ name: string; left: RangeEdit[]; right: RangeEdit[] }> = [
  { name: "several operations and Unicode replacements", left: [{ range: [0,1], text: "🪴" }, { range: [2,3], text: "C" }],
    right: [{ range: [0,1], text: "🌲" }, { range: [1,2], text: "B" }] },

  { name: "format rule declines disjoint Markdown edits", left: [{ range: [0,1], text: "**A**" }], right: [{ range: [2,3], text: "C" }] },
  { name: "equal-byte overlapping intent", left: [{ range: [1,2], text: "b" }], right: [{ range: [1,2], text: "b" }] },
];
for (const scenario of rangeCases) for (const reverse of [false, true]) {
  test(`root range choices preserve complete provenance through restart: ${scenario.name}, reverse=${reverse}`, async () => {
    const pair = [await rangeCandidate(scenario.left), await rangeCandidate(scenario.right)];
    if (reverse) pair.reverse();
    const first = pair[0]!, second = pair[1]!;
    await client.submitUpdates(tree, { base, updates: [first] });
    const accepted = (await client.submitUpdates(tree, { base, updates: [second] })).results[0]!.update;
    expect(accepted.conflicted).toBe(true);
    expect(accepted.root).toBe(first.candidate);
    const page = await client.conflicts(tree, accepted.id, accepted.root);
    expect(page.decisions).toHaveLength(1);
    expect(page.decisions[0]!.alternatives).toHaveLength(2);
    for (const request of pair) {
      const alternative = page.decisions[0]!.alternatives.find(a => a.contributions.some(c => c.change === request.change))!;
      const file = decodeWireDirectory(objects.get(request.candidate)!).entries.find(e => e.name === "note.md")!.file!;
      expect(alternative.value).toEqual({ file });
      expect(alternative.contributions).toEqual(authored(request).map(op => ({ change: request.change, operation: op.key })));
    }
    await stop(); await start();
    expect(await client.conflicts(tree, accepted.id, accepted.root)).toEqual(page);
    expect((await client.submitUpdates(tree, { base, updates: [second] })).results[0]!.update).toEqual(accepted);
    expect(records()).toHaveLength(2);
    await running.canopy.verifyIntegrity();
  });
}
test("nested range collisions create a decision at the physical file", async () => {
  const directory = decodeWireDirectory(objects.get(root)!);
  const original = directory.entries.find(e => e.name === "note.md")!;
  const child = encodeWireDirectory({ type: "directory", entries: [original] }), childHash = hashObject(child);
  directory.entries.push({ name: "nested", directory: childHash });
  directory.entries.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeWireDirectory(directory); root = hashObject(bytes);
  objects.set(childHash, child); objects.set(root, bytes);
  base = (await client.submitUpdate(tree, base, { root, objects })).update.id;
  const candidates: CandidateUpdate[] = [];
  for (const text of ["A", "B"]) {
    const operations = [{ key: "nested-edit", kind: "editSource" as const,
      source: { material: { kind: "basis" as const, path: "/nested/note.md", object: original.file! }, range: [0,1] as [number, number] }, text }];
    const executed = await executeExactSourceEdits(root, operations, async hash => objects.get(hash)!);
    for (const object of executed.generated) objects.set(...object);
    candidates.push({ change: crypto.randomUUID(), candidate: executed.root, trace: [{ before: root, after: executed.root, operations }], resolves: [],
      objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] });
  }
  const prior = (await client.submitUpdates(tree, { base, updates: [candidates[0]!] })).results[0]!.update;
  const accepted = (await client.submitUpdates(tree, { base, updates: [candidates[1]!] })).results[0]!.update;
  expect(accepted.root).toBe(prior.root);
  expect(accepted.conflicted).toBe(true);
  const decision = (await client.conflicts(tree, accepted.id, accepted.root)).decisions[0]!;
  expect(decision.affected).toEqual([{ material: { kind: "basis", path: "/", object: accepted.root }, within: ["nested"] }]);
  expect(decision.alternatives.map(a => a.placement?.name)).toEqual(["note.md", "note.md"]);
  expect(records()).toHaveLength(2);
  await running.canopy.verifyIntegrity();
});
test("candidate mismatch and dynamic unsupported forms reject before any prefix commits", async () => {
  const first = await edit("ABC"), second = await edit("DEF", first.candidate);
  const before = running.canopy.currentUpdate(tree);
  // A trace whose last frame does not end at the candidate is refused by the
  // contract, before anything is executed.
  await expect(client.submitUpdates(tree, { base, updates: [{ ...first, candidate: root }] })).rejects.toThrow("Invalid authored update contract");
  // A self-consistent trace whose operations do not produce the result it
  // claims is refused by execution, which is the check the contract cannot make.
  await expect(client.submitUpdates(tree, { base, updates: [
    { ...first, candidate: root, trace: [{ ...first.trace![0]!, after: root }] },
  ] })).rejects.toThrow("do not reproduce");
  const overlapping = { ...second, trace: [{ ...second.trace![0]!, operations: [...authored(second), { ...authored(second)[0]!, key: "overlap" }] }] };
  await expect(client.submitUpdates(tree, { base, updates: [first, overlapping] })).rejects.toThrow();
  expect(running.canopy.currentUpdate(tree)).toEqual(before);
  expect(records()).toHaveLength(0);
});
test("reusing a retained change for another operation or snapshot cannot mutate authority", async () => {
  const first = await edit("ABC");
  const response = await client.submitUpdates(tree, { base, updates: [first] });
  const next = await edit("DEF", first.candidate);
  for (const trace of [next.trace, null]) {
    await expect(client.submitUpdates(tree, { base: response.results[0]!.update.id, updates: [{ ...next, change: first.change, trace }] })).rejects.toThrow(/identity.*(bound|reused)/);
  }
  expect(records()).toHaveLength(1);
});
test("injected provenance write failure rolls back acceptance and permits exact retry", async () => {
  const db = new Database(`${dir}/canopy.sqlite3`);
  db.run("CREATE TRIGGER fail_source AFTER INSERT ON accepted_merge_states BEGIN SELECT RAISE(ABORT, 'injected source failure'); END");
  const request = { base, updates: [await edit("ABC")] };
  await expect(client.submitUpdates(tree, request)).rejects.toThrow("injected source failure");
  expect(running.canopy.currentUpdate(tree)!.id).toBe(base);
  expect(records()).toHaveLength(0);
  db.run("DROP TRIGGER fail_source"); db.close();
  expect((await client.submitUpdates(tree, request)).results[0]!.outcome).toBe("accepted");
});

test("guard failure preserves a completed prefix and exact retries do not duplicate it", async () => {
  const first = await edit("ABC"), second = await edit("DEF", first.candidate);
  const request = { base, updates: [first, { ...second, ifCurrent: base }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await client.submitUpdates(tree, request); throw new Error("Expected conflict"); }
    catch (error) {
      expect(error).toBeInstanceOf(WireUpdateConflict);
      const conflict = (error as WireUpdateConflict).result;
      expect(conflict.details.completed).toHaveLength(1);
      expect(conflict.details.failedIndex).toBe(1);
      expect(conflict.details.current.root).toBe(first.candidate);
    }
    expect(records()).toHaveLength(1);
  }
});
test("unauthorized clients and foreign accepted bases cannot submit authored edits", async () => {
  const update = await edit("ABC");
  await expect(new WireClient(running.url).submitUpdates(tree, { base, updates: [update] })).rejects.toThrow();
  const account = await client.account();
  const foreign = await client.descriptor(account.account.configuration.id);
  await expect(client.submitUpdates(tree, { base: foreign.tree.update, updates: [update] })).rejects.toThrow();
  expect(running.canopy.currentUpdate(tree)!.id).toBe(base);
  expect(records()).toHaveLength(0);
});

test("same-basis independent source edits merge across restart and retain replay receipts", async () => {
  const a = await edit("A", root, [0,1]), b = await edit("B", root, [1,2]), c = await edit("C", root, [2,3]);
  await client.submitUpdates(tree, { base, updates: [a] });
  await stop(); await start();
  await client.submitUpdates(tree, { base, updates: [b] });
  const request = { base, updates: [c] };
  const accepted = await client.submitUpdates(tree, request);
  const expected = await edit("ABC");
  expect(accepted.results[0]!.update.root).toBe(expected.candidate);
  expect(accepted.results[0]!.update.conflicted).toBe(false);
  expect(records()).toHaveLength(3);
  const db = new Database(`${dir}/canopy.sqlite3`);
  const row = db.query("SELECT record_json FROM accepted_merge_states WHERE accepted_id = ?").get(accepted.results[0]!.update.id) as { record_json: string };
  const retained=JSON.parse(row.record_json);
  expect(retained.evidence.validation).toBe("verified");
  expect(retained.evidence.formats).toMatchObject([{id:"markdown-independent",revision:1,outcome:"resolved"}]);
  db.close();
  const replay = await client.submitUpdates(tree, request);
  expect(replay.results[0]!.update).toEqual(accepted.results[0]!.update);
  expect(records()).toHaveLength(3);
  // A baseline snapshot client can edit the merged projection normally.
  const next = await edit("snapshot", expected.candidate);
  const snapshot = await client.submitUpdates(tree, { base: accepted.results[0]!.update.id, updates: [{ ...next, trace: null }] });
  expect(snapshot.results[0]!.update.root).toBe(next.candidate);
  expect(records()).toHaveLength(3);
  await running.canopy.verifyIntegrity();
});
test("a merged predecessor's disjoint successor merges without rebasing authored intent", async () => {
  const peer = await edit("A", root, [0,1]);
  await client.submitUpdates(tree, { base, updates: [peer] });
  const first = await edit("C", root, [2,3]), second = await edit("x", first.candidate, [1,2]);
  const request = { base, updates: [first, second] };
  const response = await client.submitUpdates(tree, request), accepted = response.results[1]!.update;
  expect(response.results[0]!.update.root).toBe((await edit("AbC")).candidate);
  expect(accepted.root).toBe((await edit("AxC")).candidate);
  expect(accepted.conflicted).toBe(false);
  const page = await client.conflicts(tree, accepted.id, accepted.root);
  expect(page.decisions).toEqual([]);
  const retained = records() as Array<{ change_id: string; basis_root: string; candidate_root: string }>;
  expect(retained.find(r => r.change_id === second.change)).toMatchObject({ basis_root: first.candidate, candidate_root: second.candidate });
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results.map(r => r.update.id)).toEqual(response.results.map(r => r.update.id));
  expect(await client.conflicts(tree, accepted.id, accepted.root)).toEqual(page);
  await running.canopy.verifyIntegrity();
});

async function wholeConflict() {
  const a = await edit("first\r\n", root, [0,5]), b = await edit("second\r\n", root, [0,5]);
  await client.submitUpdates(tree, { base, updates: [a] });
  const result = (await client.submitUpdates(tree, { base, updates: [b] })).results[0]!;
  expect(result.outcome).toBe("accepted");
  expect(result.update.conflicted).toBe(true);
  return { a, b, update: result.update };
}
test("whole-file alternatives survive snapshot edits, restart, and guarded resolution", async () => {
  const { update } = await wholeConflict();
  const page = await client.conflicts(tree, update.id, update.root);
  expect(page.decisions).toHaveLength(1);
  const decision = page.decisions[0]!;
  expect(decision.alternatives).toHaveLength(2);
  const hidden = decision.alternatives.find(a => a.id !== decision.selected)!;
  if (!("file" in hidden.value)) throw new Error("Expected file alternative");
  expect(new TextDecoder().decode(await client.object(tree, hidden.value.file))).toBe("second\r\n");
  const visible = await edit("continued", update.root, [0,5]);
  const next = (await client.submitUpdates(tree, { base: update.id, updates: [{ ...visible, trace: null }] })).results[0]!.update;
  expect(next.conflicted).toBe(true);
  await stop(); await start();
  const continued = await client.conflicts(tree, next.id, next.root);
  expect(continued.decisions[0]!.id).toBe(decision.id);
  expect(continued.decisions[0]!.alternatives.find(a => a.id === hidden.id)).toMatchObject({ id: hidden.id, revision: hidden.revision, value: hidden.value, contributions: hidden.contributions });
  expect(await client.conflicts(tree, update.id, update.root)).toEqual(page);
  const resolution = { change: crypto.randomUUID(), candidate: next.root, trace: [], resolves: [{ state: next.id, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) }], objects: [], deltas: [] };
  const resolved = (await client.submitUpdates(tree, { base: next.id, updates: [resolution] })).results[0]!.update;
  expect(resolved.root).toBe(next.root);
  expect(resolved.id).not.toBe(next.id);
  expect(resolved.conflicted).toBe(false);
  expect((await client.conflicts(tree, resolved.id, resolved.root)).decisions).toEqual([]);
  await running.canopy.verifyIntegrity();
});
test("deleting the selected file retains hidden material and stale resolution does not discard it", async () => {
  const { update } = await wholeConflict();
  const page = await client.conflicts(tree, update.id, update.root), decision = page.decisions[0]!;
  const directory = decodeWireDirectory(objects.get(update.root)!);
  directory.entries = directory.entries.filter(e => e.name !== "note.md");
  const bytes = encodeWireDirectory(directory), candidate = hashObject(bytes);
  const request = { base: update.id, updates: [{ change: crypto.randomUUID(), candidate, trace: null, resolves: [], objects: [{ hash: candidate, bytes }], deltas: [] }] };
  const deleted = (await client.submitUpdates(tree, request)).results[0]!.update;
  expect(deleted.conflicted).toBe(true);
  const current = await client.conflicts(tree, deleted.id, deleted.root);
  expect(current.decisions.find(d=>d.id!==decision.id)!.alternatives.map(a=>a.value)).toContainEqual({directory:candidate});
  const hidden = decision.alternatives.find(a => a.id !== decision.selected)!;
  expect(current.decisions[0]!.alternatives.find(a => a.id === hidden.id)).toMatchObject({ id: hidden.id, revision: hidden.revision, value: hidden.value, contributions: hidden.contributions });
  await expect(client.submitUpdates(tree, { base: deleted.id, updates: [{ change: crypto.randomUUID(), candidate: deleted.root, trace: [], resolves: [{ state: update.id, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) }], objects: [], deltas: [] }] })).rejects.toBeInstanceOf(WireUpdateConflict);
  expect((await client.descriptor(tree)).tree.update).toBe(deleted.id);
  await running.canopy.verifyIntegrity();
});
test("inspection pages exceed 32 decisions, stay state-bound, and partial resolution preserves other decisions", async () => {
  const directory = decodeWireDirectory(objects.get(root)!);
  const body = new TextEncoder().encode("old"), file = hashObject(body); objects.set(file, body);
  for (let i = 0; i < 33; i++) directory.entries.push({ name: `choice-${i}.txt`, file });
  directory.entries.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeWireDirectory(directory); root = hashObject(bytes); objects.set(root, bytes);
  base = (await client.submitUpdate(tree, base, { root, objects })).update.id;
  async function peer(text: string): Promise<CandidateUpdate> {
    const operations = Array.from({ length: 33 }, (_, i) => ({ key: `edit-${i}`, kind: "editSource" as const,
      source: { material: { kind: "basis" as const, path: `/choice-${i}.txt`, object: file } }, text }));
    const result = await executeExactSourceEdits(root, operations, async hash => objects.get(hash)!);
    for (const value of result.generated) objects.set(...value);
    return { change: crypto.randomUUID(), candidate: result.root, trace: [{ before: root, after: result.root, operations }], resolves: [], objects: [...result.generated].map(([hash,bytes]) => ({ hash,bytes })), deltas: [] };
  }
  await client.submitUpdates(tree, { base, updates: [await peer("left")] });
  const accepted = (await client.submitUpdates(tree, { base, updates: [await peer("right")] })).results[0]!.update;
  const first = await client.conflicts(tree, accepted.id, accepted.root);
  expect(first.decisions).toHaveLength(32); expect(first.next).not.toBeNull();
  const last = await client.conflicts(tree, accepted.id, accepted.root, { after: first.next! });
  expect(last.decisions).toHaveLength(1); expect(last.next).toBeNull();
  const d = first.decisions[0]!;
  const next = (await client.submitUpdates(tree, { base: accepted.id, updates: [{ change: crypto.randomUUID(), candidate: accepted.root, trace: [], resolves: [{ state: accepted.id, conflict: d.id, alternatives: d.alternatives.map(a => a.id) }], objects: [], deltas: [] }] })).results[0]!.update;
  expect(next.conflicted).toBe(true);
  expect((await client.conflicts(tree, next.id, next.root)).decisions).toHaveLength(32);
  expect(await client.conflicts(tree, accepted.id, accepted.root, { after: first.next! })).toEqual(last);
  await expect(client.conflicts(tree, next.id, next.root, { after: first.next! })).rejects.toThrow("token");
  expect((await client.conflicts(tree, accepted.id, accepted.root, { conflict: d.id })).decisions).toEqual([d]);
  const db = new Database(`${dir}/canopy.sqlite3`);
  db.run("DELETE FROM access WHERE tree_id = ? AND subject_kind = 'everyone'", [tree]); db.close();
  const denied = await fetch(`${running.url}/.arbor/trees/${tree}/conflicts?state=${accepted.id}&after=${first.next}`);
  expect(denied.status).toBe(404);
});
test("a stale save adds an alternative instead of overwriting a newer revision", async () => {
  const { update } = await wholeConflict();
  const a = await edit("newer", update.root, [0,5]), b = await edit("offline", update.root, [0,5]);
  await client.submitUpdates(tree, { base: update.id, updates: [{ ...a, trace: null }] });
  const next = (await client.submitUpdates(tree, { base: update.id, updates: [{ ...b, trace: null }] })).results[0]!.update;
  expect(next.conflicted).toBe(true);
  const page=await client.conflicts(tree,next.id,next.root);
  expect(page.decisions).toHaveLength(2);
  expect(page.decisions.flatMap(d=>d.alternatives.map(a=>a.value))).toContainEqual({directory:b.candidate});
  expect(page.decisions[0]!.alternatives.map(a=>a.value)).toContainEqual({file:hashObject(Buffer.from("second\r\n"))});
});
test("a failed conflict-state insert cannot acknowledge or partially publish a conflict", async () => {
  const a = await edit("first", root, [0,5]), b = await edit("second", root, [0,5]);
  const prior = (await client.submitUpdates(tree, { base, updates: [a] })).results[0]!.update;
  const db = new Database(`${dir}/canopy.sqlite3`);
  db.run("CREATE TRIGGER fail_conflict AFTER INSERT ON accepted_merge_states BEGIN SELECT RAISE(ABORT, 'injected conflict failure'); END");
  await expect(client.submitUpdates(tree, { base, updates: [b] })).rejects.toThrow("injected conflict failure");
  expect((await client.descriptor(tree)).tree.update).toBe(prior.id);
  expect(db.query("SELECT * FROM accepted_conflicts").all()).toHaveLength(0);
  db.run("DROP TRIGGER fail_conflict"); db.close();
  expect((await client.submitUpdates(tree, { base, updates: [b] })).results[0]!.update.conflicted).toBe(true);
});
test("reviewed replacement chooses a hidden file and incomplete alternative guards fail", async () => {
  const { update } = await wholeConflict();
  const page = await client.conflicts(tree, update.id, update.root), decision = page.decisions[0]!;
  const replacement = await edit("second\r\n", update.root, [0,7]);
  const guard = { state: update.id, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) };
  await expect(client.submitUpdates(tree, { base: update.id, updates: [{ ...replacement, resolves: [{ ...guard, alternatives: [decision.selected] }] }] })).rejects.toBeInstanceOf(WireUpdateConflict);
  const resolved = (await client.submitUpdates(tree, { base: update.id, updates: [{ ...replacement, resolves: [guard] }] })).results[0]!.update;
  expect(resolved.conflicted).toBe(false);
  const snapshot = await client.snapshot(tree, resolved.root);
  const file = decodeWireDirectory(snapshot.objects.get(resolved.root)!).entries.find(e => e.name === "note.md")!.file!;
  expect(new TextDecoder().decode(snapshot.objects.get(file))).toBe("second\r\n");
  expect((await client.conflicts(tree, update.id, update.root)).decisions).toEqual(page.decisions);
});
test.each(["first", "second"])("a batch suffix continues its hidden candidate and exact replay preserves that attribution (%s)", async word => {
  const a = await edit("first\r\n", root, [0,5]), b = await edit(`${word}\r\n`, root, [0,5]);
  await client.submitUpdates(tree, { base, updates: [a] });
  const suffix = await edit("continued hidden", b.candidate, [0,word.length]);
  const request = { base, updates: [b, suffix] };
  const result = await client.submitUpdates(tree, request);
  expect(result.results.map(r => r.outcome)).toEqual(["accepted", "accepted"]);
  const head = result.results[1]!.update;
  expect(head.root).toBe(a.candidate);
  const page = await client.conflicts(tree, head.id, head.root), decision = page.decisions[0]!;
  const hidden = decision.alternatives.find(a => a.id !== decision.selected)!;
  if (!("file" in hidden.value)) throw new Error("Expected file");
  expect(new TextDecoder().decode(await client.object(tree, hidden.value.file))).toBe("continued hidden\r\n");
  const replay = await client.submitUpdates(tree, request);
  expect(replay.results.map(r => r.update.id)).toEqual(result.results.map(r => r.update.id));
  expect(await client.conflicts(tree, head.id, head.root)).toEqual(page);
});
test("snapshot change identities cannot be reused to impersonate later alternative contributions", async () => {
  const { update } = await wholeConflict();
  const first = await edit("snapshot", update.root, [0,5]);
  const next = (await client.submitUpdates(tree, { base: update.id, updates: [{ ...first, trace: null }] })).results[0]!.update;
  const second = await edit("different", next.root, [0,8]);
  await expect(client.submitUpdates(tree, { base: next.id, updates: [{ ...second, trace: null, change: first.change }] })).rejects.toThrow(/identity.*(bound|reused)/);
  expect((await client.descriptor(tree)).tree.update).toBe(next.id);
});
test("entry kind changes retain hidden files and nested batch edits keep their attribution", async () => {
  const { update } = await wholeConflict();
  const child = new TextEncoder().encode("abc"), file = hashObject(child);
  const folder = encodeWireDirectory({ type: "directory", entries: [{ name: "child.txt", file }] }), folderHash = hashObject(folder);
  const directory = decodeWireDirectory(objects.get(update.root)!);
  directory.entries = directory.entries.map(e => e.name === "note.md" ? { name: e.name, directory: folderHash } : e);
  const encoded = encodeWireDirectory(directory), candidate = hashObject(encoded);
  for (const [hash, bytes] of [[file, child], [folderHash, folder], [candidate, encoded]] as Array<[ObjectHash, Uint8Array]>) objects.set(hash, bytes);
  const replacement:CandidateUpdate={ change: crypto.randomUUID(), candidate, trace: null, resolves: [], objects: [...objects].map(([hash,bytes]) => ({ hash,bytes })), deltas: [] };
  const placed = (await client.submitUpdates(tree, { base: update.id, updates: [replacement] })).results[0]!.update;
  async function nested(basis: ObjectHash, object: ObjectHash, range: [number,number], text: string): Promise<CandidateUpdate> {
    const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: "/note.md/child.txt", object }, range }, text }];
    const result = await executeExactSourceEdits(basis, operations, async hash => objects.get(hash)!);
    for (const value of result.generated) objects.set(...value);
    return { change: crypto.randomUUID(), candidate: result.root, trace: [{ before: basis, after: result.root, operations }], resolves: [], objects: [...result.generated].map(([hash,bytes]) => ({ hash,bytes })), deltas: [] };
  }
  const first = await nested(candidate, file, [0,1], "A"), second = await nested(first.candidate, hashObject(new TextEncoder().encode("Abc")), [1,2], "B");
  const result = await client.submitUpdates(tree, { base: update.id, updates: [replacement, first, second] });
  const final = result.results[2]!.update;
  expect(final.root).toBe(placed.root);
  const page = await client.conflicts(tree, final.id, final.root);
  expect(page.decisions[0]!.alternatives).toHaveLength(2);
  const enclosing=page.decisions.find(d=>d.kind==="directory")!;
  const hidden=enclosing.alternatives.find(a=>a.id!==enclosing.selected)!;
  expect(hidden.value).toEqual({directory:second.candidate});
  expect(hidden.contributions.map(c=>c.change)).toContain(second.change);
  expect(page.decisions[0]!.alternatives.some(a => "file" in a.value)).toBe(true);
  await running.canopy.verifyIntegrity();
});

async function installNestedPeers() {
  const file = hashObject(new TextEncoder().encode("abc\r\n"));
  const leaf = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file }] });
  const leafHash = hashObject(leaf); objects.set(leafHash, leaf);
  const folder = encodeWireDirectory({ type: "directory", entries: [{ name: "left", directory: leafHash }, { name: "right", directory: leafHash }] });
  const folderHash = hashObject(folder); objects.set(folderHash, folder);
  const directory = decodeWireDirectory(objects.get(root)!);
  directory.entries.push({ name: "nested", directory: folderHash });
  directory.entries.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeWireDirectory(directory); root = hashObject(bytes); objects.set(root, bytes);
  base = (await client.submitUpdate(tree, base, { root, objects })).update.id;
}

test("nested decisions stay independent across histories, hidden successors, resolution and restart", async () => {
  await installNestedPeers();
  const a = await editAt("/nested/left/note.md", "peer-left");
  await client.submitUpdates(tree, { base, updates: [a] });
  const first = (await client.descriptor(tree)).tree;
  const b = await editAt("/nested/right/note.md", "peer-right", first.root);
  const second = (await client.submitUpdates(tree, { base: first.update, updates: [b] })).results[0]!.update;
  const left = await editAt("/nested/left/note.md", "my-left"), right = await editAt("/nested/right/note.md", "my-right");
  const leftAccepted = (await client.submitUpdates(tree, { base, updates: [left] })).results[0]!.update;
  const leftHistory = await client.conflicts(tree, leftAccepted.id, leftAccepted.root);
  const current = (await client.submitUpdates(tree, { base, updates: [right] })).results[0]!.update;
  expect(current.root).toBe(second.root);
  const page = await client.conflicts(tree, current.id, current.root);
  expect(page.decisions).toHaveLength(2);
  const l = page.decisions.find(d => d.affected[0]?.within?.join("/") === "nested/left")!;
  const r = page.decisions.find(d => d.affected[0]?.within?.join("/") === "nested/right")!;
  expect(l.id).not.toBe(r.id);
  expect(l.alternatives.find(v => v.id === l.selected)!.contributions).toEqual([{ change: a.change, operation: "edit" }]);
  expect(r.alternatives.find(v => v.id === r.selected)!.contributions).toEqual([{ change: b.change, operation: "edit" }]);
  const suffix = await editAt("/nested/left/note.md", "continued", left.candidate, [0,7]);
  const continued = (await client.submitUpdates(tree, { base, updates: [left, suffix] })).results[1]!.update;
  const continuedPage = await client.conflicts(tree, continued.id, continued.root);
  const hidden = continuedPage.decisions.find(d => d.id === l.id)!.alternatives.find(v => v.id !== l.selected)!;
  expect(hidden.value).toEqual({ file: hashObject(new TextEncoder().encode("continued\r\n")) });
  expect(continuedPage.decisions.find(d => d.id === r.id)!.alternatives).toEqual(r.alternatives);
  if (!("file" in hidden.value)) throw new Error("Expected file");
  expect(new TextDecoder().decode(await client.object(tree, hidden.value.file))).toBe("continued\r\n");
  const resolved = (await client.submitUpdates(tree, { base: continued.id, updates: [{ change: crypto.randomUUID(), candidate: continued.root,
    trace: [], resolves: [{ state: continued.id, conflict: l.id, alternatives: l.alternatives.map(v => v.id) }], objects: [], deltas: [] }] })).results[0]!.update;
  expect(resolved.conflicted).toBe(true);
  expect((await client.conflicts(tree, resolved.id, resolved.root)).decisions.map(d => d.id)).toEqual([r.id]);
  const snapshotEdit = await editAt("/nested/right/note.md", "snapshot-right", resolved.root, [0,10]);
  const snapshotAccepted = (await client.submitUpdates(tree, { base: resolved.id, updates: [{ ...snapshotEdit, trace: null }] })).results[0]!.update;
  const snapshotDecision = (await client.conflicts(tree, snapshotAccepted.id, snapshotAccepted.root)).decisions[0]!;
  expect(snapshotDecision.id).toBe(r.id);
  expect(snapshotDecision.alternatives.find(a => a.id === r.selected)!.value).toEqual({ file: hashObject(new TextEncoder().encode("snapshot-right\r\n")) });
  const { placement: _oldPlacement, ...unchangedHidden } = r.alternatives.find(a => a.id !== r.selected)!;
  const snapshotHidden = snapshotDecision.alternatives.find(a => a.id !== r.selected)!;
  expect(snapshotHidden).toMatchObject(unchangedHidden);
  expect(snapshotHidden.placement?.parent).toMatchObject({ material: { object: snapshotAccepted.root }, within: ["nested", "right"] });
  await stop(); await start();
  expect(await client.conflicts(tree, leftAccepted.id, leftAccepted.root)).toEqual(leftHistory);
  expect((await client.conflicts(tree, resolved.id, resolved.root)).decisions[0]!.id).toBe(r.id);
  expect((await client.conflicts(tree, snapshotAccepted.id, snapshotAccepted.root)).decisions[0]).toEqual(snapshotDecision);
  await running.canopy.verifyIntegrity();
});

test("a stale nested source edit survives eighty intervening source and snapshot updates", async () => {
  await installNestedPeers();
  const initial = base, initialRoot = root;
  const peers: Array<{ change: string; operation: string | null }> = [];
  let current = { id: base, root };
  for (let i = 0; i < 80; i++) {
    const authored = await editAt("/nested/left/note.md", String(i).padStart(3, "0"), current.root);
    const request = i % 7 === 0 ? { ...authored, trace: null } : authored;
    peers.push({ change: request.change, operation: request.trace === null ? null : "edit" });
    current = (await client.submitUpdates(tree, { base: current.id, updates: [request] })).results[0]!.update;
  }
  const stale = await editAt("/nested/left/note.md", "old-basis", initialRoot);
  const request = { base: initial, updates: [stale] };
  const accepted = (await client.submitUpdates(tree, request)).results[0]!.update;
  expect(accepted.conflicted).toBe(true); expect(accepted.root).toBe(current.root);
  const page = await client.conflicts(tree, accepted.id, accepted.root);
  const decision = page.decisions[0]!;
  expect(new Set(decision.alternatives.find(v => v.id === decision.selected)!.contributions.map(c=>JSON.stringify(c)))).toEqual(new Set(peers.map(c=>JSON.stringify(c))));
  expect(decision.alternatives.find(v => v.id !== decision.selected)!.value).toEqual({ file: hashObject(new TextEncoder().encode("old-basis\r\n")) });
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results[0]!.update).toEqual(accepted);
  expect(await client.conflicts(tree, accepted.id, accepted.root)).toEqual(page);
  await running.canopy.verifyIntegrity();
}, 120_000);

test("TS document session admits stale intent, restarts, continues a hidden candidate and resolves through Canopy", async () => {
  const { SourceAdmissionQueue, SourceAdmissionPublisher, SourceDocumentSession } = await import("@overstory/client");
  const stateRoot = `${dir}/ts-client`;
  let installed: Awaited<ReturnType<WireClient["descriptor"]>> | undefined;
  function session() {
    const queue = new SourceAdmissionQueue(tree, stateRoot);
    const publisher = new SourceAdmissionPublisher(queue, client, async (current, snapshot) => {
      expect(snapshot.root).toBe(current.tree.root);
      installed = current;
    });
    return { queue, publisher, document: new SourceDocumentSession(queue, publisher, client, "/note", "/note.md") };
  }
  const original = session(), r1 = await original.document.snapshot();
  await client.submitUpdates(tree, { base, updates: [await edit("PEER")] });
  const intent = { basis: r1, edits: [{ offset: 0, length: 3, expected: "abc", replacement: "MINE" }], source: "MINE\r\n" };
  // Two sessions can deliver the same acknowledgement retry concurrently.
  const [local, same] = await Promise.all([original.document.admit(intent), session().document.admit(intent)]);
  expect(local).toEqual(same);
  expect(await original.queue.retained()).toHaveLength(1);
  const restarted = session();
  expect((await restarted.document.snapshot()).source).toBe("MINE\r\n");
  await restarted.publisher.publishNext();
  expect(installed!.tree.conflicted).toBe(true);
  expect((await restarted.document.snapshot()).source).toBe("PEER\r\n");
  await restarted.document.admit({ basis: local, edits: [{ offset: 0, length: 4, expected: "MINE", replacement: "LATER" }], source: "LATER\r\n" });
  await restarted.publisher.publishNext();
  expect(await restarted.publisher.pending()).toEqual([]);
  const current = await client.descriptor(tree);
  const inspection = await client.conflicts(tree, current.tree.update, current.tree.root);
  expect(inspection.decisions[0]!.alternatives.map(alternative => alternative.value)).toContainEqual({ file: hashObject(Buffer.from("LATER\r\n")) });
  const beforeResolution = await restarted.document.snapshot();
  const second = new WireClient(running.url, token), decision = inspection.decisions[0]!;
  const resolved = await second.submitUpdates(tree, { base: current.tree.update, updates: [{ change: crypto.randomUUID(), candidate: current.tree.root,
    trace: [], resolves: [{ state: current.tree.update, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) }], objects: [], deltas: [] }] });
  expect(resolved.results[0]!.update.conflicted).toBe(false);
  expect(resolved.results[0]!.update.root).toBe(current.tree.root);
  const refreshed = await restarted.document.snapshot();
  expect(refreshed.revision).not.toBe(beforeResolution.revision);
  expect(refreshed.source).toBe("PEER\r\n");
  await running.canopy.verifyIntegrity();
});

async function nestedConflict() {
  await installNestedPeers();
  const peer = await editAt("/nested/left/note.md", "PEER");
  await client.submitUpdates(tree, { base, updates: [peer] });
  const mine = await editAt("/nested/left/note.md", "MINE");
  const accepted = (await client.submitUpdates(tree, { base, updates: [mine] })).results[0]!.update;
  return { accepted, page: await client.conflicts(tree, accepted.id, accepted.root) };
}
function rootSnapshot(basis: ObjectHash, modify: (directory: ReturnType<typeof decodeWireDirectory>) => void): CandidateUpdate {
  const directory = decodeWireDirectory(objects.get(basis)!);
  modify(directory);
  directory.entries.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeWireDirectory(directory), candidate = hashObject(bytes); objects.set(candidate, bytes);
  return { change: crypto.randomUUID(), candidate, trace: null, resolves: [], objects: [{ hash: candidate, bytes }], deltas: [] };
}
const resolutionGuard = (state: string, decision: Awaited<ReturnType<WireClient["conflicts"]>>["decisions"][number]) =>
  ({ state, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) });

test("ancestor deletion retains children and requires coherent joint guards, with replay and restart", async () => {
  const { accepted, page: before } = await nestedConflict();
  const deletion = rootSnapshot(accepted.root, d => { d.entries = d.entries.filter(e => e.name !== "nested"); });
  const request = { base: accepted.id, updates: [deletion] };
  const result = (await client.submitUpdates(tree, request)).results[0]!;
  expect(result.update.conflicted).toBe(true);
  expect(result.update.root).toBe(accepted.root);
  const page = await client.conflicts(tree, result.update.id, result.update.root);
  const child = page.decisions.find(d => d.id === before.decisions[0]!.id)!;
  const ancestor = page.decisions.find(d => d.id !== child.id)!;
  expect(child.alternatives).toEqual(before.decisions[0]!.alternatives);
  expect(child.dependencies).toEqual([]);
  expect(ancestor.dependencies).toEqual([child.id]);
  expect(ancestor.alternatives.map(a => a.value)).toContainEqual({ directory: deletion.candidate });
  const snapshot = new Database(`${dir}/canopy.sqlite3`, { readonly: true });
  expect(snapshot.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: CANOPY_SCHEMA_VERSION }); snapshot.close();
  // An ancestor-only guard cannot abandon either retained child alternative.
  const incomplete = { ...deletion, change: crypto.randomUUID(), resolves: [resolutionGuard(result.update.id, ancestor)] };
  await expect(client.submitUpdates(tree, { base: result.update.id, updates: [incomplete] })).rejects.toBeInstanceOf(WireUpdateConflict);
  expect((await client.descriptor(tree)).tree.update).toBe(result.update.id);
  await stop(); await start();
  expect(await client.conflicts(tree, result.update.id, result.update.root)).toEqual(page);
  expect((await client.submitUpdates(tree, request)).results[0]!.update.id).toBe(result.update.id);
  const complete = { ...incomplete, change: crypto.randomUUID(), resolves: page.decisions.map(d => resolutionGuard(result.update.id, d)) };
  const resolved = (await client.submitUpdates(tree, { base: result.update.id, updates: [complete] })).results[0]!.update;
  expect(resolved.root).toBe(deletion.candidate);
  expect(resolved.conflicted).toBe(false);
  expect((await client.conflicts(tree, resolved.id, resolved.root)).decisions).toEqual([]);
  expect(await client.conflicts(tree, result.update.id, result.update.root)).toEqual(page);
  await running.canopy.verifyIntegrity();
});

test("selected child edits update the ancestor projection; partial keep resolution leaves children attached", async () => {
  const { accepted, page: before } = await nestedConflict();
  const deletion = rootSnapshot(accepted.root, d => { d.entries = d.entries.filter(e => e.name !== "nested"); });
  const ancestorState = (await client.submitUpdates(tree, { base: accepted.id, updates: [deletion] })).results[0]!.update;
  const firstPage = await client.conflicts(tree, ancestorState.id, ancestorState.root);
  const changed = await editAt("/nested/left/note.md", "EDITED", ancestorState.root, [0,4]);
  const continued = (await client.submitUpdates(tree, { base: ancestorState.id, updates: [changed] })).results[0]!.update;
  for (const [hash, bytes] of (await client.snapshot(tree, continued.root)).objects) objects.set(hash, bytes);
  const page = await client.conflicts(tree, continued.id, continued.root);
  const child = page.decisions.find(d => d.id === before.decisions[0]!.id)!;
  expect(child.alternatives.find(a => a.id === child.selected)!.value).toEqual({ file: hashObject(Buffer.from("EDITED\r\n")) });
  const ancestor = page.decisions.find(d => d.id !== child.id)!;
  expect(ancestor.alternatives.find(a => a.id === ancestor.selected)!.value).not.toEqual(firstPage.decisions.find(d => d.id === ancestor.id)!.alternatives.find(a => a.id === ancestor.selected)!.value);
  // An older reviewed parent is stale even though its alternative IDs survived.
  await expect(client.submitUpdates(tree, { base: continued.id, updates: [{ ...deletion, change: crypto.randomUUID(),
    resolves: firstPage.decisions.map(d => resolutionGuard(ancestorState.id, d)) }] })).rejects.toBeInstanceOf(WireUpdateConflict);
  const kept = (await client.submitUpdates(tree, { base: continued.id, updates: [{ change: crypto.randomUUID(), candidate: continued.root,
    trace: [], resolves: [resolutionGuard(continued.id, ancestor)], objects: [], deltas: [] }] })).results[0]!.update;
  expect(kept.root).toBe(continued.root); expect(kept.conflicted).toBe(true);
  const remaining = await client.conflicts(tree, kept.id, kept.root);
  expect(remaining.decisions.map(d => d.id)).toEqual([child.id]);
  expect(remaining.decisions[0]!.dependencies).toEqual([]);
  await running.canopy.verifyIntegrity();
});

test("hidden ancestor replacement continues through a batch suffix without losing child choices", async () => {
  const { accepted, page: before } = await nestedConflict();
  const body = Buffer.from("opaque ancestor"), file = hashObject(body); objects.set(file, body);
  const replacement = rootSnapshot(accepted.root, d => { d.entries = d.entries.map(e => e.name === "nested" ? { name: "nested", file } : e); });
  replacement.objects.push({ hash: file, bytes: body });
  const suffix = await editAt("/nested", "continued", replacement.candidate, [0, body.length]);
  const request = { base: accepted.id, updates: [replacement, suffix] };
  const response = await client.submitUpdates(tree, request), result = response.results[1]!.update;
  expect(result.root).toBe(accepted.root);
  const page = await client.conflicts(tree, result.id, result.root);
  const child = page.decisions.find(d => d.id === before.decisions[0]!.id)!;
  expect(child.alternatives).toEqual(before.decisions[0]!.alternatives);
  const ancestor = page.decisions.find(d => d.id !== child.id)!;
  expect(ancestor.alternatives).toHaveLength(2);
  const hidden = ancestor.alternatives.find(a => a.id !== ancestor.selected)!;
  expect(hidden.value).toEqual({ directory: suffix.candidate });
  expect(hidden.contributions.map(c => c.change)).toEqual([replacement.change, suffix.change]);
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results.map(r => r.update.id)).toEqual(response.results.map(r => r.update.id));
  expect(await client.conflicts(tree, result.id, result.root)).toEqual(page);
  await running.canopy.verifyIntegrity();
});

test("snapshot ancestor moves preserve old nested choices rather than guessing a relocation of intent", async () => {
  const { accepted, page: before } = await nestedConflict();
  const moved = rootSnapshot(accepted.root, d => { d.entries = d.entries.map(e => e.name === "nested" ? { ...e, name: "moved" } : e); });
  const result = (await client.submitUpdates(tree, { base: accepted.id, updates: [moved] })).results[0]!.update;
  const projection = await client.snapshot(tree, result.root);
  expect(decodeWireDirectory(projection.objects.get(result.root)!).entries.map(e => e.name)).toContain("nested");
  const alternatives=await client.conflicts(tree,result.id,result.root);
  expect(alternatives.decisions.flatMap(d=>d.alternatives.map(a=>a.value))).toContainEqual({directory:moved.candidate});
  const page = await client.conflicts(tree, result.id, result.root);
  expect(page.decisions.find(d => d.id === before.decisions[0]!.id)!.alternatives.map(a => a.value)).toEqual(before.decisions[0]!.alternatives.map(a => a.value));
  await running.canopy.verifyIntegrity();
});

test("several enclosing choices keep dependency closure and cannot resolve away an unguarded grandchild", async () => {
  const { accepted, page: before } = await nestedConflict();
  const rootDirectory = decodeWireDirectory(objects.get(accepted.root)!);
  const subtree = rootDirectory.entries.find(e => e.name === "nested")!.directory!;
  const inside = decodeWireDirectory(objects.get(subtree)!);
  inside.entries = inside.entries.filter(e => e.name !== "left");
  const innerBytes = encodeWireDirectory(inside), innerRoot = hashObject(innerBytes); objects.set(innerRoot, innerBytes);
  const innerDeletion = rootSnapshot(accepted.root, d => { d.entries = d.entries.map(e => e.name === "nested" ? { name: e.name, directory: innerRoot } : e); });
  innerDeletion.objects.push({ hash: innerRoot, bytes: innerBytes });
  const inner = (await client.submitUpdates(tree, { base: accepted.id, updates: [innerDeletion] })).results[0]!.update;
  const outerDeletion = rootSnapshot(inner.root, d => { d.entries = d.entries.filter(e => e.name !== "nested"); });
  const outer = (await client.submitUpdates(tree, { base: inner.id, updates: [outerDeletion] })).results[0]!.update;
  const page = await client.conflicts(tree, outer.id, outer.root);
  expect(page.decisions).toHaveLength(3);
  const leafDecision=page.decisions.find(d=>d.id===before.decisions[0]!.id)!;
  expect(leafDecision.dependencies).toEqual([]);
  expect(page.decisions.filter(d=>d.id!==leafDecision.id).every(d=>d.dependencies.includes(leafDecision.id))).toBe(true);
  const leaf = before.decisions[0]!.id;
  const incomplete = { ...outerDeletion, change: crypto.randomUUID(), resolves: page.decisions.filter(d => d.id !== leaf).map(d => resolutionGuard(outer.id, d)) };
  await expect(client.submitUpdates(tree, { base: outer.id, updates: [incomplete] })).rejects.toBeInstanceOf(WireUpdateConflict);
  const resolved = (await client.submitUpdates(tree, { base: outer.id, updates: [{ ...incomplete, change: crypto.randomUUID(), resolves: page.decisions.map(d => resolutionGuard(outer.id, d)) }] })).results[0]!.update;
  expect(resolved.conflicted).toBe(false);
  expect(resolved.root).toBe(outerDeletion.candidate);
  await running.canopy.verifyIntegrity();
});

test("a single explicit snapshot can resolve children while deleting their previously uncontested ancestor", async () => {
  const { accepted, page } = await nestedConflict();
  const deletion = rootSnapshot(accepted.root, d => { d.entries = d.entries.filter(e => e.name !== "nested"); });
  deletion.resolves = page.decisions.map(d => resolutionGuard(accepted.id, d));
  const result = (await client.submitUpdates(tree, { base: accepted.id, updates: [deletion] })).results[0]!.update;
  expect(result.root).toBe(deletion.candidate); expect(result.conflicted).toBe(false);
  await running.canopy.verifyIntegrity();
});

test("an ancestor choice can remain open while one child is explicitly resolved", async () => {
  const { accepted, page: before } = await nestedConflict();
  const deletion = rootSnapshot(accepted.root, d => { d.entries = d.entries.filter(e => e.name !== "nested"); });
  const added = (await client.submitUpdates(tree, { base: accepted.id, updates: [deletion] })).results[0]!.update;
  const page = await client.conflicts(tree, added.id, added.root), child = page.decisions.find(d => d.id === before.decisions[0]!.id)!;
  const resolved = (await client.submitUpdates(tree, { base: added.id, updates: [{ change: crypto.randomUUID(), candidate: added.root,
    trace: [], resolves: [resolutionGuard(added.id, child)], objects: [], deltas: [] }] })).results[0]!.update;
  const remaining = await client.conflicts(tree, resolved.id, resolved.root);
  expect(remaining.decisions).toHaveLength(1); expect(remaining.decisions[0]!.id).not.toBe(child.id);
  expect(remaining.decisions[0]!.dependencies).toEqual([]);
  expect(resolved.root).toBe(added.root);
  await running.canopy.verifyIntegrity();
});


test.each([false, true])("a source successor preserves an independently created entry through merged-prefix replay and restart (snapshot predecessor: %s)", async (snapshotPredecessor) => {
  const bytes = Buffer.from("Created A\n"), file = hashObject(bytes); objects.set(file, bytes);
  const create = rootSnapshot(root, d => { d.entries.push({ name: "a.md", file }); });
  create.objects.push({ hash: file, bytes });
  await client.submitUpdates(tree, { base, updates: [create] });
  const first = await edit("B1"), second = await edit("B2", first.candidate, [0,2]);
  if (snapshotPredecessor) first.trace = null;
  const prefix = await client.submitUpdates(tree, { base, updates: [first] });
  expect(prefix.results[0]!.update.root).not.toBe(first.candidate);
  await stop(); await start();
  const tool = (running.canopy as unknown as { mergeTool: import("../../../packages/canopyd/src/merge-tool.ts").MergeTool }).mergeTool;
  const evaluate = tool.evaluate.bind(tool);
  const evaluatedChanges: string[] = [];
  tool.evaluate = (async (request: any, inputs: ReadonlyMap<string, Uint8Array>) => {
    if (request.incoming?.change) evaluatedChanges.push(request.incoming.change);
    if (!snapshotPredecessor && (request.incoming?.change === first.change || request.change === first.change))
      throw new Error("An accepted prefix must not execute again");
    return evaluate(request, inputs);
  }) as typeof tool.evaluate;
  const request = { base, updates: [{ ...first, objects: [], deltas: [] }, second] };
  const response = await client.submitUpdates(tree, request), accepted = response.results[1]!.update;
  expect(response.results[0]!.update.id).toBe(prefix.results[0]!.update.id);
  expect(evaluatedChanges).not.toContain(first.change);
  expect(evaluatedChanges).toContain(second.change);
  expect(accepted.conflicted).toBe(false);
  const snapshot = await client.snapshot(tree, accepted.root);
  expect(decodeWireDirectory(snapshot.objects.get(snapshot.root)!).entries).toEqual(expect.arrayContaining([
    { name: "a.md", file }, { name: "note.md", file: hashObject(Buffer.from("B2\r\n")) },
  ]));
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results.map(r => r.update.id)).toEqual(response.results.map(r => r.update.id));
  const retained = records() as Array<{ change_id: string; basis_root: string }>;
  expect(retained.find(r => r.change_id === second.change)!.basis_root).toBe(first.candidate);
  await running.canopy.verifyIntegrity();
});

test("a continuation after a merged prefix retains an intervening same-file snapshot and hidden successors", async () => {
  const bytes = Buffer.from("A"), file = hashObject(bytes); objects.set(file, bytes);
  const create = rootSnapshot(root, d => { d.entries.push({ name: "a.md", file }); });
  create.objects.push({ hash: file, bytes });
  await client.submitUpdates(tree, { base, updates: [create] });
  const first = await edit("B1"), second = await edit("B2", first.candidate, [0,2]);
  const prefix = (await client.submitUpdates(tree, { base, updates: [first] })).results[0]!.update;
  for (const [hash, bytes] of (await client.snapshot(tree, prefix.root)).objects) objects.set(hash, bytes);
  const peer = await edit("PEER", prefix.root, [0,2]);
  await client.submitUpdates(tree, { base: prefix.id, updates: [{ ...peer, trace: null }] });
  const third = await edit("B3", second.candidate, [0,2]);
  const request = { base, updates: [first, second, third] };
  const response = await client.submitUpdates(tree, request), current = response.results[2]!.update;
  expect(current.conflicted).toBe(true);
  const page = await client.conflicts(tree, current.id, current.root), decision = page.decisions[0]!;
  expect(decision.alternatives).toHaveLength(2);
  expect(decision.alternatives.map(a => a.value)).toEqual(expect.arrayContaining([
    { file: hashObject(Buffer.from("PEER\r\n")) }, { file: hashObject(Buffer.from("B3\r\n")) },
  ]));
  expect(decision.alternatives.find(a => a.id !== decision.selected)!.contributions.map(c => c.change)).toEqual([second.change, third.change]);
  const projection = await client.snapshot(tree, current.root);
  expect(decodeWireDirectory(projection.objects.get(current.root)!).entries).toContainEqual({ name: "a.md", file });
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results.map(r => r.update.id)).toEqual(response.results.map(r => r.update.id));
  await running.canopy.verifyIntegrity();
});

test("all eight operation kinds execute through accepted authority and survive restart", async()=>{
 let head={id:base,root};
 let directory=decodeWireDirectory(objects.get(root)!);
 const body=(text:string)=>{const bytes=Buffer.from(text),hash=hashObject(bytes);objects.set(hash,bytes);return hash;};
 const ref=(name:string)=>({material:{kind:"basis" as const,path:`/${name}`,object:directory.entries.find(e=>e.name===name)!.file!}});
 const changes:string[]=[];
 const apply=async(operation:import("@overstory/protocol").SourceOperation,modify:()=>void)=>{
  modify();directory.entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));
  const bytes=encodeWireDirectory(directory),candidate=hashObject(bytes);objects.set(candidate,bytes);
  const change=crypto.randomUUID();changes.push(change);
  const update:CandidateUpdate={change,candidate,trace:[{before:head.root,after:candidate,operations:[operation]}],resolves:[],objects:[...objects].map(([hash,bytes])=>({hash,bytes})),deltas:[]};
  const result=(await client.submitUpdates(tree,{base:head.id,updates:[update]})).results[0]!;
  expect(result.update.root).toBe(candidate);expect(result.update.conflicted).toBe(false);head=result.update;
 };
 const file=(name:string,text:string)=>{directory.entries=directory.entries.map(e=>e.name===name?{name,file:body(text)}:e);};
 await apply({key:"op",kind:"editSource",source:{...ref("note.md"),range:[0,1]},text:"A"},()=>file("note.md","Abc\r\n"));
 await apply({key:"op",kind:"copySource",source:{...ref("note.md"),range:[0,1]},at:{...ref("note.md"),range:[3,3]},side:"before"},()=>file("note.md","AbcA\r\n"));
 await apply({key:"op",kind:"moveSource",source:{...ref("note.md"),range:[0,1]},at:{...ref("note.md"),range:[4,4]},side:"before"},()=>file("note.md","bcAA\r\n"));
 const parent=()=>({material:{kind:"basis" as const,path:"/",object:head.root}});
 await apply({key:"op",kind:"moveEntry",source:ref("note.md"),destination:{parent:parent(),name:"moved.md"}},()=>{directory.entries=directory.entries.map(e=>e.name==="note.md"?{...e,name:"moved.md"}:e);});
 await apply({key:"op",kind:"copyEntry",source:ref("moved.md"),destination:{parent:parent(),name:"copy.md"}},()=>{directory.entries.push({...directory.entries.find(e=>e.name==="moved.md")!,name:"copy.md"});});
 await apply({key:"op",kind:"replaceEntry",source:ref("copy.md"),value:{file:body("replacement")}},()=>file("copy.md","replacement"));
 const removed=directory.entries.find(e=>e.name==="copy.md")!;
 await apply({key:"op",kind:"removeEntry",source:ref("copy.md")},()=>{directory.entries=directory.entries.filter(e=>e.name!=="copy.md");});
 await apply({key:"op",kind:"addEntry",destination:{parent:parent(),name:"added.md"},value:{file:body("added")}},()=>{directory.entries.push({name:"added.md",file:body("added")});});
 await apply({key:"op",kind:"editSource",source:{...ref("added.md"),range:[5,5]},text:"!"},()=>file("added.md","added!"));
 await stop();await start();
 // Undo is no longer an operation: restoring the removed entry is an ordinary
 // authored replacement of its content at its old name.
 void removed;
 await running.canopy.verifyIntegrity();
});

test("authorized hidden alternative edits retain projection and public identity",async()=>{
 const {update}=await wholeConflict();
 const decision=(await client.conflicts(tree,update.id,update.root)).decisions[0]!;
 const hidden=decision.alternatives.find(a=>a.id!==decision.selected)!;
 const operation={key:"edit-hidden",kind:"editSource" as const,source:{material:{kind:"alternative" as const,state:update.id,conflict:decision.id,alternative:hidden.id}},text:"changed hidden\r\n"};
 const accepted=(await client.submitUpdates(tree,{base:update.id,updates:[{change:crypto.randomUUID(),candidate:update.root,trace:[{before:update.root,after:update.root,operations:[operation]}],resolves:[],objects:[],deltas:[]}]})).results[0]!.update;
 expect(accepted.root).toBe(update.root);expect(accepted.conflicted).toBe(true);
 const next=(await client.conflicts(tree,accepted.id,accepted.root)).decisions[0]!;
 expect(next.id).toBe(decision.id);expect(next.selected).toBe(decision.selected);
 expect(next.alternatives.find(a=>a.id===hidden.id)!.value).toEqual({file:hashObject(Buffer.from("changed hidden\r\n"))});
 await running.canopy.verifyIntegrity();
});


test("an exact accepted retry does not need an available worker",async()=>{
 const update=await edit("ACKNOWLEDGED");const request={base,updates:[update]};
 const response=await client.submitUpdates(tree,request);
 await stop();await start({command:[`${dir}/missing-worker`]});
 expect((await client.submitUpdates(tree,request)).results).toEqual(response.results);
 const next=await edit("next",update.candidate,[0,12]);
 await expect(client.submitUpdates(tree,{base:response.results[0]!.update.id,updates:[next]})).rejects.toThrow();
 expect((await client.descriptor(tree)).tree.update).toBe(response.results[0]!.update.id);
});

test("competing Markdown prose insertions are accepted without review",async()=>{
 const a=await edit(" first",root,[3,3]),b=await edit(" second",root,[3,3]);
 await client.submitUpdates(tree,{base,updates:[a]});
 const accepted=(await client.submitUpdates(tree,{base,updates:[b]})).results[0]!.update;
 expect(accepted.conflicted).toBe(false);
 const snapshot=await client.snapshot(tree,accepted.root);
 const file=decodeWireDirectory(snapshot.objects.get(accepted.root)!).entries.find(e=>e.name==="note.md")!.file!;
 const text=Buffer.from(snapshot.objects.get(file)!).toString();
 expect(text).toContain(" first");expect(text).toContain(" second");expect(text.endsWith("\r\n")).toBe(true);
});

test("source admission preserves an existing snapshot conflict's public identities",async()=>{
 const rename=rootSnapshot(root,d=>{d.entries=d.entries.map(e=>e.name==="note.md"?{...e,name:"note.txt"}:e);});
 const seeded=(await client.submitUpdates(tree,{base,updates:[rename]})).results[0]!.update;base=seeded.id;root=seeded.root;
 const a=await editAt("/note.txt","LEFT"),b=await editAt("/note.txt","RIGHT");
 await client.submitUpdates(tree,{base,updates:[{...a,trace:null}]});
 const old=(await client.submitUpdates(tree,{base,updates:[{...b,trace:null}]})).results[0]!.update;
 expect(old.conflicted).toBe(true);
 const before=(await client.conflicts(tree,old.id,old.root)).decisions;
 const snapshot=await client.snapshot(tree,old.root);for(const pair of snapshot.objects)objects.set(...pair);
 const next=await editAt("/note.txt","later",old.root,[0,1]);
 const accepted=(await client.submitUpdates(tree,{base:old.id,updates:[next]})).results[0]!.update;
 const after=(await client.conflicts(tree,accepted.id,accepted.root)).decisions;
 expect(after.map(d=>d.id)).toEqual(before.map(d=>d.id));
 expect(after.map(d=>d.alternatives.map(a=>a.id))).toEqual(before.map(d=>d.alternatives.map(a=>a.id)));
 await running.canopy.verifyIntegrity();
});


/** Make the tree's history look as it did before every acceptance recorded a
 * merge state, so its states are rebuilt by replay. Run while stopped. */
function forgetMergeStates() {
  const db = new Database(`${dir}/canopy.sqlite3`);
  try { db.run("DELETE FROM accepted_merge_states WHERE accepted_id IN (SELECT id FROM accepted_updates WHERE tree_id = ?)", [tree]); } finally { db.close(); }
}

test("cold history reads durable checkpoints without restaging its growing prefix", async () => {
  let current = root, accepted = base;
  for (let i = 0; i < 70; i++) {
    const update = await edit(String(i).padStart(3, "0"), current);
    const result = await client.submitUpdates(tree, {
      base: accepted, updates: [{ ...update, trace: null }],
    });
    current = result.results[0]!.update.root;
    accepted = result.results[0]!.update.id;
  }
  await stop(); forgetMergeStates(); await start();
  const tool = (running.canopy as unknown as {
    mergeTool: import("../../../packages/canopyd/src/merge-tool.ts").MergeTool;
  }).mergeTool;
  const original = tool.evaluate.bind(tool);
  const checkpointInputs: string[][] = [];
  const sizes: number[] = [];
  tool.evaluate = (async (request: any, inputs: ReadonlyMap<string, Uint8Array>) => {
    if (request.kind === "checkpoint-batch") {
      checkpointInputs.push([...inputs.keys()].sort()); sizes.push(request.steps.length);
    }
    return original(request, inputs);
  }) as typeof tool.evaluate;
  const update = await edit("new", current);
  const result = await client.submitUpdates(tree, { base: accepted, updates: [update] });
  expect(result.results[0]!.update.root).toBe(update.candidate);
  expect(checkpointInputs).toHaveLength(2);
  expect(sizes[0]).toBe(64);
  expect(sizes.reduce((a,b)=>a+b,0)).toBeGreaterThan(70);
  for (const inputs of checkpointInputs) expect(inputs).toEqual(checkpointInputs[0]!);
  await stop(); await start();
  expect((await client.submitUpdates(tree, { base: accepted, updates: [update] })).results[0]!.update.id)
    .toBe(result.results[0]!.update.id);
  await running.canopy.verifyIntegrity();
});


test("large historical batches split without changing their accepted basis", async () => {
  let current = root, accepted = base;
  for (let i=0;i<10;i++) {
    const update=await edit(String(i).padStart(3,"0"),current);
    const result=await client.submitUpdates(tree,{base:accepted,updates:[{...update,trace:null}]});
    current=result.results[0]!.update.root;accepted=result.results[0]!.update.id;
  }
  await stop();forgetMergeStates();await start();
  const {CheckpointBatchLimitError}=await import("@overstory/canopyd-merge");
  const tool=(running.canopy as unknown as {mergeTool:import("../../../packages/canopyd/src/merge-tool.ts").MergeTool}).mergeTool;
  const evaluate=tool.evaluate.bind(tool);let splits=0,successfulSteps=0;
  tool.evaluate=(async(request:any,inputs:ReadonlyMap<string,Uint8Array>)=>{
    if(request.kind==="checkpoint-batch"){
      if(request.steps.length>4){splits++;throw new CheckpointBatchLimitError("test budget");}
      successfulSteps+=request.steps.length;
    }
    return evaluate(request,inputs);
  }) as typeof tool.evaluate;
  const update=await edit("new",current),request={base:accepted,updates:[update]};
  const result=await client.submitUpdates(tree,request);
  expect(splits).toBeGreaterThan(0);expect(successfulSteps).toBeGreaterThan(10);
  expect(result.results[0]!.update.root).toBe(update.candidate);
  await stop();await start();
  expect((await client.submitUpdates(tree,request)).results[0]!.update.id).toBe(result.results[0]!.update.id);
  await running.canopy.verifyIntegrity();
});

test("independent source conflicts expose ranges and resolve separately across restart", async () => {
  await stop(); await start({contentChoices:"source"});
  const file = decodeWireDirectory(objects.get(root)!).entries.find(e => e.name === "note.md")!.file!;
  async function changes(first: string, last: string): Promise<CandidateUpdate> {
    const operations = [[0, first], [2, last]].map(([offset, text], index) => ({
      key: `part-${index}`, kind: "editSource" as const,
      source: {material: {kind: "basis" as const, path: "/note.md", object: file}, range: [Number(offset), Number(offset)+1] as [number,number]}, text: String(text),
    }));
    const executed = await executeExactSourceEdits(root, operations, async hash => objects.get(hash)!);
    return {change: crypto.randomUUID(), candidate: executed.root, trace: [{before: root, after: executed.root, operations}], resolves: [], objects: [...executed.generated].map(([hash,bytes])=>({hash,bytes})), deltas: []};
  }
  await client.submitUpdates(tree, {base, updates:[await changes("A","C")]});
  const conflict = (await client.submitUpdates(tree,{base,updates:[await changes("X","Z")]})).results[0]!.update;
  const page = await client.conflicts(tree,conflict.id,conflict.root);
  expect(page.decisions).toHaveLength(2);
  expect(page.decisions.map(d=>d.affected[0]!.range)).toEqual([[0,1],[2,3]]);
  expect(page.decisions.every(d=>d.kind==="content" && d.alternatives.every(a=>!a.placement))).toBe(true);
  await stop(); await start({contentChoices:"source"});
  expect(await client.conflicts(tree,conflict.id,conflict.root)).toEqual(page);
  const first = page.decisions[0]!;
  const resolved = (await client.submitUpdates(tree,{base:conflict.id,updates:[{
    change:crypto.randomUUID(),candidate:conflict.root,trace:[],resolves:[{state:conflict.id,conflict:first.id,alternatives:first.alternatives.map(a=>a.id)}],objects:[],deltas:[],
  }]})).results[0]!.update;
  expect(resolved.conflicted).toBe(true);
  const remaining=await client.conflicts(tree,resolved.id,resolved.root);
  expect(remaining.decisions).toHaveLength(1);
  expect(remaining.decisions[0]!.id).toBe(page.decisions[1]!.id);
  await running.canopy.verifyIntegrity();
});

test("source choice alternatives replace only their range and preserve an independent choice", async () => {
  await stop(); await start({contentChoices:"source"});
  const a=await rangeCandidate([{range:[0,1],text:"AAA"},{range:[2,3],text:"CCC"}]);
  const b=await rangeCandidate([{range:[0,1],text:"X"},{range:[2,3],text:"Z"}]);
  await client.submitUpdates(tree,{base,updates:[a]});
  const accepted=(await client.submitUpdates(tree,{base,updates:[b]})).results[0]!.update;
  const page=await client.conflicts(tree,accepted.id,accepted.root);
  expect(page.decisions.map(d=>d.affected[0]!.range)).toEqual([[0,3],[4,7]]);
  const snap=await client.snapshot(tree,accepted.root);
  const file=decodeWireDirectory(snap.objects.get(snap.root)!).entries.find(e=>e.name==="note.md")!.file!;
  expect(page.decisions.every(d=>d.affected[0]!.material.kind==="basis" && d.affected[0]!.material.object===file)).toBe(true);
  const decision=page.decisions[0]!, hidden=decision.alternatives.find(a=>a.id!==decision.selected)!;
  if (!("file" in hidden.value)) throw Error("Expected retained source bytes");
  expect(new TextDecoder().decode(await client.object(tree,hidden.value.file))).toBe("X");
  const bytes=new TextEncoder().encode("XbCCC\r\n"),hash=hashObject(bytes);
  const directory=decodeWireDirectory(snap.objects.get(snap.root)!);
  directory.entries.find(e=>e.name==="note.md")!.file=hash;
  const encoded=encodeWireDirectory(directory),candidate=hashObject(encoded);
  const result=(await client.submitUpdates(tree,{base:accepted.id,updates:[{
    change:crypto.randomUUID(),candidate,
    trace:[{before:accepted.root,after:candidate,operations:[
      {key:"choose",kind:"copySource",source:{material:{kind:"alternative",state:accepted.id,conflict:decision.id,alternative:hidden.id}},at:decision.affected[0]!,side:"before"},
      {key:"remove-selected",kind:"editSource",source:decision.affected[0]!,text:""},
    ]}],
    resolves:[{state:accepted.id,conflict:decision.id,alternatives:decision.alternatives.map(a=>a.id)}],
    objects:[{hash,bytes},{hash:candidate,bytes:encoded}],deltas:[],
  }]})).results[0]!.update;
  expect(result.root).toBe(candidate);
  const remaining=await client.conflicts(tree,result.id,result.root);
  expect(remaining.decisions).toHaveLength(1);
  expect(remaining.decisions[0]!.id).toBe(page.decisions[1]!.id);
  expect(remaining.decisions[0]!.affected[0]!.range).toEqual([2,5]);
  await running.canopy.verifyIntegrity();
});

test("equal-byte round trips authored as ordinary edits stay unconflicted", async () => {
  // Editors express undo and redo as fresh edits against the current basis, so
  // a round trip is an ordinary sequence that returns to earlier bytes.
  const a = await edit("ABC"), b = await edit("abc", a.candidate);
  const backToA = await edit("ABC", b.candidate), backToB = await edit("abc", backToA.candidate);
  for (const updates of [[a],[a,b],[a,b,backToA],[a,b,backToA,backToB]]) {
    const response = await client.submitUpdates(tree,{base,updates});
    expect(response.results.at(-1)!.update.root).toBe(updates.at(-1)!.candidate);
    expect(response.results.at(-1)!.update.conflicted).toBe(false);
  }
  const next = await edit("fresh",root);
  const current = await client.descriptor(tree);
  expect((await client.submitUpdates(tree,{base:current.tree.update,updates:[next]})).results[0]!.update.root).toBe(next.candidate);
});

test.each([false,true])("Markdown source copy accepts an independent edit and survives restart (copy first: %s)", async (copyFirst) => {
  const {prepareSourceAdmission}=await import("@overstory/client");
  const {decodeCandidateUpdateJSON}=await import("@overstory/protocol");
  const graph=await client.snapshot(tree,root);
  const record=prepareSourceAdmission({tree,change:"markdown-copy",basis:{kind:"accepted",root,update:base},graph,sourcePath:"/note.md",
    intent:{basis:{tree,path:"/note",revision:base,source:"abc\r\n"},source:"abc\r\nabc\r\n",edits:[{offset:5,length:0,replacement:"abc\r\n",copies:[{source:[0,5],replacement:[0,5]}]}]}});
  const copied=decodeCandidateUpdateJSON(record.update), peer=await edit("ABC");
  await client.submitUpdates(tree,{base,updates:[copyFirst?copied:peer]});
  const request={base,updates:[copyFirst?peer:copied]};
  const accepted=await client.submitUpdates(tree,request);
  const result=accepted.results[0]!.update;
  expect(result.conflicted).toBe(false);
  await stop();await start();
  expect((await client.submitUpdates(tree,request)).results[0]!.update.id).toBe(result.id);
  const snapshot=await client.snapshot(tree,result.root);
  const file=decodeWireDirectory(snapshot.objects.get(snapshot.root)!).entries.find(e=>e.name==="note.md")!.file!;
  expect(Buffer.from(snapshot.objects.get(file)!).toString()).toBe("ABC\r\nabc\r\n");
  await running.canopy.verifyIntegrity();
});
