import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRowEdits,
  checkRows,
  compileUsl,
  firstParagraph,
  layoutOf,
  presentView,
  viewEdits,
  viewsOf,
  ViewError,
  type CheckResult,
  type Presentation,
  type RowEdit,
  type RowsByTable,
  type ViewIntent,
} from "@ovst/usl";
import { verifyFiles } from "@ovst/usl/verify";

interface Fixture { schema: string; rows: RowsByTable; people: Record<string, string> }
interface Vectors {
  fixtures: Record<string, Fixture>;
  presentations: Array<{ name: string; fixture: string; model?: string; view?: number; query?: string; expected: Presentation }>;
  intents: Array<{ name: string; fixture: string; model?: string; view?: number; intent: ViewIntent; operations?: RowEdit[]; rows?: RowsByTable; error?: true }>;
}

const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/overstory-spec/conformance/presented-views.json"), "utf8")) as Vectors;
const schemas = new Map(Object.entries(vectors.fixtures).map(([name, f]) => [name, compileUsl(f.schema)]));
const schemaOf = (name: string): CheckResult => schemas.get(name)!;

/** What `usl verify` says of rows written as one `<Table>.jsonl` per table. */
function verify(schema: CheckResult, rows: RowsByTable) {
  const tables = layoutOf(schema, { store: "files" });
  const dir = mkdtempSync(join(tmpdir(), "presented-views-"));
  try {
    for (const table of tables) {
      writeFileSync(join(dir, `${table.name}.jsonl`), (rows[table.name] ?? []).map((r) => `${JSON.stringify(r)}\n`).join(""));
    }
    return verifyFiles(tables, dir).filter((d) => d.severity === "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("presented views: shared vectors", () => {
  test("the fixtures check clean and their rows verify", () => {
    for (const [name, fixture] of Object.entries(vectors.fixtures)) {
      expect(schemaOf(name).diagnostics).toEqual([]);
      expect(checkRows(schemaOf(name), fixture.rows)).toEqual([]);
      expect(verify(schemaOf(name), fixture.rows)).toEqual([]);
    }
  });

  test("the games and excellences fixtures use the plan's examples", () => {
    const examples = join(import.meta.dir, "../../plans/schema-language/examples");
    for (const name of ["games", "excellences"]) {
      expect(compileUsl(readFileSync(join(examples, `${name}.usl`), "utf8")).models).toEqual(schemaOf(name).models);
    }
  });

  for (const item of vectors.presentations) {
    test(`presents ${item.name}`, () => {
      const fixture = vectors.fixtures[item.fixture]!;
      const presented = presentView(schemaOf(item.fixture), fixture.rows, { model: item.model, view: item.view, query: item.query, people: fixture.people });
      expect(presented).toEqual(item.expected);
    });
  }

  for (const item of vectors.intents) {
    test(`intent: ${item.name}`, () => {
      const fixture = vectors.fixtures[item.fixture]!;
      const schema = schemaOf(item.fixture);
      const options = { model: item.model, view: item.view, people: fixture.people };
      if (item.error) {
        expect(() => viewEdits(schema, fixture.rows, options, item.intent)).toThrow(ViewError);
        return;
      }
      const operations = viewEdits(schema, fixture.rows, options, item.intent);
      expect(operations).toEqual(item.operations!);
      const after = applyRowEdits(schema, fixture.rows, operations);
      expect(after).toEqual(item.rows!);
      // Every intent round-trips to row operations `usl verify` accepts,
      // and the result presents again.
      expect(checkRows(schema, after)).toEqual([]);
      expect(verify(schema, after)).toEqual([]);
      expect(() => presentView(schema, after, options)).not.toThrow();
    });
  }
});

describe("presented views", () => {
  const games = schemaOf("games");
  const rows = vectors.fixtures.games!.rows;

  test("an edit under any group changes the one row", () => {
    const view = presentView(games, rows, { view: 2 });
    const occurrences = view.groups.flatMap((g) => g.lines).filter((l) => l.row === '[["id","g1"]]');
    expect(occurrences.map((l) => l.occurrence)).toEqual([
      '["By list","\\"l2\\"","[[\\"id\\",\\"g1\\"]]"]',
      '["By list","\\"l1\\"","[[\\"id\\",\\"g1\\"]]"]',
    ]);
    const edits = viewEdits(games, rows, { view: 2 }, { kind: "set", row: '[["id","g1"]]', field: "name", value: "Wingspan 2" });
    expect(edits).toEqual([{ kind: "rowSet", table: "Game", row: '[["id","g1"]]', field: "name", before: "Wingspan", value: "Wingspan 2" }]);
  });

  test("a model without @@views has a plain view and one per reference", () => {
    const schema = compileUsl(vectors.fixtures.tasks!.schema);
    expect(viewsOf(schema, "Task").map((v) => [v.label, v.group])).toEqual([["All", undefined], ["By owner", "owner"], ["By project", "project"]]);
    expect(viewsOf(schema, "Task")[0]!.line.map((i) => i.field)).toEqual(["title", "notes", "points", "done", "owner", "project", "labels"]);
  });

  test("a view without a line shows the first view's", () => {
    expect(viewsOf(games, "Game")[1]!.line.map((i) => i.field)).toEqual(["status", "name", "authors", "description"]);
  });

  test("a page's views override the schema's", () => {
    const presented = presentView(games, rows, { views: [{ label: "Mine", line: [{ field: "name", bullet: false, summary: false }], group: "status" }] });
    expect(presented.tabs).toEqual([{ label: "Mine" }]);
    expect(presented.groups.map((g) => [g.id, g.kind, g.lines.length])).toEqual([['"Draft"', "choice", 1], ['"Playtested"', "choice", 1], ['"Polished"', "choice", 1]]);
  });

  test("capabilities come from the host's ownership rule", () => {
    const presented = presentView(games, rows, { view: 1, canEdit: (_table, row) => row !== '[["id","g2"]]' });
    expect(presented.capabilities['[["id","g2"]]']).toEqual({ edit: false, delete: false, groups: ['"p-ada"', '"p-bo"'] });
    expect(presented.capabilities['[["id","g1"]]']!.edit).toBe(true);
  });

  test("the first paragraph of Markdown", () => {
    expect(firstParagraph("")).toBe("");
    expect(firstParagraph("\n\n  One\r\ntwo  \n\nThree")).toBe("One two");
    expect(firstParagraph("# Title\nbody")).toBe("# Title body");
  });

  test("applying row operations refuses what doesn't apply", () => {
    const set = (before: string): RowEdit => ({ kind: "rowSet", table: "Game", row: '[["id","g1"]]', field: "name", before, value: "X" });
    expect(() => applyRowEdits(games, rows, [set("Not it")])).toThrow(ViewError);
    expect(() => applyRowEdits(games, rows, [{ kind: "rowConnect", table: "Game", row: '[["id","g1"]]', field: "authors", member: "p-ada" }])).toThrow(ViewError);
    expect(() => applyRowEdits(games, rows, [{ kind: "rowDelete", table: "Game", row: '[["id","g9"]]' }])).toThrow(ViewError);
    expect(() => applyRowEdits(games, rows, [{ kind: "rowSet", table: "Game", row: '[["id","g1"]]', field: "modified", before: "2026-10-01T09:00:00Z", value: "x" }])).toThrow(ViewError);
    expect(() => applyRowEdits(games, rows, [{ kind: "rowMove", table: "List", row: '[["id","l1"]]', field: "games", member: "g2", after: null }])).toThrow(ViewError);
    // Applying never changes its input.
    expect(rows.Game![0]!.name).toBe("Wingspan");
  });

  test("checkRows finds dangling references and duplicate keys", () => {
    const broken: RowsByTable = { ...rows, List: [...rows.List!, { id: "l1", name: "Again", games: ["g9"] }] };
    expect(checkRows(games, broken).map((d) => d.code).sort()).toEqual(["dangling-reference", "duplicate-key"]);
  });

  test("an edit that leaves an invalid row is refused", () => {
    expect(() => viewEdits(games, rows, {}, { kind: "connect", row: '[["id","g1"]]', field: "lists", member: "l9" })).toThrow(ViewError);
    expect(() => viewEdits(games, rows, {}, { kind: "create", id: "g1" })).toThrow(ViewError);
  });
});
