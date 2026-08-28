import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Workspace } from "@arbor/arborsync";
import { arbor, NodeLiveQueryBroker, NodeQueryEngine, query, RegisteredQueryRuntime, SQLiteQueryEngine, type ProfileResolver } from "arbor/data";

let root: string;
let state: string;
let workspace: Workspace;
let sqlite: SQLiteQueryEngine;

const records = arbor("./records").children;
const matching = query.many(records, (record: any) => ({
  where: record.title.contains("a"),
  select: record.pick("id", "title"),
}));
const keyed = arbor("./keys").children;
const allKeys = query.many(keyed, (row: any) => row.pick("rank", "id", "title"));
const oneKey = query.one(keyed, (row: any) => ({
  where: [row.rank.eq(2), row.id.eq("é")],
  select: row.pick("rank", "id", "title"),
}));
const missingKey = query.maybe(keyed, (row: any) => ({
  where: [row.rank.eq(99), row.id.eq("missing")],
  select: row.pick("rank", "id"),
}));
const noCoercion = query.many(keyed, (row: any) => ({
  where: row.rank.eq("2"),
  select: row.pick("rank", "id"),
}));

function ordinaryNodes(): NodeQueryEngine {
  return new NodeQueryEngine({
    async snapshot(sourcePath) {
      const path = `/${sourcePath.replace(/^\.\//, "")}`;
      return workspace.snapshot({ tree: workspace.tree, path, stableKey: null });
    },
    async children(source, cursor) {
      return workspace.children(source, cursor);
    },
  });
}

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
  const expandedKeys = join(root, "keys");
  await mkdir(expandedKeys);
  await writeFile(join(expandedKeys, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ rank: z.number(), id: z.string(), title: z.string() }); export const primaryKey = ["rank", "id"] as const;\n');
  await writeFile(join(expandedKeys, "one.md"), "---\nrank: 2\nid: é\ntitle: Accent\n---\n");
  await writeFile(join(expandedKeys, "two.md"), "---\nrank: 10\nid: a\ntitle: Ten\n---\n");
  await writeFile(join(expandedKeys, "three.md"), "---\nrank: 2\nid: 😀\ntitle: Emoji\n---\n");
  workspace = await Workspace.open(root);

  const databaseDirectory = join(root, "sqlite");
  await mkdir(databaseDirectory);
  const schema = "create table records (id text primary key, title text not null); create table keys (rank integer not null, id text not null, title text not null, primary key (rank, id));";
  await writeFile(join(databaseDirectory, "schema.sql"), `${schema}\n`);
  await writeFile(join(databaseDirectory, "relationships.json"), '{"version":1,"relationships":{}}\n');
  const database = new Database(join(databaseDirectory, "_store.sqlite3"));
  database.exec(schema);
  database.query("insert into records values (?, ?), (?, ?), (?, ?)").run("a", "Alpha", "b", "Beta", "c", "Other");
  database.query("insert into keys values (?, ?, ?), (?, ?, ?), (?, ?, ?)").run(2, "é", "Accent", 10, "a", "Ten", 2, "😀", "Emoji");
  database.close();
  const profiles: ProfileResolver = { async resolve() { return { rows: [], dependencies: [] }; } };
  sqlite = await SQLiteQueryEngine.open({
    directory: databaseDirectory,
    databasePath: join(databaseDirectory, "_store.sqlite3"),
    schemaPath: join(databaseDirectory, "schema.sql"),
    relationshipsPath: join(databaseDirectory, "relationships.json"),
    tree: workspace.tree,
    path: "/",
  }, profiles);
  sqlite.bind(matching, {
    authoredPath: matching.source.path,
    tree: workspace.tree,
    path: "/records",
    schemaFingerprint: sqlite.schema.fingerprint,
  });
  for (const handle of [allKeys, oneKey, missingKey, noCoercion]) {
    sqlite.bind(handle, {
      authoredPath: handle.source.path,
      tree: workspace.tree,
      path: "/keys",
      schemaFingerprint: sqlite.schema.fingerprint,
    });
  }
});

