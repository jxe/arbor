import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Workspace } from "@arbor/arborsync";
import { arbor, NodeQueryEngine, query, SQLiteQueryEngine, type ProfileResolver } from "arbor/data";

let root: string;
let state: string;
let workspace: Workspace;
let sqlite: SQLiteQueryEngine;

const records = arbor("./records").children;
const matching = query.many(records, (record: any) => ({
  where: record.title.contains("a"),
  select: record.pick("id", "title"),
}));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-generic-query-"));
  state = await mkdtemp(join(tmpdir(), "arbor-generic-query-state-"));
  process.env.ARBOR_DATA_HOME = state;
  const expanded = join(root, "records");
  await mkdir(expanded);
  await writeFile(join(expanded, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(expanded, "a.md"), "---\nid: a\ntitle: Alpha\n---\n");
  await writeFile(join(expanded, "b.md"), "---\nid: b\ntitle: Beta\n---\n");
  await writeFile(join(expanded, "c.md"), "---\nid: c\ntitle: Other\n---\n");
  workspace = await Workspace.open(root);

  const databaseDirectory = join(root, "sqlite");
  await mkdir(databaseDirectory);
  const schema = "create table records (id text primary key, title text not null);";
  await writeFile(join(databaseDirectory, "schema.sql"), `${schema}\n`);
  await writeFile(join(databaseDirectory, "relationships.json"), '{"version":1,"relationships":{}}\n');
  const database = new Database(join(databaseDirectory, "_store.sqlite3"));
  database.exec(schema);
  database.query("insert into records values (?, ?), (?, ?), (?, ?)").run("a", "Alpha", "b", "Beta", "c", "Other");
  database.close();
  const profiles: ProfileResolver = { async resolve() { return { rows: [], dependencies: [] }; } };
  sqlite = await SQLiteQueryEngine.open({
    directory: databaseDirectory,
    databasePath: join(databaseDirectory, "_store.sqlite3"),
    schemaPath: join(databaseDirectory, "schema.sql"),
    relationshipsPath: join(databaseDirectory, "relationships.json"),
  }, profiles);
});

afterAll(async () => {
  await sqlite?.[Symbol.asyncDispose]();
  await workspace?.[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("portable arbor() node queries", () => {
  test("uses the same filtering and picking handle over expanded and SQLite children", async () => {
    const nodes = new NodeQueryEngine({
      async children(sourcePath, cursor) {
        expect(sourcePath).toBe("./records");
        const page = await workspace.children({ tree: workspace.tree, path: "/records", stableKey: null }, cursor);
        return { items: page.items, nextCursor: page.nextCursor };
      },
    });
    const [expanded, rolledUp] = await Promise.all([nodes.execute(matching), sqlite.execute(matching)]);
    expect(expanded.result).toEqual([
      { id: "a", title: "Alpha" },
      { id: "b", title: "Beta" },
    ]);
    expect(rolledUp.result).toEqual(expanded.result);
    expect(expanded.dependencies).toHaveLength(3);
  });

  test("rejects non-portable ordering before reading children", async () => {
    let reads = 0;
    const nodes = new NodeQueryEngine({ async children() { reads += 1; return { items: [], nextCursor: null }; } });
    const ordered = query.many(records, (record: any) => ({
      orderBy: record.title,
      select: record.pick("id", "title"),
    }));
    await expect(nodes.execute(ordered)).rejects.toThrow("does not support authored ordering");
    expect(reads).toBe(0);
  });
});
