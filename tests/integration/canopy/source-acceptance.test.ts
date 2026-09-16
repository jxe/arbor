import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveCanopy } from "@arbor/canopy";
import { WireClient, WireUpdateConflict, WireUnsupportedOperation, decodeWireDirectory, encodeWireDirectory, hashObject, type CandidateUpdate, type ObjectHash } from "@arbor/wire";
import { executeExactSourceEdits } from "../../../packages/canopy/src/updates/source-edits.ts";

let dir: string, running: Awaited<ReturnType<typeof serveCanopy>>, client: WireClient;
let tree: string, base: string, root: ObjectHash, objects: Map<ObjectHash, Uint8Array>;
const token = "source-test-owner";
async function start() {
  running = await serveCanopy({ dataRoot: dir, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
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
  const file = decodeWireDirectory(objects.get(basis)!).entries.find(e => e.name === "note.md")!.file!;
  const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: "/note.md", object: file }, range }, text }];
  const executed = await executeExactSourceEdits(basis, operations, async hash => objects.get(hash)!);
  for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
  return { change: crypto.randomUUID(), candidate: executed.root, operations, resolves: [], objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })), deltas: [] };
}
function records() {
  const db = new Database(`${dir}/canopy.sqlite3`);
  try { return db.query("SELECT * FROM authored_changes WHERE tree_id = ?").all(tree); } finally { db.close(); }
}
test("accepts exact source, retains evidence across restart, and replays after snapshot advancement", async () => {
  const update = await edit("ABC"), request = { base, updates: [update] };
  const accepted = await client.submitUpdates(tree, request);
  expect(accepted.results[0]!.outcome).toBe("accepted");
  expect(accepted.results[0]!.update.root).toBe(update.candidate);
  expect(records()).toHaveLength(1);
  const snapshot = await edit("XYZ", update.candidate);
  await client.submitUpdates(tree, { base: accepted.results[0]!.update.id, updates: [{ ...snapshot, operations: null }] });
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
test("concurrent authors retain one accepted edit and return the other as an explicit conflict", async () => {
  const a = await edit("AAA"), b = await edit("BBB");
  const results = await Promise.allSettled([client.submitUpdates(tree, { base, updates: [a] }), client.submitUpdates(tree, { base, updates: [b] })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(WireUpdateConflict);
  expect([a.candidate, b.candidate]).toContain(rejected.reason.result.details.candidate);
  expect(records()).toHaveLength(1);
});
test("a stale equal-root basis cannot erase newer intent", async () => {
  await client.submitUpdates(tree, { base, updates: [await edit("abc")] });
  await expect(client.submitUpdates(tree, { base, updates: [await edit("ABC")] })).rejects.toBeInstanceOf(WireUpdateConflict);
  expect(records()).toHaveLength(1);
});
test("candidate mismatch and dynamic unsupported forms reject before any prefix commits", async () => {
  const first = await edit("ABC"), second = await edit("DEF", first.candidate);
  const before = running.canopy.currentUpdate(tree);
  await expect(client.submitUpdates(tree, { base, updates: [{ ...first, candidate: root }] })).rejects.toThrow("do not explain candidate");
  const overlapping = { ...second, operations: [...second.operations!, { ...second.operations![0]!, key: "overlap" }] };
  await expect(client.submitUpdates(tree, { base, updates: [first, overlapping] })).rejects.toBeInstanceOf(WireUnsupportedOperation);
  expect(running.canopy.currentUpdate(tree)).toEqual(before);
  expect(records()).toHaveLength(0);
});
test("reusing a retained change for another operation or snapshot cannot mutate authority", async () => {
  const first = await edit("ABC");
  const response = await client.submitUpdates(tree, { base, updates: [first] });
  const next = await edit("DEF", first.candidate);
  for (const operations of [next.operations, null]) {
    await expect(client.submitUpdates(tree, { base: response.results[0]!.update.id, updates: [{ ...next, change: first.change, operations }] })).rejects.toThrow("identity is already bound");
  }
  expect(records()).toHaveLength(1);
});
test("injected provenance write failure rolls back acceptance and permits exact retry", async () => {
  const db = new Database(`${dir}/canopy.sqlite3`);
  db.run("CREATE TRIGGER fail_source AFTER INSERT ON authored_changes BEGIN SELECT RAISE(ABORT, 'injected source failure'); END");
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
  const row = db.query("SELECT merge_summary FROM accepted_updates WHERE id = ?").get(accepted.results[0]!.update.id) as { merge_summary: string };
  expect(JSON.parse(row.merge_summary)).toMatchObject({ version: "exact-source-disjoint-v1", basis: { id: base, root },
    contributions: [a,b,c].map(update => ({ change: update.change, operation: "edit" })) });
  expect(JSON.parse(row.merge_summary).rules).toMatchObject([{ path: "/note.md", rule: "markdown-prose-disjoint", revision: 1, outcome: "resolved" }]);
  db.close();
  const replay = await client.submitUpdates(tree, request);
  expect(replay.results[0]!.update).toEqual(accepted.results[0]!.update);
  expect(records()).toHaveLength(3);
  // A baseline snapshot client can edit the merged projection normally.
  const next = await edit("snapshot", expected.candidate);
  const snapshot = await client.submitUpdates(tree, { base: accepted.results[0]!.update.id, updates: [{ ...next, operations: null }] });
  expect(snapshot.results[0]!.update.root).toBe(next.candidate);
  expect(records()).toHaveLength(3);
  await running.canopy.verifyIntegrity();
});
test("a batch suffix cannot mistake a merged predecessor candidate for the accepted projection", async () => {
  await client.submitUpdates(tree, { base, updates: [await edit("A", root, [0,1])] });
  const first = await edit("C", root, [2,3]), second = await edit("x", first.candidate, [1,2]);
  try { await client.submitUpdates(tree, { base, updates: [first, second] }); throw new Error("Expected conflict"); }
  catch (error) {
    expect(error).toBeInstanceOf(WireUpdateConflict);
    const result = (error as WireUpdateConflict).result;
    expect(result.details.completed).toHaveLength(1);
    expect(result.details.failedIndex).toBe(1);
    expect(result.details.current.root).toBe((await edit("AbC")).candidate);
  }
  expect(records()).toHaveLength(2);
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
  const hiddenURL = `${running.url}/.arbor/trees/${tree}/conflicts/${decision.id}/alternatives/${hidden.id}/objects/${hidden.value.file}?state=${update.id}`;
  const response = await fetch(hiddenURL, { headers: { authorization: `Bearer ${token}` } });
  expect(await response.text()).toBe("second\r\n");
  const visible = await edit("continued", update.root, [0,5]);
  const next = (await client.submitUpdates(tree, { base: update.id, updates: [{ ...visible, operations: null }] })).results[0]!.update;
  expect(next.conflicted).toBe(true);
  await stop(); await start();
  const continued = await client.conflicts(tree, next.id, next.root);
  expect(continued.decisions[0]!.id).toBe(decision.id);
  expect(continued.decisions[0]!.alternatives.find(a => a.id === hidden.id)).toMatchObject({ id: hidden.id, revision: hidden.revision, value: hidden.value, contributions: hidden.contributions });
  expect(await client.conflicts(tree, update.id, update.root)).toEqual(page);
  const resolution = { change: crypto.randomUUID(), candidate: next.root, operations: [], resolves: [{ state: next.id, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) }], objects: [], deltas: [] };
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
  const request = { base: update.id, updates: [{ change: crypto.randomUUID(), candidate, operations: null, resolves: [], objects: [{ hash: candidate, bytes }], deltas: [] }] };
  const deleted = (await client.submitUpdates(tree, request)).results[0]!.update;
  expect(deleted.conflicted).toBe(true);
  const current = await client.conflicts(tree, deleted.id, deleted.root);
  expect(current.decisions[0]!.alternatives.find(a => a.id === decision.selected)!.value).toEqual({ absent: true });
  const hidden = decision.alternatives.find(a => a.id !== decision.selected)!;
  expect(current.decisions[0]!.alternatives.find(a => a.id === hidden.id)).toMatchObject({ id: hidden.id, revision: hidden.revision, value: hidden.value, contributions: hidden.contributions });
  await expect(client.submitUpdates(tree, { base: deleted.id, updates: [{ change: crypto.randomUUID(), candidate: deleted.root, operations: [], resolves: [{ state: update.id, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) }], objects: [], deltas: [] }] })).rejects.toBeInstanceOf(WireUpdateConflict);
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
    return { change: crypto.randomUUID(), candidate: result.root, operations, resolves: [], objects: [...result.generated].map(([hash,bytes]) => ({ hash,bytes })), deltas: [] };
  }
  await client.submitUpdates(tree, { base, updates: [await peer("left")] });
  const accepted = (await client.submitUpdates(tree, { base, updates: [await peer("right")] })).results[0]!.update;
  const first = await client.conflicts(tree, accepted.id, accepted.root);
  expect(first.decisions).toHaveLength(32); expect(first.next).not.toBeNull();
  const last = await client.conflicts(tree, accepted.id, accepted.root, { after: first.next! });
  expect(last.decisions).toHaveLength(1); expect(last.next).toBeNull();
  const d = first.decisions[0]!;
  const next = (await client.submitUpdates(tree, { base: accepted.id, updates: [{ change: crypto.randomUUID(), candidate: accepted.root, operations: [], resolves: [{ state: accepted.id, conflict: d.id, alternatives: d.alternatives.map(a => a.id) }], objects: [], deltas: [] }] })).results[0]!.update;
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
  await client.submitUpdates(tree, { base: update.id, updates: [{ ...a, operations: null }] });
  const next = (await client.submitUpdates(tree, { base: update.id, updates: [{ ...b, operations: null }] })).results[0]!.update;
  expect(next.conflicted).toBe(true);
  expect((await client.conflicts(tree, next.id, next.root)).decisions[0]!.alternatives).toHaveLength(3);
});
test("a failed conflict-state insert cannot acknowledge or partially publish a conflict", async () => {
  const a = await edit("first", root, [0,5]), b = await edit("second", root, [0,5]);
  const prior = (await client.submitUpdates(tree, { base, updates: [a] })).results[0]!.update;
  const db = new Database(`${dir}/canopy.sqlite3`);
  db.run("CREATE TRIGGER fail_conflict AFTER INSERT ON accepted_conflicts BEGIN SELECT RAISE(ABORT, 'injected conflict failure'); END");
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
  const response = await fetch(`${running.url}/.arbor/trees/${tree}/conflicts/${decision.id}/alternatives/${hidden.id}/objects/${hidden.value.file}?state=${head.id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(await response.text()).toBe("continued hidden\r\n");
  const replay = await client.submitUpdates(tree, request);
  expect(replay.results.map(r => r.update.id)).toEqual(result.results.map(r => r.update.id));
  expect(await client.conflicts(tree, head.id, head.root)).toEqual(page);
});
test("snapshot change identities cannot be reused to impersonate later alternative contributions", async () => {
  const { update } = await wholeConflict();
  const first = await edit("snapshot", update.root, [0,5]);
  const next = (await client.submitUpdates(tree, { base: update.id, updates: [{ ...first, operations: null }] })).results[0]!.update;
  const second = await edit("different", next.root, [0,8]);
  await expect(client.submitUpdates(tree, { base: next.id, updates: [{ ...second, operations: null, change: first.change }] })).rejects.toThrow("identity is already bound");
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
  const placed = (await client.submitUpdates(tree, { base: update.id, updates: [{ change: crypto.randomUUID(), candidate, operations: null, resolves: [], objects: [...objects].map(([hash,bytes]) => ({ hash,bytes })), deltas: [] }] })).results[0]!.update;
  async function nested(basis: ObjectHash, object: ObjectHash, range: [number,number], text: string): Promise<CandidateUpdate> {
    const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: "/note.md/child.txt", object }, range }, text }];
    const result = await executeExactSourceEdits(basis, operations, async hash => objects.get(hash)!);
    for (const value of result.generated) objects.set(...value);
    return { change: crypto.randomUUID(), candidate: result.root, operations, resolves: [], objects: [...result.generated].map(([hash,bytes]) => ({ hash,bytes })), deltas: [] };
  }
  const first = await nested(candidate, file, [0,1], "A"), second = await nested(first.candidate, hashObject(new TextEncoder().encode("Abc")), [1,2], "B");
  const result = await client.submitUpdates(tree, { base: placed.id, updates: [first, second] });
  const final = result.results[1]!.update;
  expect(final.root).toBe(second.candidate);
  const page = await client.conflicts(tree, final.id, final.root);
  expect(page.decisions[0]!.alternatives).toHaveLength(2);
  const selected = page.decisions[0]!.alternatives.find(a => a.id === page.decisions[0]!.selected)!;
  expect(selected.contributions.map(c => c.change)).toContain(second.change);
  expect(page.decisions[0]!.alternatives.some(a => "file" in a.value)).toBe(true);
  await running.canopy.verifyIntegrity();
});