afterAll(async () => {
  await sqlite?.[Symbol.asyncDispose]();
  await workspace?.[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("portable arbor() node queries", () => {
  test("uses the same filtering and picking handle over expanded and SQLite children", async () => {
    const nodes = ordinaryNodes();
    const [expanded, rolledUp] = await Promise.all([nodes.execute(matching), sqlite.execute(matching)]);
    expect(expanded.result).toEqual([
      { id: "a", title: "Alpha" },
      { id: "b", title: "Beta" },
    ]);
    expect(rolledUp.result).toEqual(expanded.result);
    expect(expanded.dependencies.rows).toHaveLength(3);
    expect(expanded.dependencies.membership.ref.path).toBe("/records");
    expect(expanded.dependencies.membership.revision).toBeTruthy();
    expect(expanded.dependencies.membership.observedThrough).toContain(":");
  });

  test("uses canonical compound stable-key order and shared one/maybe cardinality", async () => {
    const nodes = ordinaryNodes();
    const [ordinaryMany, sqliteMany, ordinaryOne, sqliteOne, ordinaryMissing, sqliteMissing] = await Promise.all([
      nodes.execute(allKeys),
      sqlite.execute(allKeys),
      nodes.execute(oneKey),
      sqlite.execute(oneKey),
      nodes.execute(missingKey),
      sqlite.execute(missingKey),
    ]);
    expect(sqliteMany.result).toEqual(ordinaryMany.result);
    expect(ordinaryMany.result).toEqual([
      { rank: 10, id: "a", title: "Ten" },
      { rank: 2, id: "é", title: "Accent" },
      { rank: 2, id: "😀", title: "Emoji" },
    ]);
    expect(sqliteOne.result).toEqual(ordinaryOne.result);
    expect(ordinaryOne.result).toEqual({ rank: 2, id: "é", title: "Accent" });
    expect(sqliteMissing.result).toEqual(ordinaryMissing.result);
    expect(ordinaryMissing.result).toBeNull();
  });

  test("does not inherit SQLite value coercion in portable predicates", async () => {
    const [ordinary, rolledUp] = await Promise.all([
      ordinaryNodes().execute(noCoercion),
      sqlite.execute(noCoercion),
    ]);
    expect(ordinary.result).toEqual([]);
    expect(rolledUp.result).toEqual(ordinary.result);
  });

  test("captures membership before reading rows so replay covers a racing insertion", async () => {
    let sourceCursor = "";
    const nodes = new NodeQueryEngine({
      async snapshot() {
        const source = await workspace.snapshot({ tree: workspace.tree, path: "/records", stableKey: null });
        sourceCursor = source.observedThrough;
        workspace.events.emit({ tree: workspace.tree, kind: "created", ref: { tree: workspace.tree, path: "/records/new.md", stableKey: null }, origin: "external" });
        return source;
      },
      async children(source, cursor) { return workspace.children(source, cursor); },
    });
    const execution = await nodes.execute(matching);
    expect(execution.dependencies.membership.observedThrough).toBe(sourceCursor);
    expect(() => workspace.events.validate(sourceCursor)).not.toThrow();
    expect(workspace.events.currentCursor()).not.toBe(sourceCursor);
  });

  test("streams ordinary-tree queries through the provider-neutral live broker", async () => {
    const broker = new NodeLiveQueryBroker(ordinaryNodes(), workspace.events);
    const handleRef = { tree: workspace.tree, module: "/queries.ts", export: "matching", version: "query-v1" };
    const runtime = new RegisteredQueryRuntime(
      { tree: workspace.tree, path: "/index", version: "document-v1" },
      broker,
      [{ ref: handleRef, handle: matching }],
    );
    const abort = new AbortController();
    const reader = runtime.stream({
      document: runtime.document,
      queries: [{ id: "matching", handle: handleRef }],
    }, { signal: abort.signal, user: null }).getReader();
    const initial = (await reader.read()).value!;
    expect(initial.type).toBe("result");
    if (initial.type === "result" && "value" in initial) expect(initial.value).toHaveLength(2);
    expect((await reader.read()).value?.type).toBe("ready");
    await writeFile(join(root, "records", "d.md"), "---\nid: d\ntitle: Delta\n---\n");
    workspace.events.emit({ tree: workspace.tree, kind: "created", ref: { tree: workspace.tree, path: "/records/d", stableKey: null }, origin: "external" });
    const changed = (await reader.read()).value!;
    expect(changed.type).toBe("result");
    if (changed.type === "result" && "value" in changed) expect(changed.value).toHaveLength(3);
    abort.abort();
  });

  test("rejects an expanded-directory page cursor after membership changes", async () => {
    const directory = join(root, "large");
    await mkdir(directory);
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(directory, `row-${String(index).padStart(3, "0")}.md`), `# ${index}\n`)));
    const ref = { tree: workspace.tree, path: "/large", stableKey: null };
    const first = await workspace.children(ref);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    await writeFile(join(directory, "row-101.md"), "# 101\n");
    await expect(workspace.children(ref, first.nextCursor)).rejects.toThrow("page cursor does not belong");
  });

  test("rejects non-portable ordering before reading children", async () => {
    let reads = 0;
    const nodes = new NodeQueryEngine({
      async snapshot() { reads += 1; throw new Error("unexpected source read"); },
      async children() { reads += 1; throw new Error("unexpected children read"); },
    });
    const ordered = query.many(records, (record: any) => ({
      orderBy: record.title,
      select: record.pick("id", "title"),
    }));
    await expect(nodes.execute(ordered)).rejects.toThrow("does not support authored ordering");
    expect(reads).toBe(0);
  });
});
