import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { canonicalStableKey } from "@arbor/core";
import {
  CollectionMutationMismatchError,
  CollectionPropertyConflictError,
  CollectionPropertyWriteError,
  CollectionStore,
  detectCollection,
} from "@arbor/stores";

let root: string;
const providerContext = { tree: "tr_test", observedThrough: "test:0", writable: true } as const;

function childrenOf(
  collections: CollectionStore,
  directory: string,
  path: string,
  cursor: string | null = null,
  limit = 100,
  table?: string,
) {
  return collections.children(
    directory,
    path,
    { tree: "tr_test", path, stableKey: null },
    providerContext,
    cursor,
    limit,
    table,
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-collections-"));
  await mkdir(join(root, "csv"));
  await writeFile(join(root, "csv", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string(), count: z.coerce.number() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "csv", "_store.csv"), "id,title,count\none,One,1\ntwo,Two,nope\n");
  await mkdir(join(root, "jsonl"));
  await writeFile(join(root, "jsonl", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "jsonl", "_store.jsonl"), '{"id":"one","title":"One"}\nnot json\n{"id":"three","title":"Three"}\n');
  await mkdir(join(root, "json"));
  await writeFile(join(root, "json", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "json", "_store.json"), '[{"id":"b","title":"Second"},{"id":"a","title":"First"}]\n');
  await mkdir(join(root, "markdown"));
  await writeFile(join(root, "markdown", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string(), status: z.enum(["draft", "done"]) });\n');
  await writeFile(join(root, "markdown", "one.md"), "---\nid: abc123\ntitle: One\nstatus: draft\n---\nBody\n");
  await mkdir(join(root, "sqlite"));
  const sqliteSchema = "create table items (id text primary key, title text not null, active boolean not null); create table memberships (list_id text not null, profile text not null, primary key (list_id, profile));";
  await writeFile(join(root, "sqlite", "schema.sql"), `${sqliteSchema}\n`);
  await writeFile(join(root, "sqlite", "relationships.json"), '{"version":1,"relationships":{}}\n');
  const sqlite = new Database(join(root, "sqlite", "_store.sqlite3"));
  sqlite.exec(sqliteSchema);
  sqlite.query("insert into items values (?, ?, ?), (?, ?, ?)").run("b", "Second", 0, "a", "First", 1);
  sqlite.query("insert into memberships values (?, ?)").run("list", "person");
  sqlite.close();
});

afterAll(async () => rm(root, { recursive: true, force: true }));

