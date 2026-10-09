import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CheckpointStore } from "../../../packages/canopyd-merge/src/checkpoint-store.ts";
import { encodeRetainedState, loadState, retainState, type RetainedState } from "../../../packages/canopyd-merge/src/retained-state.ts";
import { Fixture } from "./fixture.ts";
import type { SavedCheckpoint } from "../../../packages/canopyd-merge/src/sidecar.ts";
import { hashObject } from "@overstory/protocol";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "merge-records-test-")); directories.push(path); return path; }
function checkpoint(states: Map<string, RetainedState>, id: string, entry: string): SavedCheckpoint {
  const state = states.get(id)!;
  return { tree: state.tree, entry: hashObject(Buffer.from(entry)), object: state.object, state: id, decisions: [], states, objects: [] };
}
async function fixture() {
  const f = new Fixture();
  const base = f.tree({ "a.md": "hello world" });
  const mine = await f.run(f.request(base, f.tree({ "a.md": "HELLO world" }), [
    { kind: "editSource", key: "mine", source: f.ref("/a.md", "hello world", [0, 5]), text: "HELLO" },
  ], "mine"));
  const theirs = await f.run(f.request(base, f.tree({ "a.md": "Howdy world" }), [
    { kind: "editSource", key: "theirs", source: f.ref("/a.md", "hello world", [0, 5]), text: "Howdy" },
  ], "theirs", mine.result));
  return { f, id: theirs.result.state };
}

test("shared records survive a fresh process with exact identities, decisions, order and bucket shape", async () => {
  const { f, id } = await fixture();
  const path = await directory(), store = new CheckpointStore(path);
  const c = checkpoint(f.states, id, "entry");
  const bytes = Buffer.from("private immutable object");
  c.objects.push([hashObject(bytes), bytes]);
  store.write(c); store.close();
  const script = `import { CheckpointStore } from ${JSON.stringify(new URL("../../../packages/canopyd-merge/src/checkpoint-store.ts", import.meta.url).pathname)};
    import { encodeRetainedState } from ${JSON.stringify(new URL("../../../packages/canopyd-merge/src/retained-state.ts", import.meta.url).pathname)};
    const cache = new CheckpointStore(process.argv[1]);
    const c = cache.read(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ states: [...c.states].map(([id, s]) => [id, encodeRetainedState(s)]), objects: c.objects.map(([id, bytes]) => [id, Buffer.from(bytes).toString('base64')]) })); cache.close();`;
  const child = Bun.spawn([process.execPath, "-e", script, path, c.tree, c.entry], { stdout: "pipe", stderr: "inherit" });
  const restored = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(restored.states).toEqual([...c.states].map(([id, s]) => [id, encodeRetainedState(s)]));
  expect(restored.objects).toEqual(c.objects.map(([id, b]) => [id, Buffer.from(b).toString("base64")]));
});

test("incremental checkpoints share unchanged records and collection preserves other checkpoints", async () => {
  const { f, id } = await fixture();
  const path = await directory(), store = new CheckpointStore(path);
  const first = checkpoint(f.states, id, "first"); store.write(first);
  const inspect = new Database(join(path, "records-v2.sqlite"));
  const count = () => (inspect.query("SELECT count(*) AS n FROM records").get() as { n: number }).n;
  const before = count();
  const state = loadState(f.states.get(id)!); state.changes.another = hashObject(Buffer.from("another"));
  const next = retainState(f.states, state, first.object, true);
  const second = checkpoint(new Map([[next.id, f.states.get(next.id)!]]), next.id, "second"); store.write(second);
  expect(count() - before).toBeLessThan(before / 2);
  store.remove(first.tree, first.entry);
  store.collect();
  expect(store.read(second.tree, second.entry)!.state).toBe(next.id);
  // Saving a formerly collected state republishes all its dependencies.
  store.write(first);
  expect(store.read(first.tree, first.entry)!.state).toBe(id);
  store.remove(first.tree, first.entry); store.remove(second.tree, second.entry);
  // Removal drops manifests; collection, once garbage has grown, the records.
  store.collect();
  expect(count()).toBe(0);
  expect(inspect.query("SELECT count(*) AS n FROM packs").get()).toEqual({ n: 0 });
  inspect.close(); store.close();
});

