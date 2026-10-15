import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { decodeProtocolCollectionTables, deriveRowOperations, replayCollectionRows } from "@ovst/collection-schema";
import { decodeProtocolDirectory, executeRowOperations, type CollectionTablesDescriptor, type ObjectHash, type RowOperation } from "@ovst/protocol";
import { mergeProtocolTrees } from "@ovst/tree-merge";
import { ProjectionProviderHost } from "@ovst/story-sync/state";
import { writeDatabaseCollection } from "../../packages/story-sync/src/state/providers/sqlite-collection.ts";

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

async function snapshot(directory: string) {
  const stores = new ProjectionProviderHost();
  try {
    return await resolveSnapshot(await snapshotDirectory(directory, new Map(), [], (dir, names) => stores.collectionDescriptor(dir, names)));
  } finally { await stores[Symbol.asyncDispose](); }
}

const tableText = (objects: ReadonlyMap<ObjectHash, Uint8Array>, root: ObjectHash, name: string) => {
  const directory = decodeProtocolDirectory(objects.get(root)!);
  return new TextDecoder().decode(objects.get(directory.entries.find((e) => e.name === name)!.file!)!);
};

const listName = (path: string) => {
  const database = new Database(join(path, "_store.sqlite3"), { readonly: true });
  try { return (database.query("select name from List where id = ?").get(LIST) as { name: string }).name; } finally { database.close(); }
};

describe("a folder's SQLite database", () => {
  test("is held in the tree as one canonical JSONL file per table of its database layout", async () => {
    const tree = await snapshot(await supplies("described"));
    const directory = decodeProtocolDirectory(tree.objects.get(tree.root)!);
    const descriptor = directory.childrenSource as CollectionTablesDescriptor;
    expect(descriptor).toMatchObject({ type: "collection-tables", format: "jsonl", store: "sqlite" });
    expect(descriptor.tables.map((t) => t.table)).toEqual(["Contribution", "Item", "List", "Practice", "Practice_authors", "Reaction", "Tag", "Tag_practices"]);
    expect(directory.entries.map((e) => e.name)).not.toContain("_store.sqlite3");
    const bytes = (name: string) => tree.objects.get(directory.entries.find((e) => e.name === name)!.file!)!;
    const tables = decodeProtocolCollectionTables(descriptor, bytes, bytes("schema.usl"));
    expect(tables.find((t) => t.table === "List")!.rows).toHaveLength(3);
    // Flags are booleans and null columns are absent.
    expect(tableText(tree.objects, tree.root, "List.jsonl").split("\n")[0]).toContain('"openToEdits":true');
    expect(tableText(tree.objects, tree.root, "List.jsonl")).not.toContain("null");
  });

  test("a table file out of canonical order is invalid", async () => {
    const tree = await snapshot(await supplies("canonical"));
    const directory = decodeProtocolDirectory(tree.objects.get(tree.root)!);
    const bytes = (name: string) => tree.objects.get(directory.entries.find((e) => e.name === name)!.file!)!;
    const lines = new TextDecoder().decode(bytes("List.jsonl")).trimEnd().split("\n").reverse();
    const reversed = new TextEncoder().encode(`${lines.join("\n")}\n`);
    expect(() => decodeProtocolCollectionTables(directory.childrenSource!, (name) => name === "List.jsonl" ? reversed : bytes(name), bytes("schema.usl")))
      .toThrow(/child-set hash|canonical/);
  });

  test("materializes as a database that snapshots back to the same tree", async () => {
    const tree = await snapshot(await supplies("source"));
    const target = join(sandbox, "materialized");
    await materializeTree(target, tree.root, async (hash) => tree.objects.get(hash)!, undefined, [], undefined, writeDatabaseCollection);
    expect((await readdir(target)).sort()).toEqual(["_store.sqlite3", "schema.usl"]);
    expect((await snapshot(target)).root).toBe(tree.root);
  });

  test("an edit by another program becomes row operations that replay to the folder's tree", async () => {
    const directory = await supplies("external");
    const before = await snapshot(directory);
    const external = new Database(join(directory, "_store.sqlite3"));
    external.query("update List set name = 'Mutual aid' where id = ?").run(LIST);
    external.close();
    const after = await snapshot(directory);
    const objects = new Map([...before.objects, ...after.objects]);
    const operations = await deriveRowOperations(before.root, after.root, async (hash) => objects.get(hash)!);
    expect(operations).toEqual([expect.objectContaining({ kind: "rowSet", table: "List", row: key(LIST), field: "name", before: "Community care", value: "Mutual aid" })]);
  });

  test("accepted rows are written into an existing database, and concurrent edits to different fields merge", async () => {
    const directory = await supplies("merge");
    const base = await snapshot(directory);
    const load = async (hash: ObjectHash) => base.objects.get(hash)!;
    const collection = { material: { kind: "basis" as const, path: "/", object: base.root } };
    const ours: RowOperation[] = [{ key: "a", kind: "rowSet", collection, table: "List", row: key(LIST), field: "name", before: "Community care", value: "Ours" }];
    const theirs: RowOperation[] = [{ key: "b", kind: "rowSet", collection, table: "List", row: key(LIST), field: "openToEdits", before: true, value: false }];
    const candidate = await executeRowOperations(base.root, ours, load, replayCollectionRows);
    const current = await executeRowOperations(base.root, theirs, load, replayCollectionRows);
    const objects = new Map([...base.objects, ...candidate.generated, ...current.generated]);
    const merged = await mergeProtocolTrees(base.root, candidate.root, current.root, async (hash) => objects.get(hash)!);
    expect(merged.conflicts).toEqual([]);
    for (const [hash, bytes] of merged.objects) objects.set(hash, bytes);
    await materializeTree(directory, merged.root, async (hash) => objects.get(hash)!, undefined, [], undefined, writeDatabaseCollection);
    expect(listName(directory)).toBe("Ours");
    const database = new Database(join(directory, "_store.sqlite3"), { readonly: true });
    expect((database.query("select openToEdits from List where id = ?").get(LIST) as { openToEdits: number }).openToEdits).toBe(0);
    database.close();
    expect((await snapshot(directory)).root).toBe(merged.root);
  });
});
