import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { deriveRowOperations, loadDirectoryCollection, replayCollectionRows } from "@ovst/collection-schema";
import { decodeProtocolDirectory, executeRowOperations, type ObjectHash, type RowOperation } from "@ovst/protocol";
import { mergeProtocolTrees } from "@ovst/tree-merge";
import { CollectionProjections, type CollectionProjectionForm } from "@ovst/story-sync/state";

const SUPPLIES = join(import.meta.dir, "../../examples/supplies/data");
const LIST = "10000000-0000-4000-8000-000000000001";
const key = (id: string) => JSON.stringify([["id", id]]);

let sandbox: string;
beforeAll(async () => { sandbox = await mkdtemp(join(tmpdir(), "story-database-collections-")); });
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

/** A copy of the Supplies data folder. */
async function supplies(name: string): Promise<string> {
  const directory = join(sandbox, name);
  await Bun.write(join(directory, "schema.usl"), Bun.file(join(SUPPLIES, "schema.usl")));
  await copyFile(join(SUPPLIES, "_store.sqlite3"), join(directory, "_store.sqlite3"));
  return directory;
}

/** Story Sync's projections, each read a minute after the last. */
function projections(form?: CollectionProjectionForm) {
  let minute = 0;
  return new CollectionProjections({ now: () => new Date(Date.UTC(2026, 9, 24, 9, minute++)).toISOString(), form: () => form });
}

async function snapshot(directory: string, collections: CollectionProjections) {
  return await resolveSnapshot(await snapshotDirectory(directory, new Map(), [], (dir, names) => collections.read(dir, names)));
}

const rows = async (objects: ReadonlyMap<ObjectHash, Uint8Array>, root: ObjectHash) =>
  (await loadDirectoryCollection(decodeProtocolDirectory(objects.get(root)!), async (hash) => objects.get(hash)!))!.tables;

const listName = (path: string) => {
  const database = new Database(join(path, "_store.sqlite3"), { readonly: true });
  try { return (database.query("select name from List where id = ?").get(LIST) as { name: string }).name; } finally { database.close(); }
};

describe("a folder's SQLite database", () => {
  test("is held in the tree as its logical rows, and the database files are never entries", async () => {
    const tree = await snapshot(await supplies("described"), projections());
    const directory = decodeProtocolDirectory(tree.objects.get(tree.root)!);
    expect(directory.entries.map((e) => e.name)).toEqual(["schema.usl"]);
    const tables = await rows(tree.objects, tree.root);
    expect(tables.List).toHaveLength(3);
    // Flags are booleans and null columns are absent.
    const list = tables.List!.find((row) => row.key[0]![1] === LIST)!;
    expect(list.fields.openToEdits).toBe(true);
    expect(Object.values(list.fields)).not.toContain(null);
  });

  test("materializes as a database that snapshots back to the same tree", async () => {
    const collections = projections({ kind: "sqlite" });
    const tree = await snapshot(await supplies("source"), collections);
    const target = join(sandbox, "materialized");
    await materializeTree(target, tree.root, async (hash) => tree.objects.get(hash)!, undefined, [], undefined, (dir, object, load) => collections.write(dir, object, load));
    expect((await readdir(target)).sort()).toEqual(["_store.sqlite3", "schema.usl"]);
    expect((await snapshot(target, collections)).root).toBe(tree.root);
  });

  test("an edit by another program becomes row operations that replay to the folder's tree", async () => {
    const directory = await supplies("external");
    const collections = projections();
    const before = await snapshot(directory, collections);
    const external = new Database(join(directory, "_store.sqlite3"));
    external.query("update List set name = 'Mutual aid' where id = ?").run(LIST);
    external.close();
    const after = await snapshot(directory, collections);
    const objects = new Map([...before.objects, ...after.objects]);
    const operations = await deriveRowOperations(before.root, after.root, async (hash) => objects.get(hash)!);
    expect(operations).toEqual([expect.objectContaining({ kind: "rowSet", table: "List", row: key(LIST), field: "name", before: "Community care", value: "Mutual aid" })]);
  });

  test("accepted rows are written into an existing database, and concurrent edits to different fields merge", async () => {
    const directory = await supplies("merge");
    const collections = projections();
    const base = await snapshot(directory, collections);
    const load = async (hash: ObjectHash) => base.objects.get(hash)!;
    const collection = { material: { kind: "basis" as const, path: "/", object: base.root } };
    const ours: RowOperation[] = [{ key: "a", kind: "rowSet", collection, table: "List", row: key(LIST), field: "name", before: "Community care", value: "Ours", at: "2026-10-24T10:00:00.000Z" }];
    const theirs: RowOperation[] = [{ key: "b", kind: "rowSet", collection, table: "List", row: key(LIST), field: "openToEdits", before: true, value: false, at: "2026-10-24T10:01:00.000Z" }];
    const candidate = await executeRowOperations(base.root, ours, load, replayCollectionRows);
    const current = await executeRowOperations(base.root, theirs, load, replayCollectionRows);
    const objects = new Map([...base.objects, ...candidate.generated, ...current.generated]);
    const merged = await mergeProtocolTrees(base.root, candidate.root, current.root, async (hash) => objects.get(hash)!);
    expect(merged.conflicts).toEqual([]);
    for (const [hash, bytes] of merged.objects) objects.set(hash, bytes);
    await materializeTree(directory, merged.root, async (hash) => objects.get(hash)!, undefined, [], undefined, (dir, object, read) => collections.write(dir, object, read));
    expect(listName(directory)).toBe("Ours");
    const database = new Database(join(directory, "_store.sqlite3"), { readonly: true });
    expect((database.query("select openToEdits from List where id = ?").get(LIST) as { openToEdits: number }).openToEdits).toBe(0);
    database.close();
    expect((await snapshot(directory, collections)).root).toBe(merged.root);
  });
});
