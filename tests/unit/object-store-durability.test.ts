import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { holdsObject, ObjectStore } from "@overstory/object-store";
import { encodeWireDirectory, hashObject } from "@overstory/protocol";

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
  // One fsync per file, one per shard directory, one for the root.
  expect(store.writes.fsyncs).toBe(40 + shards.size + 1);
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
  // File, shard directory, root.
  expect(store.writes.fsyncs).toBe(3);
  await store.store([a]);
  expect(store.writes.fsyncs).toBe(3);
});

test("objects present from another process are synced once, then remembered", async () => {
  const first = new ObjectStore(join(directory, "objects"));
  const a = object("from before");
  await first.store([a]);
  const second = new ObjectStore(join(directory, "objects"));
  await second.store([a]);
  expect(second.writes.written).toBe(0);
  expect(second.writes.fsyncs).toBe(3);
  await second.store([a]);
  expect(second.writes.fsyncs).toBe(3);
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
  const bytes = encodeWireDirectory({ type: "directory", entries: [{ name: "a", file: leaf.hash }, { name: "b", file: proposed.hash }] });
  const root = { hash: hashObject(bytes), bytes };
  await store.store([leaf, root]);
  for (const { hash } of [leaf, root]) await utimes(store.path(hash), twoDaysAgo(), twoDaysAgo());
  await store.verifyReachable([root.hash], new Map([[proposed.hash, proposed.bytes]]), { freshen: true });
  for (const { hash } of [leaf, root]) expect(await recent(store.path(hash))).toBe(true);
  expect(await holdsObject(store, proposed.hash)).toBe(false);
  await expect(store.freshen([proposed.hash])).rejects.toThrow("Stored object vanished");
});
