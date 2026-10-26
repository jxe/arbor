import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHUNK_MAX,
  CHUNK_MIN,
  chunkLogicalRows,
  collectionLogicalHash,
  decodeCollectionReference,
  decodeProtocolRows,
  decodeProtocolTable,
  encodeCanonicalCBOR,
  encodeLogicalTable,
  encodeProtocolRows,
  loadLogicalTable,
  type Hash,
  type LogicalRow,
} from "@ovst/protocol";
import { checkLogicalTables, compileLogicalSchema, encodeCollection, loadCollection, LogicalCollectionError } from "@ovst/collection-schema";
import { compileUsl, layoutOf, logicalFromRows, logicalModels, rowsFromLogical, type LogicalTables } from "@ovst/usl";

const examples = join(import.meta.dir, "../../packages/usl/examples");
const schema = (name: string) => compileUsl(readFileSync(join(examples, `${name}.usl`), "utf8"));
const T = "2026-10-24T09:00:00.000Z";
const row = (key: LogicalRow["key"], fields: LogicalRow["fields"] = {}): LogicalRow => ({ key, fields, created: T, modified: T });

describe("logical models", () => {
  test("hold each connection once: the ordered end, else the single side, else the first end with rows", () => {
    const models = logicalModels(schema("games"));
    expect(models.map((m) => m.name)).toEqual(["Game", "List"]);
    const [game, list] = models;
    expect(game!.fields.map((f) => [f.name, f.kind])).toEqual([
      ["name", "value"],
      ["status", "reference"],
      ["description", "value"],
      ["tags", "value"],
      ["authors", "members"],
    ]);
    expect(list!.fields.map((f) => [f.name, f.kind, f.ordered])).toEqual([["name", "value", false], ["games", "members", true]]);
  });

  test("a header key and a connection model's ends are key fields", () => {
    const models = logicalModels(schema("supplies"));
    expect(models.find((m) => m.name === "Tag")!.keyFields.map((f) => [f.name, f.kind])).toEqual([["list", "reference"], ["id", "value"]]);
    expect(models.find((m) => m.name === "Reaction")!.key).toEqual(["list", "person"]);
  });
});

describe("logical rows and projections", () => {
  const games = schema("games");
  const tables: LogicalTables = {
    Game: [
      row([["id", "g1"]], { name: "Chess", status: "Draft", tags: ["board", "classic"], authors: ["tr_profa", "tr_profb"] }),
      row([["id", "g2"]], { name: "Go", status: "Polished" }),
    ],
    List: [row([["id", "l1"]], { name: "Favorites", games: ["g2", "g1"] })],
  };

  for (const store of ["files", "database"] as const) {
    test(`round-trip through the ${store} layout`, () => {
      const layout = layoutOf(games, { store });
      const rows = rowsFromLogical(games, layout, tables);
      expect(logicalFromRows(games, layout, rows, { now: T })).toEqual(tables);
    });
  }

  test("the files and database layouts hold the same logical tables", () => {
    const files = rowsFromLogical(games, layoutOf(games, { store: "files" }), tables);
    const database = rowsFromLogical(games, layoutOf(games), tables);
    expect(Object.keys(files).sort()).toEqual(["Game", "List"]);
    expect(Object.keys(database).sort()).toEqual(["Game", "Game_authors", "List", "List_games"]);
    expect(database.List_games!.map((r) => [r.list, r.game, r.games_position])).toEqual([["l1", "g2", 0], ["l1", "g1", 1]]);
  });

  test("a set is sorted and a store's own order doesn't reach it", () => {
    const layout = layoutOf(games, { store: "files" });
    const rows = { Game: [{ id: "g1", name: "Chess", status: "Draft", tags: ["z", "a"], authors: [] }], List: [] };
    expect(logicalFromRows(games, layout, rows, { now: T }).Game![0]!.fields).toEqual({ name: "Chess", status: "Draft", tags: ["a", "z"] });
  });

  test("a multi-field key is pairs, and so is a reference to it", () => {
    const supplies = schema("supplies");
    const logical: LogicalTables = {
      Contribution: [],
      Item: [row([["list", "l1"], ["practice", "p1"]])],
      List: [row([["id", "l1"]], { name: "Walks", visibility: "Public", kind: "Tagged", openToEdits: false, owner: "tr_profa", items: [[["list", "l1"], ["practice", "p1"]]] })],
      Practice: [row([["id", "p1"]], { name: "Walking", authors: ["tr_profa"] })],
      Reaction: [],
      Tag: [row([["list", "l1"], ["id", "t1"]], { name: "outdoor", practices: ["p1"] })],
    };
    for (const store of ["files", "database"] as const) {
      const layout = layoutOf(supplies, { store });
      expect(logicalFromRows(supplies, layout, rowsFromLogical(supplies, layout, logical), { now: T })).toEqual(logical);
    }
  });
});

