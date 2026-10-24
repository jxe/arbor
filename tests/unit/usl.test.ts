import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileUsl, modelLayer, parseUsl } from "@ovst/usl";

const examples = join(import.meta.dir, "../../packages/usl/examples");
const usl = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".usl"));

describe("usl examples", () => {
  for (const name of usl(examples)) {
    test(`${name} checks clean`, () => {
      expect(compileUsl(readFileSync(join(examples, name), "utf8")).diagnostics).toEqual([]);
    });
  }
});

describe("usl broken examples", () => {
  const dir = join(examples, "invalid");
  for (const name of usl(dir)) {
    test(`${name} reports exactly what it expects`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const expected = [...source.matchAll(/^\/\/ expect: ([a-z-]+)$/gm)].map((m) => m[1]!).sort();
      expect(expected.length).toBeGreaterThan(0);
      const actual = compileUsl(source).diagnostics.map((d) => d.code).sort();
      expect(actual).toEqual(expected);
    });
  }
});

describe("usl resolution", () => {
  test("a connection model is keyed by its ends and gives each side a field", () => {
    const { models } = compileUsl(`
      model Game { name Text }
      model Rating { Person.ratings[], Game.ratings[], stars Number }
    `);
    const rating = models.find((m) => m.name === "Rating")!;
    expect(rating.key).toEqual(["person", "game"]);
    const game = models.find((m) => m.name === "Game")!;
    expect(game.fields.find((f) => f.name === "ratings")).toMatchObject({ type: "Rating", arity: "many", origin: "connection" });
  });

  test("arrow and braces spell the same connection", () => {
    const arrow = compileUsl(`model Game { name Text }\nGame.authors[] <-> Person.games[]`);
    const braces = compileUsl(`model Game { name Text }\n{ Game.authors[], Person.games[] }`);
    expect(arrow.models).toEqual(braces.models);
    expect(arrow.connections).toEqual(braces.connections);
  });

  test("storage: 1:n is a column on the single side, n:m an array on the first end with a table", () => {
    const { connections } = compileUsl(`
      model Episode { title Text }
      model Series { title Text }
      Series.episodes[] <-> Episode.series
      Person.games[] <-> Game.authors[]
      model Game { name Text }
    `);
    expect(connections.map((c) => c.storage)).toEqual([
      { kind: "column", on: "Episode", field: "series" },
      { kind: "array", on: "Game", field: "authors", sqlite: "join table" },
    ]);
  });

  test("views and fixed-row colors are resolved for presentation", () => {
    const excellence = compileUsl(readFileSync(join(examples, "excellences.usl"), "utf8")).models;
    expect(excellence.find((m) => m.name === "Excellence")!.views).toEqual([
      {
        label: "By project",
        line: [
          { field: "name", bullet: false, summary: false },
          { field: "leads", bullet: false, summary: false, label: "lead" },
          { field: "assessment", bullet: true, summary: false },
          { field: "projects", bullet: false, summary: true, label: "project" },
        ],
        group: "projects",
      },
      { label: "By lead", line: expect.any(Array), group: "leads" },
      { label: "By assessment", line: expect.any(Array), group: "assessment" },
    ]);
    expect(excellence.find((m) => m.name === "Assessment")!.schemaRows[0]).toEqual({ name: "Good", values: {}, color: "#27815a" });
  });

  test("syntax errors carry a position", () => {
    expect(parseUsl("model A {\n  x Text,,\n  y\n}").diagnostics).toEqual([
      { code: "syntax", message: "Expected a type for field `y`, found end of line", line: 3, column: 4 },
    ]);
  });
});

describe("usl editor support", () => {
  const editors = join(import.meta.dir, "../../packages/usl/editors");
  test("Zed's queries are the tree-sitter grammar's", () => {
    const queries = join(editors, "tree-sitter-usl/queries");
    for (const name of readdirSync(queries)) {
      expect(readFileSync(join(editors, "zed/languages/usl", name), "utf8")).toBe(readFileSync(join(queries, name), "utf8"));
    }
  });
});

describe("usl model layer", () => {
  const layer = (source: string) => modelLayer(compileUsl(source));
  const base = "main model Game {\n  name Text\n  status Status\n}\nGame.authors[] <-> Person.games[]\nGame.status <-> Status.games[]\nenum Status { B, A }\n";

  test("leaves out storage and presentation", () => {
    const decorated =
      'main model Game {\n  name Text @column("title")\n  status Status\n  @table("games")\n  @index(name)\n}\n' +
      "Game.authors[] @fold <-> Person.games[]\nGame.status <-> Status.games[]\nenum Status { B, A }\n" +
      're Status {\n  A ~color("#111111") @stored("a")\n}\nre Game {\n  ~views([{ label: "All" }])\n}\n';
    expect(layer(decorated)).toEqual(layer(base));
  });

  test("is ordered by name, whatever order the schema uses", () => {
    const reordered = "enum Status { A, B }\nGame.status <-> Status.games[]\nmain model Game {\n  status Status\n  name Text\n}\nGame.authors[] <-> Person.games[]\n";
    expect(layer(reordered)).toEqual(layer(base));
    expect(layer(base).models.map((m) => m.name)).toEqual(["Game", "Person", "Status"]);
  });

  test("changes with the model", () => {
    expect(layer(base.replace("name Text", "name unique Text"))).not.toEqual(layer(base));
    expect(layer(base.replace("main model", "model"))).not.toEqual(layer(base));
  });
});
