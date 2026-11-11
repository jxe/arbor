import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdsObject, ObjectStore } from "@ovst/object-store";
import { encodeProtocolDirectory, hashObject } from "@ovst/protocol";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "object-durability-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const object = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { hash: hashObject(bytes), bytes };
};

const journals = async () => (await readdir(join(directory, "objects", "packs"))).filter((n) => n.startsWith("journal-"));
const journalPath = async () => join(directory, "objects", "packs", (await journals())[0]!);
const usedAt = (store: ObjectStore, hash: string) => {
  const row = store.packs.index()!.query("SELECT used_at FROM packed_objects WHERE hash = ?").get(Buffer.from(hash.slice(7), "hex")) as { used_at: number } | null;
  return row?.used_at;
};

test("a durable batch is one journal append and one sync, with no loose files", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const objects = Array.from({ length: 40 }, (_, i) => object(`object ${i}`));
  await store.store(objects);
  expect(store.writes.written).toBe(40);
  expect(store.writes.fsyncs).toBe(1);
  for (const o of objects) {
    expect(await store.read(o.hash)).toEqual(o.bytes);
    expect(await new ObjectStore(join(directory, "objects")).read(o.hash)).toEqual(o.bytes);
  }
  expect(await readdir(join(directory, "objects"))).toEqual(["packs"]);
  expect(await journals()).toHaveLength(1);
  await store.store([object("one more")]);
  expect(store.writes.fsyncs).toBe(2);
  expect(await journals()).toHaveLength(1);
});

test("re-storing durable objects writes and syncs nothing, in this process or another", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const objects = Array.from({ length: 5 }, (_, i) => object(`again ${i}`));
  await store.store(objects);
  await store.store(objects);
  await store.store(objects.slice(2));
  expect(store.writes.fsyncs).toBe(1);
  expect(store.writes.written).toBe(5);
  const second = new ObjectStore(join(directory, "objects"));
  await second.store(objects);
  expect(second.writes).toEqual({ objects: 5, written: 0, fsyncs: 0 });
});

test("staged objects become durable on the first durable store", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("staged first");
  await store.stage([a]);
  expect(store.writes.fsyncs).toBe(0);
  await store.store([a]);
  expect(store.writes.fsyncs).toBe(1);
  expect(store.packs.has(a.hash)).toBe(true);
  await store.store([a]);
  expect(store.writes.fsyncs).toBe(1);
});

test("storing an object again freshens it for the object collector", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const value = object("kept by reuse");
  await store.store([value]);
  store.packs.index()!.run("UPDATE packed_objects SET used_at = ?", [twoDaysAgo().getTime()]);
  await new ObjectStore(join(directory, "objects")).store([value]);
  expect(usedAt(store, value.hash)).toBeGreaterThan(Date.now() - 60_000);
});

test("records synced but never indexed are indexed again, including a journal the index lost", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("first"), b = object("second"), c = object("third");
  await store.store([a]);
  await store.store([b, c]);
  const name = (await journals())[0]!;
  // The index loses its last commit, then everything about the journal.
  const db = store.packs.index()!;
  const first = (db.query("SELECT offset, length FROM packed_objects WHERE hash = ?").get(Buffer.from(a.hash.slice(7), "hex")) as { offset: number; length: number });
  db.run("DELETE FROM packed_objects WHERE hash != ?", [Buffer.from(a.hash.slice(7), "hex")]);
  db.run("UPDATE packs SET bytes = ?", [first.offset + first.length]);
  let after = new ObjectStore(join(directory, "objects"));
  expect(await after.find(b.hash)).toBeNull();
  expect(after.recover()).toBe(2);
  for (const o of [a, b, c]) expect(await after.read(o.hash)).toEqual(o.bytes);
  db.run("DELETE FROM packed_objects");
  db.run("DELETE FROM packs");
  after = new ObjectStore(join(directory, "objects"));
  expect(after.recover()).toBe(3);
  for (const o of [a, b, c]) expect(await after.read(o.hash)).toEqual(o.bytes);
  expect(await journals()).toEqual([name]);
});