describe("table and rows objects", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row([["id", `r${String(i).padStart(6, "0")}`]], { n: i }));

  test("a table below the minimum is one chunk, and an empty one an empty chunk", () => {
    expect(chunkLogicalRows(many(CHUNK_MIN)).length).toBe(1);
    expect(chunkLogicalRows([])).toEqual([[]]);
  });

  test("chunks end at content-defined boundaries, at most the maximum apart", () => {
    const chunks = chunkLogicalRows(many(20_000));
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeGreaterThanOrEqual(CHUNK_MIN);
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX);
    }
    // An edit far from the start leaves earlier chunks as they were.
    const rows = many(20_000);
    rows[19_000] = { ...rows[19_000]!, fields: { n: -1 } };
    expect(chunkLogicalRows(rows)[0]).toEqual(chunks[0]!);
  });

  test("encode, load and verify a table; order and counts are checked", async () => {
    const rows = many(3000).reverse();
    const { hash, objects } = encodeLogicalTable(rows);
    const load = async (h: Hash) => objects.get(h)!;
    expect(await loadLogicalTable(hash, load)).toEqual([...rows].reverse());
    const table = decodeProtocolTable(objects.get(hash)!);
    expect(table.rows).toBe(3000);
    expect(() => decodeProtocolRows(encodeProtocolRows([rows[0]!, rows[1]!]))).toThrow("stable-key order");
    expect(() => encodeLogicalTable([rows[0]!, rows[0]!])).toThrow("Two rows");
    expect(() => decodeProtocolRows(encodeProtocolRows([{ ...rows[0]!, fields: { n: null } } as unknown as LogicalRow]))).toThrow("only when it has a value");
    expect(() => decodeProtocolTable(encodeCanonicalCBOR({ type: "table", rows: 2, chunks: [{ rows: 1, chunk: table.chunks[0]!.chunk }] }))).toThrow("sum");
  });

  test("the logical hash is the CBOR hash of the reference, which is decoded strictly", () => {
    const { hash } = encodeLogicalTable([]);
    const fingerprint = `sha256:${"0".repeat(64)}` as Hash;
    const reference = decodeCollectionReference({ version: 1, modelFingerprint: fingerprint, tables: [{ model: "Game", table: hash }] });
    expect(collectionLogicalHash(reference)).toMatch(/^sha256:/);
    expect(() => decodeCollectionReference({ ...reference, extra: 1 })).toThrow("exactly");
    expect(() => decodeCollectionReference({ ...reference, tables: [{ model: "List", table: hash }, { model: "Game", table: hash }] })).toThrow("UTF-8 order");
  });
});

describe("collections", () => {
  const source = readFileSync(join(examples, "games.usl"), "utf8");
  const logical = compileLogicalSchema(source);
  const tables: LogicalTables = {
    Game: [
      row([["id", "g2"]], { name: "Go", status: "Polished" }),
      row([["id", "g1"]], { name: "Chess", status: "Draft", tags: ["board", "classic"] }),
    ],
    List: [row([["id", "l1"]], { name: "Favorites", games: ["g2", "g1"] })],
  };
  const fields = (diagnostics: { code: string; path: string }[]) => diagnostics.map((d) => [d.code, d.path]);

  test("valid rows pass", () => {
    expect(checkLogicalTables(logical, { Game: [...tables.Game!].reverse(), List: tables.List! })).toEqual([]);
  });

  test("types, required fields, sets, references and enums are checked", () => {
    const bad: LogicalTables = {
      Game: [
        row([["id", "g1"]], { status: "Draft", tags: ["z", "a"], extra: 1 }),
        row([["id", "g2"]], { name: 2, status: "Nope" }),
      ],
      List: [row([["id", "l1"]], { name: "Favorites", games: ["g1", "g9", "g1"] })],
    };
    expect(fields(checkLogicalTables(logical, bad))).toEqual([
      ["missing-member", "/fields/name"],
      ["type-mismatch", "/fields/tags"],
      ["unknown-member", "/fields/extra"],
      ["type-mismatch", "/fields/name"],
      ["no-matching-choice", "/fields/status"],
      ["unknown-row", "/fields/games/1"],
    ]);
    expect(checkLogicalTables(logical, { Nope: [] })[0]!.message).toContain("no model Nope");
  });

  test("encode and load a collection; every model gets a table and the hash ignores input order", async () => {
    const encoded = encodeCollection(logical, tables);
    expect(encoded.reference.modelFingerprint).toBe(logical.fingerprint);
    expect(encoded.reference.tables.map((t) => t.model)).toEqual(["Game", "List"]);
    expect(encodeCollection(logical, { List: tables.List!, Game: [...tables.Game!].reverse() }).logicalHash).toBe(encoded.logicalHash);
    const load = async (h: Hash) => encoded.objects.get(h)!;
    const loaded = await loadCollection(logical, encoded.reference, load);
    expect(loaded.logicalHash).toBe(encoded.logicalHash);
    expect(loaded.tables.Game!.map((r) => r.key[0]![1])).toEqual(["g1", "g2"]);
    expect(encodeCollection(logical, {}).reference.tables.length).toBe(2);
    expect(() => encodeCollection(logical, { Game: [row([["id", "g1"]], {})] })).toThrow(LogicalCollectionError);
    await expect(loadCollection(logical, { ...encoded.reference, tables: encoded.reference.tables.slice(1) }, load)).rejects.toThrow("must name Game, List");
    await expect(loadCollection(logical, { ...encoded.reference, modelFingerprint: `sha256:${"1".repeat(64)}` }, load)).rejects.toThrow("modelFingerprint");
  });

  test("the fingerprint follows the model layer, not storage or presentation", () => {
    const restyled = source.replace("  lists       List[]    // cross-reference: declared below\n", "  lists       List[]\n  @table(\"games\")\n");
    expect(compileLogicalSchema(restyled).fingerprint).toBe(logical.fingerprint);
    expect(compileLogicalSchema(`${source}\nmodel Extra {\n  name Text\n}\n`).fingerprint).not.toBe(logical.fingerprint);
  });

  test("unique fields are unique", () => {
    const schema = compileLogicalSchema("main model Tag {\n  name unique Text\n}\n");
    const diagnostics = checkLogicalTables(schema, { Tag: [row([["id", "a"]], { name: "x" }), row([["id", "b"]], { name: "x" })] });
    expect(fields(diagnostics)).toEqual([["duplicate-value", "/fields/name"]]);
  });
});