test("missing records and corrupt packs invalidate the shared cache and can be rebuilt", async () => {
  const { f, id } = await fixture(); const path = await directory(), store = new CheckpointStore(path);
  const c = checkpoint(f.states, id, "entry"); store.write(c);
  const db = new Database(join(path, "records-v2.sqlite"));
  db.exec("UPDATE packs SET bytes = X'00'");
  expect(() => store.read(c.tree, c.entry)).toThrow();
  expect(store.list()).toHaveLength(0);
  store.write(c);
  expect(store.read(c.tree, c.entry)!.state).toBe(id);
  db.exec("DELETE FROM records");
  expect(() => store.read(c.tree, c.entry)).toThrow("Missing checkpoint record");
  db.close(); store.close();
});


test("failed publication rolls back dependencies and preserves the previous checkpoint", async () => {
  const { f, id } = await fixture(); const path = await directory(), store = new CheckpointStore(path);
  const c = checkpoint(f.states, id, "first"); store.write(c);
  const db = new Database(join(path, "records-v2.sqlite"));
  db.exec("CREATE TRIGGER interrupt BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'interrupted'); END;");
  const second = { ...c, entry: hashObject(Buffer.from("second")) };
  expect(() => store.write(second)).toThrow("interrupted");
  expect(store.list()).toHaveLength(1);
  expect(store.read(c.tree, c.entry)!.state).toBe(id);
  db.exec("DROP TRIGGER interrupt");
  store.write(second);
  expect(store.read(second.tree, second.entry)!.state).toBe(id);
  db.close(); store.close();
});

test("another writer's collection cannot leave memoized unpublished dependencies", async () => {
  const { f, id } = await fixture(); const path = await directory();
  const a = new CheckpointStore(path), b = new CheckpointStore(path);
  const c = checkpoint(f.states, id, "entry"); a.write(c);
  b.remove(c.tree, c.entry); b.collect();
  expect(a.list()).toHaveLength(0);
  a.write(c);
  expect(b.read(c.tree, c.entry)!.state).toBe(id);
  a.close(); b.close();
});

test("checkpoints in the previous layout are read until removed, then its file goes", async () => {
  const { f, id } = await fixture(); const path = await directory();
  // A records-v1.sqlite as the previous layout wrote it: gzip JSON packs of
  // [hash, text] by slot, text hashes, gzip objects.
  const { gzipSync } = await import("node:zlib");
  const { StateRecordWriter } = await import("../../../packages/canopyd-merge/src/retained-state.ts");
  const v1 = new Database(join(path, "records-v1.sqlite"));
  v1.exec(`CREATE TABLE packs (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE records (hash TEXT PRIMARY KEY, pack INTEGER NOT NULL, slot INTEGER NOT NULL);
    CREATE TABLE objects (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE checkpoints (tree TEXT NOT NULL, entry TEXT NOT NULL, savedAt REAL NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY(tree, entry));`);
  const records: Array<[string, string]> = [];
  const writer = new StateRecordWriter((bytes) => { const hash = hashObject(bytes); records.push([hash, new TextDecoder().decode(bytes)]); return hash; });
  const c = checkpoint(f.states, id, "legacy");
  const bytes = Buffer.from("private object");
  c.objects.push([hashObject(bytes), bytes]);
  const states = [...c.states].map(([sid, s]) => [sid, writer.state(s)]);
  v1.query("INSERT INTO packs VALUES (1, ?)").run(gzipSync(JSON.stringify(records)));
  records.forEach(([hash], slot) => v1.query("INSERT OR IGNORE INTO records VALUES (?, 1, ?)").run(hash, slot));
  v1.query("INSERT INTO objects VALUES (?, ?)").run(hashObject(bytes), gzipSync(bytes));
  v1.query("INSERT INTO checkpoints VALUES (?, ?, 1, ?)").run(c.tree, c.entry, JSON.stringify({
    format: "arbor-merge-records-1", tree: c.tree, entry: c.entry, object: c.object, state: c.state, decisions: [], states, objects: [hashObject(bytes)] }));
  v1.close();
  const store = new CheckpointStore(path);
  expect(store.list().map((e) => e.entry)).toEqual([c.entry]);
  const restored = store.read(c.tree, c.entry)!;
  expect([...restored.states].map(([sid, s]) => [sid, encodeRetainedState(s)])).toEqual([...c.states].map(([sid, s]) => [sid, encodeRetainedState(s)]));
  expect(restored.objects).toEqual([[hashObject(bytes), new Uint8Array(bytes)]]);
  // Saving the same checkpoint again moves it to the current layout, and the
  // old file goes with its last checkpoint.
  store.write(restored);
  expect(store.list().map((e) => e.entry)).toEqual([c.entry]);
  expect(await Bun.file(join(path, "records-v1.sqlite")).exists()).toBe(false);
  expect(store.read(c.tree, c.entry)!.state).toBe(c.state);
  store.close();
});
