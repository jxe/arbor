import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient, decodeWireDirectory, encodeWireDirectory, hashObject, type ObjectHash, type WireDirectoryEntry } from "@overstory/protocol";
import { migrateEntryMetadata } from "./run.ts";

const token = "migration-014-owner";

/** Accepted history written by the schema-16 host, which fills both tables as
 * it accepts: an added page, an edit, a rename without a content change, a
 * binary file, a nested directory added and then removed. */
async function history(root: string) {
  const running = await serveCanopy({ dataRoot: root, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  try {
    const client = new WireClient(running.url, token);
    const tree = (await client.account()).account.community.id;
    let head = (await client.descriptor(tree)).tree;
    const initial = await client.snapshot(tree, head.root);
    const objects = new Map(initial.objects);
    const existing = decodeWireDirectory(objects.get(initial.root)!).entries;
    const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
    const file = (text: string) => put(new TextEncoder().encode(text));
    const dir = (entries: WireDirectoryEntry[]) => put(encodeWireDirectory({ type: "directory", entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
    const submit = async (entries: WireDirectoryEntry[]) => {
      const result = await client.submitUpdate(tree, head.update, { root: dir([...existing, ...entries]), objects });
      head = { ...head, update: result.update.id as typeof head.update, root: result.update.root as typeof head.root };
    };
    const page = "---\nid: pg_trip\n---\nTrip\n", png = file("png");
    const nested = dir([{ name: "_index.md", file: file("Body\n") }, { name: "note.md", file: file("Note\n") }]);
    await submit([{ name: "trip.md", file: file(page) }]);
    await submit([{ name: "trip.md", file: file(page + "More\n") }, { name: "photo.png", file: png }]);
    await submit([{ name: "renamed.md", file: file(page + "More\n") }, { name: "photo.png", file: png }, { name: "folder", directory: nested }]);
    await submit([{ name: "renamed.md", file: file(page + "More\n") }, { name: "photo.png", file: png }]);
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
  }
}

const snapshot = (root: string) => {
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  try {
    return {
      entries: db.query("SELECT tree_id, path, modified_at, update_id FROM entry_metadata ORDER BY tree_id, path").all(),
      versions: db.query("SELECT tree_id, stable_key, update_id, entry_path, content_hash, accepted_at FROM document_versions ORDER BY tree_id, stable_key, update_id, entry_path").all(),
    };
  } finally { db.close(); }
};

test("the backfill reproduces exactly what the accepting host wrote, and runs once", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-014-`);
  try {
    await history(root);
    const live = snapshot(root);
    expect(live.entries.length).toBeGreaterThan(0);
    expect(live.versions.length).toBeGreaterThan(0);
    // Back to schema 15: the tables did not exist.
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("DROP TABLE entry_metadata"); db.run("DROP TABLE document_versions");
    db.run("UPDATE meta SET value = '15' WHERE key = 'schema_version'");
    db.close();
    const report = await migrateEntryMetadata(root);
    expect(report.migrated).toBe(true);
    expect(report.prunedHistory).toBe(0);
    expect(snapshot(root)).toEqual(live);
    expect(report.entries).toBe(live.entries.length);
    const rerun = await migrateEntryMetadata(root);
    expect(rerun.migrated).toBe(false);
    expect(snapshot(root)).toEqual(live);
    // The migrated root opens with the current build.
    const running = await serveCanopy({ dataRoot: root, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
    running.server.stop(true); await running.canopy[Symbol.asyncDispose]();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing accepted root stops the run and leaves schema 15", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-014-missing-`);
  try {
    await history(root);
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("DROP TABLE entry_metadata"); db.run("DROP TABLE document_versions");
    db.run("UPDATE meta SET value = '15' WHERE key = 'schema_version'");
    const current = (db.query("SELECT ref FROM trees ORDER BY rowid DESC LIMIT 1").get() as { ref: ObjectHash }).ref;
    db.close();
    await rm(join(root, "objects", current.slice(7, 9), current.slice(9)));
    await expect(migrateEntryMetadata(root)).rejects.toThrow(/missing object/);
    const after = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    expect((after.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("15");
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
