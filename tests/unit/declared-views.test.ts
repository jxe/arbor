// Apps 012 step 1: the built-in list view is a view over the model. Each shared
// presented-views vector presents the same through it, reading its rows from
// SQLite through a plan, as through presentView over the rows directly, and its
// plan reads no table the entry doesn't reach.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareText, compileUsl, layoutOf, logicalFromRows, presentView, rowsFromLogical, setupSql, viewsOf, type Person, type Presentation, type RowsByTable } from "@ovst/usl";
import { convertVerified } from "../../tools/convert-usl-to-vad.ts";
import { declaredView, reachedModels, reachedTables, runView, SQLiteQueryEngine, type NodeHandle, type ProfileResolver } from "overstory/data";

interface Vectors {
  fixtures: Record<string, { schema: string; rows: RowsByTable; people: Person[] }>;
  presentations: Array<{ name: string; fixture: string; model?: string; view?: number; query?: string; expected: Presentation }>;
}

const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/overstory-spec/conformance/presented-views.json"), "utf8")) as Vectors;
const NOW = Date.parse("2026-11-08T00:00:00.000Z");
const directories: string[] = [];
const engines: SQLiteQueryEngine[] = [];

afterAll(async () => {
  for (const engine of engines) await engine[Symbol.asyncDispose]();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** A fixture's rows in a SQLite store laid out as a database, opened as the host opens one. */
async function storeOf(name: string): Promise<SQLiteQueryEngine> {
  const fixture = vectors.fixtures[name]!;
  const schema = compileUsl(fixture.schema);
  const directory = mkdtempSync(join(tmpdir(), "declared-views-"));
  directories.push(directory);
  // The vectors are written in USL; a collection's schema is VAD.
  writeFileSync(join(directory, "schema.vad"), convertVerified(fixture.schema));
  const tables = layoutOf(schema, { store: "database" });
  const rows = rowsFromLogical(schema, tables, logicalFromRows(schema, layoutOf(schema, { store: "files" }), fixture.rows, { now: NOW }));
  const database = new Database(join(directory, "_store.sqlite3"), { create: true });
  database.exec(setupSql(tables, "sqlite"));
  for (const table of tables) {
    for (const row of rows[table.name] ?? []) {
      const columns = Object.keys(row).filter((column) => row[column] !== undefined);
      if (!columns.length) continue;
      database.query(`insert or replace into "${table.name}" (${columns.map((column) => `"${column}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => { const value = row[column]; return typeof value === "boolean" ? Number(value) : value && typeof value === "object" ? JSON.stringify(value) : value; }) as never[]);
    }
  }
  database.close();
  const people: ProfileResolver = {
    async resolve(ids, fields) {
      const found = fixture.people.filter((person) => ids.includes(person.id));
      return {
        rows: found.map((person) => Object.fromEntries(fields.map((field) => [field, field === "id" ? person.id : field === "name" ? person.name : null]))),
        dependencies: found.map((person) => ({ profile: person.id, tree: person.id, ref: "r" })),
      };
    },
  };
  const engine = await SQLiteQueryEngine.open({ directory, databasePath: join(directory, "_store.sqlite3"), schemaPath: join(directory, "schema.vad"), tree: "tr_rows", path: "/c" }, people);
  engines.push(engine);
  return engine;
}

const resolve = (engine: SQLiteQueryEngine) => async (source: NodeHandle) => ({
  authoredPath: source.path,
  tree: "tr_rows",
  path: `/c/${source.path.slice("/c/".length)}`,
  schemaFingerprint: engine.schema.fingerprint,
});

describe("declared views", () => {
  for (const item of vectors.presentations) {
    test(`the built-in view presents ${item.name}`, async () => {
      const fixture = vectors.fixtures[item.fixture]!;
      const schema = compileUsl(fixture.schema);
      const engine = await storeOf(item.fixture);
      const model = item.model ?? schema.models.find((candidate) => candidate.name === item.expected.model)!.name;
      const label = viewsOf(schema, model)[item.view ?? 0]!.label;
      const handle = declaredView(schema, "/c", { label, model });
      const run = await runView(handle, { engine, resolve: resolve(engine), ...(item.query ? { input: { query: item.query } } : {}) });
      // The rows as the store holds them: every row has its times.
      const held = rowsFromLogical(schema, layoutOf(schema, { store: "files" }), logicalFromRows(schema, layoutOf(schema, { store: "files" }), fixture.rows, { now: NOW }));
      // The host knows the people the rows it reads name, and lists them by name, as it knows no directory order.
      const reached = reachedModels(schema, model, viewsOf(schema, model)[item.view ?? 0]!);
      const reachedRows = JSON.stringify(layoutOf(schema, { store: "files" })
        .filter((table) => table.ends ? table.ends.every((end) => reached.has(end.model)) : reached.has(table.stores))
        .map((table) => held[table.name] ?? []));
      const people = fixture.people.filter((person) => reachedRows.includes(JSON.stringify(person.id)))
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
      const direct = presentView(schema, held, { model, view: item.view ?? 0, people, ...(item.query ? { query: item.query } : {}) });
      expect(JSON.parse(JSON.stringify(run.output))).toEqual(JSON.parse(JSON.stringify(direct)));
      // The plan reads only the tables the entry reaches.
      const read = new Set(run.plans.map((plan) => plan.plan.relation));
      const tables = new Set(reachedTables(schema, model, viewsOf(schema, model)[item.view ?? 0]!).map((table) => table.name));
      for (const relation of read) expect(tables.has(relation)).toBe(true);
    });
  }

  test("an entry that doesn't reach a model reads none of its rows", async () => {
    const schema = compileUsl(vectors.fixtures.games!.schema);
    const plain = viewsOf(schema, "Game")[0]!;
    const tables = reachedTables(schema, "Game", { ...plain, line: [{ field: "name", bullet: false, summary: false }], group: undefined, sort: undefined });
    expect(tables.map((table) => table.name)).toEqual(["Game"]);
  });

  test("a declared view refuses input other than a search", async () => {
    const schema = compileUsl(vectors.fixtures.games!.schema);
    const handle = declaredView(schema, "/c", { label: viewsOf(schema, "Game")[0]!.label, model: "Game" });
    const engine = await storeOf("games");
    await expect(runView(handle, { engine, resolve: resolve(engine), input: { query: 3 } as never })).rejects.toThrow("takes { query }");
  });
});
