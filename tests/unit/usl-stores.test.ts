import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { columnType, compileUsl, layoutOf, setupSql, typeDeclarations, validateRow, type Table } from "@ovst/usl";
import { compareShapes, inspectSqlite, sqliteAffinity, verifyFiles, verifyStore } from "@ovst/usl/verify";

const examples = join(import.meta.dir, "../../plans/schema-language/examples");
const fixtures = join(import.meta.dir, "../fixtures/usl");
const schemaOf = (name: string) => compileUsl(readFileSync(join(examples, `${name}.usl`), "utf8"));
const tablesOf = (name: string): Table[] => layoutOf(schemaOf(name));
const fileTablesOf = (name: string): Table[] => layoutOf(schemaOf(name), { store: "files" });
const names = readdirSync(examples)
  .filter((f) => f.endsWith(".usl"))
  .map((f) => f.slice(0, -4));

function sqliteWith(tables: Table[]): Database {
  const db = new Database(":memory:");
  const sql = setupSql(tables, "sqlite");
  db.exec(sql);
  db.exec(sql); // idempotent
  return db;
}
const verifySqlite = (tables: Table[], db: Database) =>
  compareShapes(tables, inspectSqlite(db), (_, c) => columnType(c, "sqlite"), (a, b) => sqliteAffinity(a) === sqliteAffinity(b));

describe("usl setup SQL on SQLite", () => {
  for (const name of names) {
    test(`${name}: runs twice and the database implements the schema`, () => {
      const tables = tablesOf(name);
      expect(verifySqlite(tables, sqliteWith(tables))).toEqual([]);
    });
  }

  test("seed rows are inserted once and never overwrite edits", () => {
    const tables = tablesOf("stress");
    const db = sqliteWith(tables);
    db.exec(`UPDATE "Genre3" SET "name" = 'Puzzles' WHERE "id" = 'Puzzle'`);
    db.exec(setupSql(tables, "sqlite"));
    expect(db.query(`SELECT "id", "name" FROM "Genre3" ORDER BY "id"`).all()).toEqual([
      { id: "Puzzle", name: "Puzzles" },
      { id: "Strategy", name: "Strategy" },
    ]);
  });

  test("constraints hold: fixed values, composite references, cascades", () => {
    const db = sqliteWith(tablesOf("supplies"));
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`INSERT INTO "List" ("id", "name", "openToEdits", "owner", "visibility", "kind") VALUES ('l1', 'Mine', 0, 'p1', 'Public', 'Tagged')`);
    expect(() =>
      db.exec(`INSERT INTO "List" ("id", "name", "openToEdits", "owner", "visibility", "kind") VALUES ('l2', 'Bad', 0, 'p1', 'Secret', 'Tagged')`),
    ).toThrow(/CHECK/);
    db.exec(`INSERT INTO "Practice" ("id", "name") VALUES ('pr1', 'Breathing')`);
    db.exec(`INSERT INTO "Tag" ("list", "id", "name") VALUES ('l1', 't1', 'calm')`);
    db.exec(`INSERT INTO "Tag_practices" ("tag_list", "tag_id", "practice") VALUES ('l1', 't1', 'pr1')`);
    expect(() => db.exec(`INSERT INTO "Tag_practices" ("tag_list", "tag_id", "practice") VALUES ('l2', 't1', 'pr1')`)).toThrow(/FOREIGN KEY/);
    db.exec(`DELETE FROM "Practice" WHERE "id" = 'pr1'`);
    expect(db.query(`SELECT count(*) AS n FROM "Tag_practices"`).get()).toEqual({ n: 0 });
  });

  test("reports where a database differs", () => {
    const tables = tablesOf("stress");
    const db = new Database(":memory:");
    // Hand-written drift: a nullable title, an untyped extra column, no Team_members, and Rating without its foreign key.
    db.exec(setupSql(tables, "sqlite").replace(`"title" TEXT NOT NULL,\n  "body"`, `"title" TEXT,\n  "body"`));
    db.exec(`ALTER TABLE "Game" ADD COLUMN "extra" TEXT NOT NULL DEFAULT ''`);
    db.exec(`DROP TABLE "Team_members"`);
    db.exec(`CREATE TABLE "Notes" ("id" TEXT PRIMARY KEY)`);
    const codes = verifySqlite(tables, db).map((d) => `${d.severity}:${d.code}:${d.table}`);
    expect(codes.sort()).toEqual(
      ["error:column-nullable:Page", "warning:extra-column:Game", "error:missing-table:Team_members", "warning:extra-table:Notes"].sort(),
    );
  });
});

