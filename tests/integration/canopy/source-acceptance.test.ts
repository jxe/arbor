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
  expect(JSON.parse(row.merge_summary)).toEqual({ version: "exact-source-disjoint-v1", basis: { id: base, root },
    contributions: [a,b,c].map(update => ({ change: update.change, operation: "edit" })) });
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
