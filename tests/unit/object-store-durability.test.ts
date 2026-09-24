import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { holdsObject, ObjectStore } from "@overstory/object-store";
import { encodeProtocolDirectory, hashObject } from "@overstory/protocol";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "object-durability-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const object = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { hash: hashObject(bytes), bytes };
};

test("a durable batch syncs each new file once and each directory once", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const objects = Array.from({ length: 40 }, (_, i) => object(`object ${i}`));
  const shards = new Set(objects.map((o) => dirname(store.path(o.hash))));
  await store.store(objects);
  expect(store.writes.written).toBe(40);
  // One fsync per file, one per new shard directory, one for the root, and
  // once per process one for the root's own entry in its parent.
  expect(store.writes.fsyncs).toBe(40 + shards.size + 2);
  for (const o of objects) expect(await store.read(o.hash)).toEqual(o.bytes);
  for (const shard of shards) {
    for (const name of await readdir(shard)) expect(name).not.toContain(".tmp");
  }
});

test("re-storing objects this process already made durable issues no fsync", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const objects = Array.from({ length: 5 }, (_, i) => object(`again ${i}`));
  await store.store(objects);
  const after = store.writes.fsyncs;
  await store.store(objects);
  await store.store(objects.slice(2));
  expect(store.writes.fsyncs).toBe(after);
  expect(store.writes.written).toBe(5);
});

test("staged objects become durable on the first durable store without rewriting", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("staged first");
  await store.stage([a]);
  expect(store.writes.fsyncs).toBe(0);
  await store.store([a]);
  expect(store.writes.written).toBe(1);
  // File, shard directory, root, root entry.
  expect(store.writes.fsyncs).toBe(4);
  await store.store([a]);
  expect(store.writes.fsyncs).toBe(4);
});

test("objects present from another process are synced once, then remembered", async () => {
  const first = new ObjectStore(join(directory, "objects"));
  const a = object("from before");
  await first.store([a]);
  const second = new ObjectStore(join(directory, "objects"));
  await second.store([a]);
  expect(second.writes.written).toBe(0);
  expect(second.writes.fsyncs).toBe(4);
  await second.store([a]);
  expect(second.writes.fsyncs).toBe(4);
});

/** Distinct objects whose hashes share one shard directory. */
const sameShard = (count: number, prefix: string) => {
  const found: Array<ReturnType<typeof object>> = [];
  for (let i = 0; found.length < count; i++) {
    const candidate = object(`${prefix} ${i}`);
    if (!found.length || candidate.hash.slice(7, 9) === found[0]!.hash.slice(7, 9)) found.push(candidate);
  }
  return found;
};

test("the root is synced only for a shard whose entry is not yet known durable", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const [a, b] = sameShard(2, "shard");
  await store.store([a!]);
  // File, new shard directory, root, root entry.
  expect(store.writes.fsyncs).toBe(4);
  await store.store([b!]);
  // File and its already rooted shard directory only.
  expect(store.writes.fsyncs).toBe(6);
  let c = object("elsewhere");
  for (let i = 0; c.hash.slice(7, 9) === a!.hash.slice(7, 9); i++) c = object(`elsewhere ${i}`);
  await store.store([c]);
  expect(store.writes.fsyncs).toBe(9);
});

test("a shard a staged publish or another store made is rooted on its first durable use", async () => {
  const [a, b, c] = sameShard(3, "foreign");
  const first = new ObjectStore(join(directory, "objects"));
  await first.stage([a!]);
  await first.store([b!]);
  // File, shard directory, root, root entry: staging synced no directory.
  expect(first.writes.fsyncs).toBe(4);
  const second = new ObjectStore(join(directory, "objects"));
  await second.store([c!]);
  expect(second.writes.fsyncs).toBe(4);
});

test("re-storing an object this process made durable freshens it without reading it", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const value = object("durable here");
  await store.store([value]);
  const path = store.path(value.hash);
  // Bytes changed behind the store's back show the repeat store never reads
  // them; every read still hash-checks, so the damage is caught there.
  await writeFile(path, "damaged");
  await utimes(path, twoDaysAgo(), twoDaysAgo());
  await store.store([value]);
  expect(await recent(path)).toBe(true);
  expect(store.writes.written).toBe(1);
  expect(store.writes.fsyncs).toBe(4);
  await expect(new ObjectStore(join(directory, "objects")).read(value.hash)).rejects.toThrow("Stored object hash mismatch");
});

test("re-storing a durable object the collector removed writes it again", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const value = object("collected");
  await store.store([value]);
  await rm(store.path(value.hash));
  await store.store([value]);
  expect(await store.read(value.hash)).toEqual(value.bytes);
  expect(store.writes.written).toBe(2);
});

test("an object not known to this process has its stored bytes checked", async () => {
  const value = object("checked");
  await new ObjectStore(join(directory, "objects")).store([value]);
  const other = new ObjectStore(join(directory, "objects"));
  await writeFile(other.path(value.hash), "tampered");
  await expect(other.store([value])).rejects.toThrow("Stored object hash mismatch");
});

test("durable store still rejects mismatched existing bytes", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("right");
  await store.store([a]);
  const other = new ObjectStore(join(directory, "objects"));
  await expect(other.store([{ hash: a.hash, bytes: object("wrong").bytes }])).rejects.toThrow("Object hash mismatch");
});

const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const recent = async (path: string) => (await stat(path)).mtimeMs > Date.now() - 60_000;

test("storing an object that already exists freshens it for the object collector", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const value = object("kept by reuse");
  await store.store([value]);
  await utimes(store.path(value.hash), twoDaysAgo(), twoDaysAgo());
  await store.store([value]);
  expect(await recent(store.path(value.hash))).toBe(true);
  expect(store.writes.written).toBe(1);
});

test("a verified walk freshens only stored objects, and freshening a vanished object throws", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const leaf = object("leaf"), proposed = object("proposed");
  const bytes = encodeProtocolDirectory({ type: "directory", entries: [{ name: "a", file: leaf.hash }, { name: "b", file: proposed.hash }] });
  const root = { hash: hashObject(bytes), bytes };
  await store.store([leaf, root]);
  for (const { hash } of [leaf, root]) await utimes(store.path(hash), twoDaysAgo(), twoDaysAgo());
  await store.verifyReachable([root.hash], new Map([[proposed.hash, proposed.bytes]]), { freshen: true });
  for (const { hash } of [leaf, root]) expect(await recent(store.path(hash))).toBe(true);
  expect(await holdsObject(store, proposed.hash)).toBe(false);
  await expect(store.freshen([proposed.hash])).rejects.toThrow("Stored object vanished");
});