describe("file-backed collections", () => {
  test("detects fixed backing names", async () => {
    expect((await detectCollection(join(root, "csv")))?.backing).toBe("csv");
    expect((await detectCollection(join(root, "json")))?.backing).toBe("json");
    expect((await detectCollection(join(root, "jsonl")))?.backing).toBe("jsonl");
    expect((await detectCollection(join(root, "markdown")))?.backing).toBe("markdown");
    expect((await detectCollection(join(root, "sqlite")))?.backing).toBe("sqlite");
  });

  test("validates CSV rows in the schema sandbox", async () => {
    const collections = new CollectionStore();
    const summary = await collections.summary(join(root, "csv"));
    const page = await childrenOf(collections, join(root, "csv"), "/csv", null, 20);
    expect(summary?.columns).toEqual(["id", "title", "count"]);
    expect(page.items[0]?.properties.count).toBe(1);
    expect(page.items[0]?.ref.stableKey).toBe(canonicalStableKey([["id", "one"]]));
    expect(page.items[1]?.diagnostics[0]?.code).toBe("schema-validation");
    expect(page.items[1]?.ref.stableKey).toBeNull();
  });

  test("reports malformed JSONL by source line", async () => {
    const page = await childrenOf(new CollectionStore(), join(root, "jsonl"), "/jsonl", null, 20);
    expect(page.items[1]?.diagnostics[0]?.code).toBe("invalid-jsonl");
    expect(page.items[1]?.diagnostics[0]?.row).toBe(2);
    expect(page.items[0]?.ref.stableKey).toBe(canonicalStableKey([["id", "one"]]));
  });

  test("uses declared keys for JSON row paths, keyset paging, and direct resolution", async () => {
    const collections = new CollectionStore();
    const first = await childrenOf(collections, join(root, "json"), "/json", null, 1);
    expect((await collections.summary(join(root, "json")))?.identityRule).toEqual({ properties: ["id"] });
    expect(first.items[0]).toMatchObject({ ref: { path: "/json/a", stableKey: canonicalStableKey([["id", "a"]]) } });
    expect(first.nextCursor).not.toBeNull();

    const second = await childrenOf(collections, join(root, "json"), "/json", first.nextCursor, 1);
    expect(second.items[0]).toMatchObject({ ref: { path: "/json/b", stableKey: canonicalStableKey([["id", "b"]]) } });
    expect(second.nextCursor).toBeNull();

    const resolved = await collections.resolveChild(join(root, "json"), "/json", {
      path: "/json/stale-readable-path",
      stableKey: canonicalStableKey([["id", "b"]]),
    }, providerContext);
    expect(resolved?.properties.title).toBe("Second");

    const beforeFormatting = await collections.summary(join(root, "json"));
    await writeFile(join(root, "json", "_store.json"), '[\n  { "id": "b", "title": "Second" },\n  { "id": "a", "title": "First" }\n]\n');
    const afterFormatting = await collections.summary(join(root, "json"));
    expect(afterFormatting?.revision).not.toBe(beforeFormatting?.revision);
    expect(afterFormatting?.modelDigest).toBe(beforeFormatting?.modelDigest);
    await expect(childrenOf(collections, join(root, "json"), "/json", first.nextCursor, 1)).rejects.toThrow("another revision");
  });

  test("never falls back from duplicate or nullable declared identity", async () => {
    const duplicate = join(root, "duplicate");
    await mkdir(duplicate);
    await writeFile(join(duplicate, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(duplicate, "_store.json"), '[{"id":"same","title":"One"},{"id":"same","title":"Two"}]\n');
    const page = await childrenOf(new CollectionStore(), duplicate, "/duplicate", null, 20);
    expect(page.items.every((row) => row.ref.stableKey === null)).toBe(true);
    expect(page.items.every((row) => row.diagnostics.some((item) => item.code === "duplicate-row-key"))).toBe(true);

    const nullable = join(root, "nullable");
    await mkdir(nullable);
    await writeFile(join(nullable, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string().optional() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(nullable, "_store.json"), "[]\n");
    await expect(new CollectionStore().summary(nullable)).rejects.toThrow("required schema properties");
  });

  test("keeps Markdown identity in the same property map as record fields", async () => {
    const page = await childrenOf(new CollectionStore(), join(root, "markdown"), "/markdown", null, 20);
    expect(page.items[0]?.capabilities.properties?.writable).toBe(true);
    expect(page.items[0]?.properties).toEqual({ id: "abc123", title: "One", status: "draft" });
  });

  test("projects SQLite tables and rows through the shared schema metadata", async () => {
    const collections = new CollectionStore();
    const directory = join(root, "sqlite");
    const summary = await collections.summary(directory);
    expect(summary).toMatchObject({
      backing: "sqlite",
      tables: ["items", "memberships"],
      rollupScope: "subtree",
      editable: false,
    });
    expect(summary?.schemaRevision).toMatch(/^sha256:/);

    const table = await collections.tableSummary(directory, "items");
    expect(table).toMatchObject({
      backing: "sqlite",
      columns: ["id", "title", "active"],
      identityRule: { properties: ["id"] },
      rollupScope: "children",
      total: 2,
    });

    const first = await childrenOf(collections, directory, "/sqlite/items", null, 1, "items");
    expect(first.items[0]).toMatchObject({
      ref: { path: "/sqlite/items/a", stableKey: canonicalStableKey([["id", "a"]]) },
      properties: { id: "a", title: "First", active: true },
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await childrenOf(collections, directory, "/sqlite/items", first.nextCursor, 1, "items");
    expect(second.items[0]?.ref.path).toBe("/sqlite/items/b");

    const resolved = await collections.resolveChild(directory, "/sqlite/items", {
      path: "/sqlite/items/stale-readable-path",
      stableKey: canonicalStableKey([["id", "b"]]),
    }, providerContext, "items");
    expect(resolved).toMatchObject({ ref: { path: "/sqlite/items/b" }, properties: { title: "Second", active: false } });

    const database = new Database(join(directory, "_store.sqlite3"));
    database.query("update items set title = ? where id = ?").run("Changed", "b");
    database.close();
    await expect(childrenOf(collections, directory, "/sqlite/items", first.nextCursor, 1, "items"))
      .rejects.toThrow("another revision");
  });

  test("introspects standalone SQLite stores without executable-document companions", async () => {
    const directory = join(root, "standalone-sqlite");
    await mkdir(directory);
    const database = new Database(join(directory, "_store.sqlite3"));
    database.exec("create table notes (id text primary key, title text not null); insert into notes values ('one', 'One')");
    database.close();
    const collections = new CollectionStore();
    expect(await collections.summary(directory)).toMatchObject({ backing: "sqlite", tables: ["notes"] });
    expect((await childrenOf(collections, directory, "/standalone-sqlite/notes", null, 20, "notes")).items[0]?.ref.path)
      .toBe("/standalone-sqlite/notes/one");
  });

  test("CAS-replaces stable SQLite row properties with durable idempotency", async () => {
    const directory = join(root, "sqlite");
    const collections = new CollectionStore();
    const before = await collections.writeTarget(directory, "/sqlite/items", {
      path: "/sqlite/items/stale-path",
      stableKey: canonicalStableKey([["id", "a"]]),
    }, "items");
    expect(before?.writable).toBe(true);
    const write = (id: string, base: string, title: string, rowID = "a") => collections.writeProperties(
      directory,
      "/sqlite/items",
      { path: "/sqlite/items/stale-path", stableKey: canonicalStableKey([["id", "a"]]) },
      base,
      { id: rowID, title, active: false },
      "items",
      { scope: "tr_test", id },
    );
    const saved = await write("write-a-1", before!.revision, "First updated");
    expect(saved.values).toEqual({ id: "a", title: "First updated", active: false });
    expect(saved.revision).not.toBe(before?.revision);
    expect(await write("write-a-1", before!.revision, "First updated")).toEqual(saved);
    await expect(write("write-a-1", before!.revision, "Different")).rejects.toBeInstanceOf(CollectionMutationMismatchError);
    await expect(write("write-a-stale", before!.revision, "Stale")).rejects.toBeInstanceOf(CollectionPropertyConflictError);
    await expect(write("write-a-identity", saved.revision!, "No", "renamed")).rejects.toBeInstanceOf(CollectionPropertyWriteError);
  });

  test("enforces SQLite foreign keys during direct property writes", async () => {
    const directory = join(root, "foreign-key-sqlite");
    await mkdir(directory);
    const database = new Database(join(directory, "_store.sqlite3"));
    database.exec(`
      pragma foreign_keys = on;
      create table parents (id text primary key);
      create table children (id text primary key, parent_id text not null references parents(id));
      insert into parents values ('parent');
      insert into children values ('child', 'parent');
    `);
    database.close();
    const collections = new CollectionStore();
    const row = (await childrenOf(collections, directory, "/foreign-key-sqlite/children", null, 10, "children")).items[0]!;
    await expect(collections.writeProperties(
      directory,
      "/foreign-key-sqlite/children",
      { path: "/foreign-key-sqlite/children/child", stableKey: row.ref.stableKey },
      row.capabilities.properties!.revision,
      { id: "child", parent_id: "missing" },
      "children",
      { scope: "tr_test", id: "invalid-foreign-key" },
    )).rejects.toThrow(/foreign key constraint/i);
    expect((await collections.resolveChild(directory, "/foreign-key-sqlite/children", {
      path: "/foreign-key-sqlite/children/child",
      stableKey: row.ref.stableKey,
    }, providerContext, "children"))?.properties.parent_id).toBe("parent");
  });
});