const postgresUrl = process.env.USL_TEST_POSTGRES;
describe.skipIf(!postgresUrl)("usl setup SQL on Postgres (USL_TEST_POSTGRES=postgres://...)", () => {
  for (const name of names) {
    test(`${name}: runs twice and the database implements the schema`, async () => {
      const admin = new SQL(postgresUrl!);
      const db = `usl_test_${name}`;
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
      await admin.unsafe(`CREATE DATABASE ${db}`);
      await admin.close();
      const url = new URL(postgresUrl!);
      url.pathname = `/${db}`;
      const sql = new SQL(url.toString());
      const tables = tablesOf(name);
      await sql.unsafe(setupSql(tables, "postgres")).simple();
      await sql.unsafe(setupSql(tables, "postgres")).simple();
      await sql.close();
      expect(await verifyStore(schemaOf(name), url.toString())).toEqual([]);
    });
  }
});

describe("usl data files", () => {
  test("a folder of CSV, JSON and JSONL files that implements the games schema", () => {
    expect(verifyFiles(fileTablesOf("games"), join(fixtures, "games-files"))).toEqual([]);
  });

  test("broken files report each problem", () => {
    const codes = verifyFiles(fileTablesOf("games"), join(fixtures, "games-files-broken")).map((d) => `${d.severity}:${d.code}:${d.table ?? ""}`);
    expect(codes.sort()).toEqual(
      [
        "warning:extra-column:Game",
        "error:bad-value:Game",
        "error:bad-value:Game",
        "error:missing-value:Game",
        "error:duplicate-key:Game",
        "error:bad-value:List",
        "error:dangling-reference:List",
        "warning:extra-table:",
      ].sort(),
    );
  });

  test("validateRow checks one row as Overstory would on write", () => {
    const game = tablesOf("games").find((t) => t.name === "Game")!;
    expect(validateRow(game, { id: "g", name: "Go", status: "Draft", tags: ["x"] })).toEqual([]);
    expect(validateRow(game, { id: "g", status: "Done", tags: "x" }).map((d) => d.code)).toEqual(["bad-value", "bad-value", "missing-value"]);
  });
});

describe("usl storage names and folding", () => {
  test("@@table and @column rename what is stored, references included", () => {
    const tables = tablesOf("stress");
    const episode = tables.find((t) => t.name === "Episode")!;
    expect(tables.map((t) => t.name)).toContain("series");
    expect(episode.foreignKeys).toContainEqual({ columns: ["series_id"], table: "series", refColumns: ["id"], onDelete: "restrict" });
    expect(tables.find((t) => t.name === "series")!.columns.map((c) => c.name)).toContain("series_title");
  });

  test("@fold keeps an n:m as an array in data files and a join table in databases", () => {
    expect(tablesOf("games").map((t) => t.name)).toEqual(["Game", "List", "Game_authors", "List_games"]);
    const files = fileTablesOf("games");
    expect(files.map((t) => t.name)).toEqual(["Game", "List"]);
    expect(files.find((t) => t.name === "List")!.columns.find((c) => c.name === "games")).toMatchObject({
      array: true,
      references: { table: "Game" },
    });
  });
});

describe("usl for Overstory", () => {
  test("type declarations follow the stored columns", () => {
    const out = typeDeclarations(tablesOf("games"));
    expect(out).toContain(`export type Game = {`);
    expect(out).toContain(`  status: "Draft" | "Playtested" | "Polished";`);
    expect(out).toContain(`  description: string | null;`);
    expect(out).toContain(`  person: string; // a Story profile id`);
  });


  test("@path names rows by a required text field", () => {
    const ok = compileUsl(`model Post { slug Text @path, title Text }`);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.models.find((m) => m.name === "Post")!.path).toBe("slug");
    expect(compileUsl(`model Post { slug Text? @path }`).diagnostics.map((d) => d.code)).toEqual(["path-field"]);
    expect(compileUsl(`model Post { a Text @path, b Text @path }`).diagnostics.map((d) => d.code)).toEqual(["duplicate-path"]);
  });

  test("Int is a whole number, stored as INTEGER and bigint", () => {
    const tables = layoutOf(compileUsl(`model Count { n Int }`));
    expect(setupSql(tables, "sqlite")).toContain(`"n" INTEGER NOT NULL`);
    expect(setupSql(tables, "postgres")).toContain(`"n" bigint NOT NULL`);
    expect(compileUsl(`model C { n Int, @@seed { A { n: 1.5 } } }`).diagnostics.map((d) => d.code)).toContain("bad-value");
  });

  test("limits stop a hostile schema", () => {
    const deep = `model A { @@views(${"[".repeat(40)}${"]".repeat(40)}) }`;
    expect(compileUsl(deep).diagnostics.map((d) => d.code)).toEqual(["limit"]);
    expect(compileUsl("x".repeat(1_100_000)).diagnostics.map((d) => d.code)).toEqual(["limit"]);
  });
});
