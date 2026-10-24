import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { loadDirectoryCollection, replayCollectionRows } from "@ovst/collection-schema";
import { decodeProtocolDirectory, encodeProtocolDirectory, executeRowOperations, hashObject, ProtocolClient,
  type CandidateUpdate, type ProtocolDirectory, type SourceOperation } from "@ovst/protocol";
import { expectReplayableHistory } from "../../support/replay-check.ts";
import { collectionDirectory, idRow } from "../../support/collection-trees.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

let dir: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient;
let tree: string, base: string, root: string, objects: Map<string, Uint8Array>;
const token = "row-owner";
const SCHEMA = "model Item {\n  title Text\n  done  Bool?\n  tags  Text[]\n}\n";
const key = (id: string) => JSON.stringify([["id", id]]);

async function start() {
  running = await serveHost({ dataRoot: dir, accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = await deviceClient(running.url, token);
}
async function stop() { running.server.stop(true); await running.overstoryd[Symbol.asyncDispose](); }
function put(bytes: Uint8Array) { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; }
function directory(value: ProtocolDirectory) {
  value.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return put(encodeProtocolDirectory(value));
}
function items(at: string) { return decodeProtocolDirectory(objects.get(at)!).entries.find((e) => e.name === "items")!.directory!; }
async function rows(at: string) {
  const folder = decodeProtocolDirectory(objects.get(items(at))!);
  const collection = await loadDirectoryCollection(folder, async (hash) => objects.get(hash)!);
  return collection!.tables.Item!.map((row) => ({ ...Object.fromEntries(row.key), ...row.fields }));
}
async function remember(acceptedRoot: string) {
  for (const [hash, bytes] of (await client.snapshot(tree, acceptedRoot)).objects) objects.set(hash, bytes);
}
/** A traced row change authored on `basisRoot`. */
async function rowChange(basisRoot: string, operations: (collection: { material: { kind: "basis"; path: string; object: string } }) => SourceOperation[]): Promise<CandidateUpdate> {
  const ops = operations({ material: { kind: "basis", path: "/items", object: items(basisRoot) } });
  const result = await executeRowOperations(basisRoot, ops, async (hash) => objects.get(hash)!, replayCollectionRows);
  for (const [hash, bytes] of result.generated) objects.set(hash, bytes);
  return { change: crypto.randomUUID(), candidate: result.root, trace: [{ before: basisRoot, after: result.root, operations: ops }],
    resolves: [], deltas: [], objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) };
}
const set = (row: string, field: string, before: unknown, value: unknown, opKey = "set") => (collection: never) =>
  [{ key: opKey, kind: "rowSet", collection, model: "Item", row: key(row), field, before, value, at: now() } as SourceOperation];
/** Each operation a millisecond after the last, so row times only move forward. */
let clock = Date.parse("2026-10-24T09:00:00.000Z");
const now = () => new Date(clock++).toISOString();
async function submit(update: CandidateUpdate, basis = base) {
  return (await client.submitUpdates(tree, { base: basis, updates: [update] })).results[0]!.update;
}

beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/story-row-accept-`); await start();
  tree = (await client.account()).account.community.id;
  const descriptor = await client.descriptor(tree), initial = await client.snapshot(tree, descriptor.tree.root);
  objects = new Map(initial.objects);
  const folder = collectionDirectory(SCHEMA, { Item: [idRow("a", { title: "A", tags: ["x"] }), idRow("b", { title: "B" })] }, objects);
  const value = decodeProtocolDirectory(objects.get(initial.root)!);
  value.entries.push({ name: "items", directory: folder });
  root = directory(value);
  base = (await submit({ change: crypto.randomUUID(), candidate: root, trace: null, resolves: [], deltas: [],
    objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) }, descriptor.tree.update)).id;
});
afterEach(async () => {
  try { await expectReplayableHistory(dir, tree); }
  finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test("concurrent edits to different fields and members of one row both land", async () => {
  const first = await submit(await rowChange(root, (c) => [
    ...set("a", "title", "A", "Alpha")(c as never),
    { key: "tag", kind: "rowConnect", collection: c, model: "Item", row: key("a"), field: "tags", member: "y", at: now() } as SourceOperation,
  ]));
  expect(first.conflicted).toBe(false);
  const second = await submit(await rowChange(root, (c) => [
    ...set("a", "done", null, true)(c as never),
    { key: "tag", kind: "rowConnect", collection: c, model: "Item", row: key("a"), field: "tags", member: "z", at: now() } as SourceOperation,
  ]));
  expect(second.conflicted).toBe(false);
  await remember(second.root);
  expect(await rows(second.root)).toEqual([{ id: "a", title: "Alpha", done: true, tags: ["x", "y", "z"] }, { id: "b", title: "B" }]);
  await running.overstoryd.verifyIntegrity();
});

test("one field set twice is a choice about that field, which a resolution closes", async () => {
  await submit(await rowChange(root, set("a", "title", "A", "Mine") as never));
  const accepted = await submit(await rowChange(root, set("a", "title", "A", "Theirs") as never));
  expect(accepted.conflicted).toBe(true);
  await remember(accepted.root);
  expect((await rows(accepted.root))[0]).toMatchObject({ title: "Mine" });
  const page = await client.conflicts(tree, accepted.id, accepted.root);
  expect(page.decisions).toHaveLength(1);
  const decision = page.decisions[0]!;
  expect(decision).toMatchObject({ kind: "field", row: { model: "Item", key: key("a"), field: "title" } });
  expect(decision.alternatives.map((a) => a.value)).toEqual([{ value: "Mine" }, { value: "Theirs" }]);
  const guard = { state: accepted.id, conflict: decision.id, alternatives: decision.alternatives.map((a) => a.id) };
  // Picking "Theirs": the ordinary operation that writes it, with the resolution.
  const pick = await rowChange(accepted.root, set("a", "title", "Mine", "Theirs") as never);
  const resolved = await submit({ ...pick, resolves: [guard] }, accepted.id);
  expect(resolved.conflicted).toBe(false);
  await remember(resolved.root);
  expect((await rows(resolved.root))[0]).toMatchObject({ title: "Theirs" });
  await running.overstoryd.verifyIntegrity();
});

test("keeping the shown value resolves with no operations", async () => {
  await submit(await rowChange(root, set("a", "title", "A", "Mine") as never));
  const accepted = await submit(await rowChange(root, set("a", "title", "A", "Theirs") as never));
  const decision = (await client.conflicts(tree, accepted.id, accepted.root)).decisions[0]!;
  const resolved = await submit({ change: crypto.randomUUID(), candidate: accepted.root, trace: [], deltas: [], objects: [],
    resolves: [{ state: accepted.id, conflict: decision.id, alternatives: decision.alternatives.map((a) => a.id) }] }, accepted.id);
  expect(resolved.conflicted).toBe(false);
  expect(resolved.root).toBe(accepted.root);
});

test("deleting a row another change edited is a choice about the row", async () => {
  await submit(await rowChange(root, set("b", "title", "B", "Bee") as never));
  const accepted = await submit(await rowChange(root, (c) => [{ key: "delete", kind: "rowDelete", collection: c, model: "Item", row: key("b") } as SourceOperation]));
  expect(accepted.conflicted).toBe(true);
  const decision = (await client.conflicts(tree, accepted.id, accepted.root)).decisions[0]!;
  expect(decision).toMatchObject({ kind: "field", row: { model: "Item", key: key("b"), field: null } });
  expect(decision.alternatives.map((a) => a.value)).toEqual([{ value: { id: "b", title: "Bee" } }, { value: null }]);
});

test("a stale value seen is invalid, not merged", async () => {
  const update = await rowChange(root, set("a", "title", "A", "Alpha") as never);
  const op = update.trace![0]!.operations[0] as SourceOperation & { before: unknown };
  op.before = "stale";
  await expect(submit(update)).rejects.toThrow();
});
