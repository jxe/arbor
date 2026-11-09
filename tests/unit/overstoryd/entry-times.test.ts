import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeProtocolDirectory, encodeProtocolPage, hashObject, TreeReader, type ObjectHash, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { AcceptedUpdateStore } from "../../../packages/overstoryd/src/updates/store.ts";
import { EntryMetadataStore } from "../../../packages/overstoryd/src/updates/entry-metadata.ts";
import { EntryTimeIndex } from "../../../packages/overstoryd/src/updates/entry-times.ts";

// The entry time index on its own: rows written straight into a host
// database, the index caught up from them.

const sandboxes: string[] = [];
afterEach(async () => { for (const path of sandboxes.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "entry-times-"));
  sandboxes.push(sandbox);
  const db = new Database(":memory:");
  db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, governs TEXT)");
  AcceptedUpdateStore.createTable(db);
  EntryMetadataStore.createSchema(db);
  const objects = new Map<ObjectHash, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
  const directory = (entries: ProtocolDirectoryEntry[]) =>
    put(encodeProtocolDirectory({ type: "directory", entries: entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
  let previous: number | null = null;
  const accept = (root: ObjectHash, at: number) => {
    const row = db.run("INSERT INTO accepted_updates (tree_id, root, previous_ordinal, accepted_at, entry) VALUES ('t', ?, ?, ?, 'e')", [root, previous, at]);
    previous = Number(row.lastInsertRowid);
    db.run("INSERT OR REPLACE INTO trees (id, ref) VALUES ('t', ?)", [root]);
  };
  const index = new EntryTimeIndex(join(sandbox, "times.sqlite3"), db, () => new TreeReader(async (hash) => objects.get(hash)!));
  const times = (root: ObjectHash) => index.times("t", root, objects);
  return { db, put, directory, accept, index, times };
}

test("converting a file to a page keeps its time", async () => {
  const { put, directory, accept, index, times } = await fixture();
  const file = directory([{ name: "Notes.md", file: put(new TextEncoder().encode("Hello\n")) }]);
  const page = directory([{ name: "Notes.md", page: put(encodeProtocolPage({ type: "page", properties: [], body: new TextEncoder().encode("Hello\n") })) }]);
  accept(file, 1_000);
  accept(page, 2_000);
  await index.catchUp("t");
  expect(await times(page)).toEqual({ "/Notes.md": 1_000 });
  await index.close();
});

test("a first retained root dates its entries from the records the squash kept", async () => {
  const { db, put, directory, accept, index, times } = await fixture();
  const old = put(new TextEncoder().encode("Old\n")), kept = put(new TextEncoder().encode("Kept\n")), fresh = put(new TextEncoder().encode("Fresh\n"));
  const first = directory([{ name: "Old.md", file: old }, { name: "Kept.bin", file: kept }, { name: "Fresh.md", file: fresh }]);
  // History before this root was squashed: a version of Old.md from 100, and
  // Kept.bin unchanged at the head since 200.
  db.run("INSERT INTO document_versions (tree_id, stable_key, update_id, entry_path, content_hash, accepted_at) VALUES ('t', 'path:/Old.md', 'x', '/Old.md', ?, 100)", [old]);
  db.run("INSERT INTO entry_metadata (tree_id, path, modified_at) VALUES ('t', '/Kept.bin', 200)");
  accept(first, 5_000);
  const next = directory([{ name: "Old.md", file: old }, { name: "Kept.bin", file: kept }, { name: "Fresh.md", file: put(new TextEncoder().encode("Fresher\n")) }]);
  accept(next, 6_000);
  await index.catchUp("t");
  expect(await times(first)).toEqual({ "/Old.md": 100, "/Kept.bin": 200, "/Fresh.md": 5_000 });
  expect(await times(next)).toEqual({ "/Old.md": 100, "/Kept.bin": 200, "/Fresh.md": 6_000 });
  await index.close();
});

test("a read of a root the index has not reached waits for it", async () => {
  const { put, directory, accept, index, times } = await fixture();
  const root = directory([{ name: "A.md", file: put(new TextEncoder().encode("A\n")) }]);
  accept(root, 7);
  expect(await times(root)).toEqual({ "/A.md": 7 });
  expect(index.through("t")).toBe(1);
  await index.close();
});
