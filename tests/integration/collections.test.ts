import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { canonicalStableKey, type JSONValue } from "@arbor/core";
import {
  ProjectionProviderHost,
  detectProjection,
} from "@arbor/stores";

let root: string;
const providerContext = { tree: "tr_test", observedThrough: "test:0", writable: true } as const;

function childrenOf(
  collections: ProjectionProviderHost,
  directory: string,
  path: string,
  cursor: string | null = null,
  limit = 100,
  table?: string,
) {
  return collections.open(directory).then((session) => session!.children(
    path,
    { tree: "tr_test", path, stableKey: null },
    providerContext,
    cursor,
    table,
    limit,
  ));
}

async function resolveChild(
  providers: ProjectionProviderHost,
  directory: string,
  parentPath: string,
  ref: { path: string; stableKey: string | null },
  table?: string,
) {
  return (await providers.open(directory))!.resolveChild(parentPath, ref, providerContext, table);
}

async function writeTarget(
  providers: ProjectionProviderHost,
  directory: string,
  parentPath: string,
  ref: { path: string; stableKey: string | null },
  table?: string,
) {
  return (await providers.open(directory))!.writeTarget(parentPath, ref, table);
}

async function prepareWrite(
  providers: ProjectionProviderHost,
  target: NonNullable<Awaited<ReturnType<typeof writeTarget>>>,
  base: string,
  properties: Record<string, JSONValue>,
  id: string,
) {
  return (await providers.open(target.directory))!.preparePropertyWrite(
    target,
    base,
    properties,
    { scope: "tr_test", id },
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
  await mkdir(join(root, "writable-json"));
  await writeFile(join(root, "writable-json", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string(), count: z.number() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "writable-json", "_store.json"), '[\n  { "id": "one", "title": "One", "count": 1 },\n  {\n    "id":"two",\n    "title":"Two",\n    "count":2\n  }\n]\n');
  await mkdir(join(root, "writable-jsonl"));
  await writeFile(join(root, "writable-jsonl", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string(), count: z.number() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "writable-jsonl", "_store.jsonl"), '{"id":"one","title":"One","count":1}\r\n  {"id":"two","title":"Two","count":2}  \r\n');
  await mkdir(join(root, "writable-csv"));
  await writeFile(join(root, "writable-csv", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string(), count: z.coerce.number(), notes: z.string() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "writable-csv", "_store.csv"), 'id,title,count,notes\r\none,One,1,"first\r\nnote"\r\ntwo,Two,2,plain\r\n');
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
    expect((await detectProjection(join(root, "csv")))?.provider).toBe("csv");
    expect((await detectProjection(join(root, "json")))?.provider).toBe("json");
    expect((await detectProjection(join(root, "jsonl")))?.provider).toBe("jsonl");
    expect((await detectProjection(join(root, "markdown")))?.provider).toBe("markdown");
    expect((await detectProjection(join(root, "sqlite")))?.provider).toBe("sqlite");
  });

  test("validates CSV rows in the schema sandbox", async () => {
    const collections = new ProjectionProviderHost();
    const summary = await collections.descriptor(join(root, "csv"));
    const page = await childrenOf(collections, join(root, "csv"), "/csv", null, 20);
    expect(summary?.columns).toEqual(["id", "title", "count"]);
    expect(page.items[0]?.properties.count).toBe(1);
    expect(page.items[0]?.ref.stableKey).toBe(canonicalStableKey([["id", "one"]]));
    expect(page.items[0]?.capabilities.properties?.writable).toBe(false);
    expect(page.items[1]?.diagnostics[0]?.code).toBe("schema-validation");
    expect(page.items[1]?.ref.stableKey).toBeNull();
  });

  test("reports malformed JSONL by source line", async () => {
    const page = await childrenOf(new ProjectionProviderHost(), join(root, "jsonl"), "/jsonl", null, 20);
    expect(page.items[1]?.diagnostics[0]?.code).toBe("invalid-jsonl");
    expect(page.items[1]?.diagnostics[0]?.row).toBe(2);
    expect(page.items[0]?.ref.stableKey).toBe(canonicalStableKey([["id", "one"]]));
    expect(page.items[0]?.capabilities.properties?.writable).toBe(false);
  });

  test("uses declared keys for JSON row paths, keyset paging, and direct resolution", async () => {
    const collections = new ProjectionProviderHost();
    const first = await childrenOf(collections, join(root, "json"), "/json", null, 1);
    expect((await collections.descriptor(join(root, "json")))?.identityRule).toEqual({ properties: ["id"] });
    expect(first.items[0]).toMatchObject({ ref: { path: "/json/a", stableKey: canonicalStableKey([["id", "a"]]) } });
    expect(first.nextCursor).not.toBeNull();

    const second = await childrenOf(collections, join(root, "json"), "/json", first.nextCursor, 1);
    expect(second.items[0]).toMatchObject({ ref: { path: "/json/b", stableKey: canonicalStableKey([["id", "b"]]) } });
    expect(second.nextCursor).toBeNull();

    const resolved = await resolveChild(collections, join(root, "json"), "/json", {
      path: "/json/stale-readable-path",
      stableKey: canonicalStableKey([["id", "b"]]),
    });
    expect(resolved?.properties.title).toBe("Second");

    const beforeFormatting = await collections.descriptor(join(root, "json"));
    await writeFile(join(root, "json", "_store.json"), '[\n  { "id": "b", "title": "Second" },\n  { "id": "a", "title": "First" }\n]\n');
    const afterFormatting = await collections.descriptor(join(root, "json"));
    expect(afterFormatting?.revision).not.toBe(beforeFormatting?.revision);
    expect(afterFormatting?.modelHash).toBe(beforeFormatting?.modelHash);
    await expect(childrenOf(collections, join(root, "json"), "/json", first.nextCursor, 1)).rejects.toThrow("another revision");
  });

  test("never falls back from duplicate or nullable declared identity", async () => {
    const duplicate = join(root, "duplicate");
    await mkdir(duplicate);
    await writeFile(join(duplicate, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(duplicate, "_store.json"), '[{"id":"same","title":"One"},{"id":"same","title":"Two"}]\n');
    const page = await childrenOf(new ProjectionProviderHost(), duplicate, "/duplicate", null, 20);
    expect(page.items.every((row) => row.ref.stableKey === null)).toBe(true);
    expect(page.items.every((row) => row.diagnostics.some((item) => item.code === "duplicate-row-key"))).toBe(true);

    const nullable = join(root, "nullable");
    await mkdir(nullable);
    await writeFile(join(nullable, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string().optional() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(nullable, "_store.json"), "[]\n");
    await expect(new ProjectionProviderHost().descriptor(nullable)).rejects.toThrow("required schema properties");
  });

  test("keeps Markdown identity in the same property map as record fields", async () => {
    const page = await childrenOf(new ProjectionProviderHost(), join(root, "markdown"), "/markdown", null, 20);
    expect(page.items[0]?.capabilities.properties?.writable).toBe(true);
    expect(page.items[0]?.properties).toEqual({ id: "abc123", title: "One", status: "draft" });
  });

  test("prepares and atomically commits exact-source JSON, JSONL, and CSV row edits", async () => {
    const cases = [
      {
        name: "writable-json",
        source: "_store.json",
        before: '[\n  { "id": "one", "title": "One", "count": 1 },\n  {\n    "id":"two",\n    "title":"Two",\n    "count":2\n  }\n]\n',
        after: '[\n  { "id": "one", "title": "One", "count": 1 },\n  {"id":"two","title":"Updated","count":3}\n]\n',
        properties: { id: "two", title: "Updated", count: 3 },
      },
      {
        name: "writable-jsonl",
        source: "_store.jsonl",
        before: '{"id":"one","title":"One","count":1}\r\n  {"id":"two","title":"Two","count":2}  \r\n',
        after: '{"id":"one","title":"One","count":1}\r\n  {"id":"two","title":"Updated","count":3}  \r\n',
        properties: { id: "two", title: "Updated", count: 3 },
      },
      {
        name: "writable-csv",
        source: "_store.csv",
        before: 'id,title,count,notes\r\none,One,1,"first\r\nnote"\r\ntwo,Two,2,plain\r\n',
        after: 'id,title,count,notes\r\none,One,1,"first\r\nnote"\r\ntwo,Updated,3,changed\r\n',
        properties: { id: "two", title: "Updated", count: 3, notes: "changed" },
      },
    ] as const;
    for (const item of cases) {
      const collections = new ProjectionProviderHost();
      const directory = join(root, item.name);
      const ref = { path: `/${item.name}/stale`, stableKey: canonicalStableKey([["id", "two"]]) };
      const target = await writeTarget(collections, directory, `/${item.name}`, ref);
      expect(target?.writable).toBe(true);
      const prepared = await prepareWrite(collections, target!, target!.revision, item.properties, `write-${item.name}`);
      if (prepared.storage !== "provider") throw new Error("Expected a provider-owned write");
      expect(await readFile(join(directory, item.source), "utf8")).toBe(item.before);
      const saved = await prepared.write.commit();
      expect(saved.properties).toEqual(item.properties);
      expect(await readFile(join(directory, item.source), "utf8")).toBe(item.after);
      await collections[Symbol.asyncDispose]();
    }
  });

  test("rejects stale exact-source commits, invalid candidates, and identity changes", async () => {
    const directory = join(root, "writable-json");
    const path = join(directory, "_store.json");
    const collections = new ProjectionProviderHost();
    const ref = { path: "/writable-json/stale", stableKey: canonicalStableKey([["id", "one"]]) };
    const target = await writeTarget(collections, directory, "/writable-json", ref);
    const original = await readFile(path, "utf8");
    await expect(prepareWrite(collections, target!, target!.revision, { id: "renamed", title: "No", count: 1 }, "bad-identity"))
      .rejects.toMatchObject({ code: "invalid-write" });
    await expect(prepareWrite(collections, target!, target!.revision, { id: "one", title: 7, count: 1 }, "bad-schema"))
      .rejects.toMatchObject({ code: "invalid-write" });
    expect(await readFile(path, "utf8")).toBe(original);

    const beforeAbort = await readdir(directory);
    const abandoned = await prepareWrite(collections, target!, target!.revision, { id: "one", title: "Abandoned", count: 4 }, "abandoned");
    if (abandoned.storage !== "provider") throw new Error("Expected a provider-owned write");
    await abandoned.write.abort();
    expect(await readdir(directory)).toEqual(beforeAbort);
    expect(await readFile(path, "utf8")).toBe(original);

    const prepared = await prepareWrite(collections, target!, target!.revision, { id: "one", title: "Changed", count: 4 }, "stale-source");
    if (prepared.storage !== "provider") throw new Error("Expected a provider-owned write");
    await writeFile(path, `${original} `);
    await expect(prepared.write.commit()).rejects.toMatchObject({ code: "stale-source" });
    expect(await readFile(path, "utf8")).toBe(`${original} `);
    await collections[Symbol.asyncDispose]();
  });

  test("serializes commits against one exact source revision", async () => {
    const directory = join(root, "writable-json");
    const path = join(directory, "_store.json");
    await writeFile(path, '[{"id":"one","title":"One","count":1},{"id":"two","title":"Two","count":2}]\n');
    const collections = new ProjectionProviderHost();
    const oneRef = { path: "/writable-json/one", stableKey: canonicalStableKey([["id", "one"]]) };
    const twoRef = { path: "/writable-json/two", stableKey: canonicalStableKey([["id", "two"]]) };
    const [one, two] = await Promise.all([
      writeTarget(collections, directory, "/writable-json", oneRef),
      writeTarget(collections, directory, "/writable-json", twoRef),
    ]);
    const [preparedOne, preparedTwo] = await Promise.all([
      prepareWrite(collections, one!, one!.revision, { id: "one", title: "Changed one", count: 1 }, "serial-one"),
      prepareWrite(collections, two!, two!.revision, { id: "two", title: "Changed two", count: 2 }, "serial-two"),
    ]);
    if (preparedOne.storage !== "provider" || preparedTwo.storage !== "provider") throw new Error("Expected provider-owned writes");
    const committed = await Promise.allSettled([
      preparedOne.write.commit(),
      preparedTwo.write.commit(),
    ]);
    expect(committed[0]?.status).toBe("fulfilled");
    expect(committed[1]?.status).toBe("rejected");
    expect(committed[1]?.status === "rejected" ? committed[1].reason : null)
      .toMatchObject({ code: "stale-source" });
    expect(await readFile(path, "utf8"))
      .toBe('[{"id":"one","title":"Changed one","count":1},{"id":"two","title":"Two","count":2}]\n');
    await collections[Symbol.asyncDispose]();
  });

  test("keeps a logical no-op byte-identical regardless of property order", async () => {
    const directory = join(root, "writable-json");
    const path = join(directory, "_store.json");
    const collections = new ProjectionProviderHost();
    const ref = { path: "/writable-json/one", stableKey: canonicalStableKey([["id", "one"]]) };
    const target = await writeTarget(collections, directory, "/writable-json", ref);
    const before = await readFile(path, "utf8");
    const prepared = await prepareWrite(collections, target!, target!.revision, {
      count: 1,
      title: "Changed one",
      id: "one",
    }, "logical-noop");
    if (prepared.storage !== "provider") throw new Error("Expected a provider-owned write");
    await prepared.write.commit();
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await writeTarget(collections, directory, "/writable-json", ref))?.revision).toBe(target?.revision);
    await collections[Symbol.asyncDispose]();
  });

  test("projects SQLite tables and rows through the shared schema metadata", async () => {
    const collections = new ProjectionProviderHost();
    const directory = join(root, "sqlite");
    const summary = await collections.descriptor(directory);
    expect(summary).toMatchObject({
      tables: ["items", "memberships"],
      representation: { type: "rollup", codec: "sqlite", scope: "subtree" },
      editable: false,
    });
    expect(summary?.schemaRevision).toMatch(/^sha256:/);

    const table = await (await collections.open(directory))!.tableDescriptor("items");
    expect(table).toMatchObject({
      columns: ["id", "title", "active"],
      identityRule: { properties: ["id"] },
      representation: { type: "rollup", codec: "sqlite", scope: "children" },
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

    const resolved = await resolveChild(collections, directory, "/sqlite/items", {
      path: "/sqlite/items/stale-readable-path",
      stableKey: canonicalStableKey([["id", "b"]]),
    }, "items");
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
    const collections = new ProjectionProviderHost();
    expect(await collections.descriptor(directory)).toMatchObject({ tables: ["notes"] });
    expect((await childrenOf(collections, directory, "/standalone-sqlite/notes", null, 20, "notes")).items[0]?.ref.path)
      .toBe("/standalone-sqlite/notes/one");
  });

  test("CAS-replaces stable SQLite row properties with durable idempotency", async () => {
    const directory = join(root, "sqlite");
    const collections = new ProjectionProviderHost();
    const before = await writeTarget(collections, directory, "/sqlite/items", {
      path: "/sqlite/items/stale-path",
      stableKey: canonicalStableKey([["id", "a"]]),
    }, "items");
    expect(before?.writable).toBe(true);
    const write = async (id: string, base: string, title: string, rowID = "a") => {
      const prepared = await prepareWrite(collections, before!, base, { id: rowID, title, active: false }, id);
      if (prepared.storage !== "provider") throw new Error("Expected a provider-owned write");
      const saved = await prepared.write.commit();
      return { ...saved, values: saved.properties };
    };
    const saved = await write("write-a-1", before!.revision, "First updated");
    expect(saved.values).toEqual({ id: "a", title: "First updated", active: false });
    expect(saved.revision).not.toBe(before?.revision);
    expect(await write("write-a-1", before!.revision, "First updated")).toEqual(saved);
    await expect(write("write-a-1", before!.revision, "Different")).rejects.toMatchObject({ code: "mutation-mismatch" });
    await expect(write("write-a-stale", before!.revision, "Stale")).rejects.toMatchObject({ code: "stale-properties" });
    await expect(write("write-a-identity", saved.revision!, "No", "renamed")).rejects.toMatchObject({ code: "invalid-write" });
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
    const collections = new ProjectionProviderHost();
    const row = (await childrenOf(collections, directory, "/foreign-key-sqlite/children", null, 10, "children")).items[0]!;
    const target = await writeTarget(collections, directory, "/foreign-key-sqlite/children", row.ref, "children");
    const prepared = await prepareWrite(
      collections, target!, row.capabilities.properties!.revision,
      { id: "child", parent_id: "missing" }, "invalid-foreign-key",
    );
    if (prepared.storage !== "provider") throw new Error("Expected a provider-owned write");
    await expect(prepared.write.commit()).rejects.toThrow(/foreign key constraint/i);
    expect((await resolveChild(collections, directory, "/foreign-key-sqlite/children", {
      path: "/foreign-key-sqlite/children/child",
      stableKey: row.ref.stableKey,
    }, "children"))?.properties.parent_id).toBe("parent");
  });
});