test("a torn last record is never indexed, and the first store of a process recovers first", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("whole"), b = object("torn");
  await store.store([a]);
  store.packs.index()!.run("DELETE FROM packed_objects");
  store.packs.index()!.run("UPDATE packs SET bytes = 0");
  // Half of a second record's body.
  const header = Buffer.alloc(36);
  header.writeUInt32BE(b.bytes.byteLength, 0);
  Buffer.from(b.hash.slice(7), "hex").copy(header, 4);
  await appendFile(await journalPath(), Buffer.concat([header, Buffer.from(b.bytes.slice(0, 2))]));
  const after = new ObjectStore(join(directory, "objects"));
  await after.store([object("unrelated")]);
  expect(await after.read(a.hash)).toEqual(a.bytes);
  expect(await after.find(b.hash)).toBeNull();
  // Storing it again appends a whole copy to this process's own journal.
  await after.store([b]);
  expect(await new ObjectStore(join(directory, "objects")).read(b.hash)).toEqual(b.bytes);
  expect(await journals()).toHaveLength(2);
});

test("an append whose journal was collected meanwhile is made again in a new journal", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("collected"), b = object("next");
  await store.store([a]);
  const collector = new ObjectStore(join(directory, "objects"));
  expect(await collector.packs.collect(new Set(), Date.now() + 1, true)).toMatchObject({ objects: 1 });
  expect(await journals()).toEqual([]);
  // The store's journal file is gone with its row: the append there is
  // synced, finds no row to index, and is made again in a new journal.
  await store.store([a, b]);
  expect(store.writes.fsyncs).toBe(3);
  for (const o of [a, b]) expect(await new ObjectStore(join(directory, "objects")).read(o.hash)).toEqual(o.bytes);
});

test("a journal is verified by its records, not by its name", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  await store.store([object("verified")]);
  expect((await new ObjectStore(join(directory, "objects")).packs.verify()).damaged).toEqual([]);
  await rm(await journalPath());
  expect((await new ObjectStore(join(directory, "objects")).packs.verify()).damaged).toHaveLength(1);
});

test("a staged object not known to this process has its stored bytes checked", async () => {
  const value = object("checked");
  await new ObjectStore(join(directory, "objects")).stage([value]);
  const other = new ObjectStore(join(directory, "objects"));
  await writeFile(other.path(value.hash), "tampered");
  await expect(other.stage([value])).rejects.toThrow("Stored object hash mismatch");
});

test("durable store rejects bytes that do not match their hash", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("right");
  await expect(store.store([{ hash: a.hash, bytes: object("wrong").bytes }])).rejects.toThrow("Object hash mismatch");
});

const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const recent = async (path: string) => (await stat(path)).mtimeMs > Date.now() - 60_000;

test("a verified walk freshens only stored objects, and freshening a vanished object throws", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const leaf = object("leaf"), proposed = object("proposed");
  const bytes = encodeProtocolDirectory({ type: "directory", entries: [{ name: "a", file: leaf.hash, created: 0, modified: 0 }, { name: "b", file: proposed.hash, created: 0, modified: 0 }] });
  const root = { hash: hashObject(bytes), bytes };
  await store.store([leaf]);
  await store.stage([root]);
  await utimes(store.path(root.hash), twoDaysAgo(), twoDaysAgo());
  store.packs.index()!.run("UPDATE packed_objects SET used_at = ?", [twoDaysAgo().getTime()]);
  await store.verifyReachable([root.hash], new Map([[proposed.hash, proposed.bytes]]), { freshen: true });
  expect(await recent(store.path(root.hash))).toBe(true);
  expect(usedAt(store, leaf.hash)).toBeGreaterThan(Date.now() - 60_000);
  expect(await holdsObject(store, proposed.hash)).toBe(false);
  await expect(store.freshen([proposed.hash])).rejects.toThrow("Stored object vanished");
});

test("a repairing stage replaces a torn scratch file; any other publish refuses it", async () => {
  const store = new ObjectStore(join(directory, "objects"));
  const a = object("cache record");
  await store.stage([a]);
  await writeFile(store.path(a.hash), "");
  await expect(store.stage([a])).rejects.toThrow("hash mismatch");
  await store.stage([a], { repair: true });
  expect(await store.read(a.hash)).toEqual(a.bytes);
  expect(store.writes.fsyncs).toBe(0);
});
