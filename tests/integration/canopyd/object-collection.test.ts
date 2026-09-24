import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdtemp, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectObjects, serveCanopy } from "@overstory/canopyd";
import { ObjectStore } from "@overstory/object-store";
import { WireClient, decodeWireDirectory, encodeWireDirectory, hashObject,
  type CandidateUpdate, type WireDirectory, type WireDirectoryEntry } from "@overstory/protocol";
import { acceptedEntries } from "../../support/log-entries.ts";
import { expectReplayableHistory } from "../../support/replay-check.ts";

const DAY = 24 * 60 * 60 * 1000;
let dir: string, running: Awaited<ReturnType<typeof serveCanopy>>, client: WireClient, store: ObjectStore;
let tree: string, base: string, root: string, objects: Map<string, Uint8Array>;
const token = "collection-owner";

async function start() {
  running = await serveCanopy({ dataRoot: dir, accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = new WireClient(running.url, token);
}
async function stop() { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); }
/** A fresh process: nothing read from an in-memory object cache. */
async function restart() { await stop(); await start(); }

const encoder = new TextEncoder();
function bytesOf(text: string) { const bytes = encoder.encode(text); return { hash: hashObject(bytes), bytes }; }
function file(text: string) { const { hash, bytes } = bytesOf(text); objects.set(hash, bytes); return hash; }
function directory(value: WireDirectory) {
  value.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeWireDirectory(value), hash = hashObject(bytes); objects.set(hash, bytes); return hash;
}
function change(basis: string, entries: Record<string, Omit<WireDirectoryEntry, "name"> | null>): string {
  const value = decodeWireDirectory(objects.get(basis)!);
  for (const [name, entry] of Object.entries(entries)) {
    value.entries = value.entries.filter((e) => e.name !== name);
    if (entry) value.entries.push({ name, ...entry } as WireDirectoryEntry);
  }
  return directory(value);
}
function snapshot(candidate: string, omit: string[] = []): CandidateUpdate {
  return { change: crypto.randomUUID(), candidate, trace: null, resolves: [], deltas: [],
    objects: [...objects].filter(([hash]) => !omit.includes(hash)).map(([hash, bytes]) => ({ hash, bytes })) };
}
async function submit(update: CandidateUpdate, basis = base) {
  return (await client.submitUpdates(tree, { base: basis, updates: [update] })).results[0]!.update;
}
const held = (hash: string) => access(store.path(hash)).then(() => true, () => false);

/** Every stored file, set `days` into the past. */
async function age(days = 2) {
  const past = new Date(Date.now() - days * DAY);
  for (const shard of await readdir(join(dir, "objects")))
    for (const name of await readdir(join(dir, "objects", shard))) await utimes(join(dir, "objects", shard, name), past, past);
}

beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/arbor-object-collection-`); await start();
  store = new ObjectStore(join(dir, "objects"));
  tree = (await client.account()).account.community.id;
  const descriptor = await client.descriptor(tree), initial = await client.snapshot(tree, descriptor.tree.root);
  objects = new Map(initial.objects);
  root = change(initial.root, { "asset.bin": { file: file("original\0") }, "note.md": { file: file("---\nid: note\n---\nFirst\n") } });
  base = (await submit(snapshot(root), descriptor.tree.update)).id;
  // A later version of the document, then a binary conflict with alternatives.
  root = change(root, { "note.md": { file: file("---\nid: note\n---\nSecond\n") } });
  base = (await submit(snapshot(root))).id;
  await submit(snapshot(change(root, { "asset.bin": { file: file("left\0") } })));
  const conflicted = await submit(snapshot(change(root, { "asset.bin": { file: file("right\0") } })));
  expect(conflicted.conflicted).toBe(true);
});
afterEach(async () => {
  try { await expectReplayableHistory(dir, tree); }
  finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test("collection deletes only old unreferenced objects and leaves an intact, replayable history", async () => {
  // Dead objects: a body and a directory no accepted update names.
  const junk = bytesOf("never accepted");
  const junkBytes = encodeWireDirectory({ type: "directory", entries: [{ name: "x", file: junk.hash }] });
  const junkDirectory = { hash: hashObject(junkBytes), bytes: junkBytes };
  // A document version whose body no retained root holds any more, as after migration 016.
  const oldBody = bytesOf("---\nid: note\n---\nSquashed\n");
  await store.store([junk, junkDirectory, oldBody]);
  const db = new Database(join(dir, "canopy.sqlite3"));
  db.run("INSERT INTO document_versions (tree_id, stable_key, update_id, entry_path, content_hash, accepted_at) VALUES (?, 'id:note', 'squashed', '/note.md', ?, 0)", [tree, oldBody.hash]);
  db.close();
  await age();
  const young = bytesOf("uploaded a moment ago");
  await store.store([young]);

  const retained = acceptedEntries(dir, tree);
  const decisions = retained.flatMap(({ entry }) => entry.decisions);
  expect(decisions.length).toBeGreaterThan(0);
  const pages = await Promise.all(retained.filter(({ entry }) => entry.decisions.length)
    .map(async ({ id, entry }) => ({ id, root: entry.root, page: await client.conflicts(tree, id, entry.root) })));

  const dry = await collectObjects(dir, { graceMs: DAY });
  expect(dry.mode).toBe("dry-run");
  expect(dry.deleted.objects).toBeGreaterThanOrEqual(2);
  expect(await held(junk.hash)).toBe(true);

  const report = await collectObjects(dir, { delete: true, graceMs: DAY });
  expect(report.deleted).toEqual(dry.deleted);
  expect(report.scanned.objects).toBe(report.live.objects + report.young.objects + report.deleted.objects);
  expect(report.young.objects).toBe(1);
  expect(await held(junk.hash)).toBe(false);
  expect(await held(junkDirectory.hash)).toBe(false);
  expect(await held(young.hash)).toBe(true);
  expect(await held(oldBody.hash)).toBe(true);
  for (const { hash, entry } of retained) {
    expect(await held(hash)).toBe(true);
    for (const d of entry.decisions) for (const a of d.alternatives) await store.completeSnapshot(a.object);
  }

  await restart();
  await running.canopy.verifyIntegrity();
  for (const { id, root: at, page } of pages) expect(await client.conflicts(tree, id, at)).toEqual(page);
  expect((await collectObjects(dir, { delete: true, graceMs: DAY })).deleted.objects).toBe(0);
});

test("an update accepted during collection keeps the old objects it names", async () => {
  await age();
  // Old, unreferenced objects a new update names again: one the client
  // omits because the host holds it, one it sends again.
  const omitted = bytesOf("revived without upload"), resent = bytesOf("revived by upload");
  await store.store([omitted, resent]);
  await age();
  let accepted = "";
  const report = await collectObjects(dir, {
    delete: true, graceMs: DAY,
    beforeRemoval: async (candidates) => {
      expect(candidates).toEqual(expect.arrayContaining([omitted.hash, resent.hash]));
      objects.set(resent.hash, resent.bytes);
      const candidate = change(root, { "omitted.txt": { file: omitted.hash }, "resent.txt": { file: resent.hash } });
      accepted = (await submit(snapshot(candidate, [omitted.hash]), base)).root;
    },
  });
  expect(report.kept).toBe(2);
  expect(await held(omitted.hash)).toBe(true);
  expect(await held(resent.hash)).toBe(true);
  await restart();
  await running.canopy.verifyIntegrity();
  expect((await client.snapshot(tree, accepted)).objects.get(omitted.hash)).toEqual(omitted.bytes);
});

test("a run that was interrupted after setting an object aside puts it back", async () => {
  const { entry } = acceptedEntries(dir, tree).at(-1)!;
  const path = store.path(entry.root);
  await rename(path, `${path}.${crypto.randomUUID()}.collect`);
  const report = await collectObjects(dir, { delete: true, graceMs: 0 });
  expect(report.recovered).toBe(1);
  expect((await stat(path)).isFile()).toBe(true);
  expect((await readdir(join(path, ".."))).some((name) => name.endsWith(".collect"))).toBe(false);
  await restart();
  await running.canopy.verifyIntegrity();
});
