import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectionLogicalHash,
  decodeCollectionReference,
  decodeProtocolLog,
  encodeCanonicalCBOR,
  encodeProtocolLog,
  LtHash,
  rowHashElement,
  type Hash,
  type LogicalRow,
} from "@ovst/protocol";
import {
  appendRowChanges,
  changedCollectionRows,
  checkLogicalTables,
  compileLogicalSchema,
  EMPTY_COLLECTION_STATE,
  encodeCollection,
  encodedLogEntry,
  loadCollection,
  LogicalCollectionError,
  readSnapshotRows,
  useSnapshotDatabase,
  writeSnapshot,
} from "@ovst/collection-schema";
import { sqliteSnapshots } from "@ovst/beetle/sqlite";

useSnapshotDatabase(sqliteSnapshots);
import { compileUsl, layoutOf, logicalFromRows, logicalModels, rowsFromLogical, type LogicalTables } from "@ovst/usl";

const examples = join(import.meta.dir, "../../packages/usl/examples");
const schema = (name: string) => compileUsl(readFileSync(join(examples, `${name}.usl`), "utf8"));
const T = Date.parse("2026-10-24T09:00:00.000Z");
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

describe("the rows hash", () => {
  const rows = Array.from({ length: 50 }, (_, i) => row([["id", `r${i}`]], { n: i }));

  test("is the same for the same rows in any order, and a change takes out the old row and adds the new", () => {
    const forward = new LtHash(), backward = new LtHash();
    for (const r of rows) forward.add(rowHashElement("Item", r));
    for (const r of [...rows].reverse()) backward.add(rowHashElement("Item", r));
    expect(forward.hash()).toBe(backward.hash());
    const changed = { ...rows[7]!, fields: { n: -1 } };
    const edited = forward.clone().remove(rowHashElement("Item", rows[7]!)).add(rowHashElement("Item", changed));
    const fresh = new LtHash();
    for (const r of rows) fresh.add(rowHashElement("Item", r === rows[7] ? changed : r));
    expect(edited.hash()).toBe(fresh.hash());
    expect(edited.hash()).not.toBe(forward.hash());
    // The model is part of each row's element.
    expect(new LtHash().add(rowHashElement("Item", rows[0]!)).hash()).not.toBe(new LtHash().add(rowHashElement("Other", rows[0]!)).hash());
    expect(LtHash.fromBytes(forward.bytes()).hash()).toBe(forward.hash());
  });
});

describe("log objects", () => {
  const schema = compileLogicalSchema("main table Item:\n  n Int\n");
  const item = (id: string, n: number) => row([["id", id]], { n });

  test("an entry is decoded strictly: changes in order, each row once, its key its row's", () => {
    const first = appendRowChanges(schema, EMPTY_COLLECTION_STATE, [{ model: "Item", key: [["id", "a"]], row: item("a", 1) }]);
    const entry = decodeProtocolLog(first.bytes);
    expect(entry).toMatchObject({ type: "log", previous: null, rows: 1 });
    const head = { type: "log" as const, previous: null, rows: 2, rowsHash: entry.rowsHash };
    expect(() => decodeProtocolLog(encodeCanonicalCBOR({ ...head, changes: [
      { model: "Item", key: [["id", "b"]], row: item("b", 1) },
      { model: "Item", key: [["id", "a"]], row: item("a", 1) },
    ] }))).toThrow("order");
    expect(() => decodeProtocolLog(encodeCanonicalCBOR({ ...head, changes: [{ model: "Item", key: [["id", "b"]], row: item("a", 1) }] }))).toThrow("its row's key");
    expect(() => decodeProtocolLog(encodeCanonicalCBOR({ ...head, changes: [], extra: 1 }))).toThrow("exactly");
    // The encoder sorts changes.
    const sorted = encodeProtocolLog({ ...head, changes: [{ model: "Item", key: [["id", "b"]], row: null }, { model: "Item", key: [["id", "a"]], row: null }] });
    const decoded = decodeProtocolLog(sorted);
    expect(("changes" in decoded ? decoded.changes : []).map((c) => c.key[0]![1])).toEqual(["a", "b"]);
  });

  test("loading checks each entry's count and rows hash, and that it follows the one before", async () => {
    const objects = new Map<Hash, Uint8Array>();
    const first = appendRowChanges(schema, EMPTY_COLLECTION_STATE, [{ model: "Item", key: [["id", "a"]], row: item("a", 1) }]);
    objects.set(first.hash, first.bytes);
    const reference = (log: Hash) => ({ version: 2, modelFingerprint: schema.fingerprint, log });
    const lying = encodedLogEntry({ type: "log", previous: first.hash, rows: 5, rowsHash: decodeProtocolLog(first.bytes).rowsHash, changes: [{ model: "Item", key: [["id", "b"]], row: item("b", 2) }] });
    objects.set(lying.hash, lying.bytes);
    await expect(loadCollection(schema, reference(lying.hash), async (h) => objects.get(h)!)).rejects.toThrow("count and rows hash");
    const removesAbsent = encodedLogEntry({ type: "log", previous: first.hash, rows: 1, rowsHash: decodeProtocolLog(first.bytes).rowsHash, changes: [{ model: "Item", key: [["id", "z"]], row: null }] });
    objects.set(removesAbsent.hash, removesAbsent.bytes);
    await expect(loadCollection(schema, reference(removesAbsent.hash), async (h) => objects.get(h)!)).rejects.toThrow("isn't there");
  });

  test("a snapshot holds the rows its entry says, and a log continues from it", async () => {
    const tables = { Item: [item("a", 1), item("b", 2)] };
    const snapshot = writeSnapshot(schema, tables);
    expect(readSnapshotRows(schema, snapshot)).toEqual(tables);
    const state = encodeCollection(schema, tables).state;
    const file = `sha256:${new Bun.CryptoHasher("sha256").update(snapshot).digest("hex")}` as Hash;
    const entry = encodedLogEntry({ type: "log", previous: `sha256:${"9".repeat(64)}` as Hash, rows: 2, rowsHash: state.lthash.hash(), snapshot: file });
    const objects = new Map<Hash, Uint8Array>([[file, snapshot], [entry.hash, entry.bytes]]);
    const next = appendRowChanges(schema, { ...state, head: entry.hash }, [{ model: "Item", key: [["id", "c"]], row: item("c", 3) }]);
    objects.set(next.hash, next.bytes);
    const loaded = await loadCollection(schema, { version: 2, modelFingerprint: schema.fingerprint, log: next.hash }, async (h) => objects.get(h)!);
    expect(loaded.tables.Item!.map((r) => r.key[0]![1])).toEqual(["a", "b", "c"]);
    // A snapshot of other rows is refused.
    const wrong = encodedLogEntry({ type: "log", previous: null, rows: 2, rowsHash: new LtHash().hash(), snapshot: file });
    objects.set(wrong.hash, wrong.bytes);
    await expect(loadCollection(schema, { version: 2, modelFingerprint: schema.fingerprint, log: wrong.hash }, async (h) => objects.get(h)!)).rejects.toThrow("snapshot");
  });

  test("the reference is decoded strictly, and the logical hash is of the fingerprint and rows hash", () => {
    const fingerprint = `sha256:${"0".repeat(64)}` as Hash;
    const reference = decodeCollectionReference({ version: 2, modelFingerprint: fingerprint, log: fingerprint });
    expect(() => decodeCollectionReference({ ...reference, extra: 1 })).toThrow("exactly");
    expect(() => decodeCollectionReference({ ...reference, version: 1 })).toThrow("version");
    expect(collectionLogicalHash(fingerprint, new LtHash().hash())).toMatch(/^sha256:/);
  });
});

describe("collections", () => {
  // packages/usl/examples/games.usl, as schema.beetle.
  const source = readFileSync(join(import.meta.dir, "../fixtures/games.beetle"), "utf8");
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

  test("encode and load a collection; the logical hash is of the rows alone, and appending writes one entry", async () => {
    const encoded = encodeCollection(logical, tables);
    expect(encoded.reference.modelFingerprint).toBe(logical.fingerprint);
    expect(encodeCollection(logical, { List: tables.List!, Game: [...tables.Game!].reverse() }).logicalHash).toBe(encoded.logicalHash);
    const objects = new Map(encoded.objects);
    const load = async (h: Hash) => objects.get(h)!;
    const loaded = await loadCollection(logical, encoded.reference, load);
    expect(loaded.logicalHash).toBe(encoded.logicalHash);
    expect(loaded.tables.Game!.map((r) => r.key[0]![1])).toEqual(["g1", "g2"]);
    expect(decodeProtocolLog(encodeCollection(logical, {}).objects.values().next().value!)).toMatchObject({ previous: null, rows: 0, changes: [] });
    expect(() => encodeCollection(logical, { Game: [row([["id", "g1"]], {})] })).toThrow(LogicalCollectionError);
    await expect(loadCollection(logical, { ...encoded.reference, modelFingerprint: `sha256:${"1".repeat(64)}` }, load)).rejects.toThrow("modelFingerprint");
    // An edit appends one entry with only the changed row; the same rows reached another way hash the same.
    const edited = { ...tables, Game: [tables.Game![0]!, row([["id", "g1"]], { name: "Chess", status: "Polished", tags: ["board", "classic"] })] };
    const next = encodeCollection(logical, edited, loaded.state);
    expect(next.objects.size).toBe(1);
    const entry = decodeProtocolLog(next.objects.values().next().value!);
    expect(entry.previous).toBe(encoded.reference.log);
    expect("changes" in entry && entry.changes.map((c) => c.key[0]![1])).toEqual(["g1"]);
    expect(encodeCollection(logical, edited).logicalHash).toBe(next.logicalHash);
    for (const [h, bytes] of next.objects) objects.set(h, bytes);
    const changed = await changedCollectionRows(logical, encoded.reference, next.reference, load);
    expect(Object.keys(changed)).toEqual(["Game"]);
    expect(changed.Game!.after.map((r) => r.fields.status)).toEqual(["Polished"]);
    // No change writes no entry.
    expect(encodeCollection(logical, edited, next.state).objects.size).toBe(0);
  });

  test("the fingerprint follows the model layer, not storage or presentation", () => {
    const restyled = source.replace("  lists       List[]  // cross-reference: declared below\n", "  lists       List[]\n  @table(\"games\")\n");
    expect(compileLogicalSchema(restyled).fingerprint).toBe(logical.fingerprint);
    expect(compileLogicalSchema(`${source}\ntable Extra:\n  name Text\n`).fingerprint).not.toBe(logical.fingerprint);
  });

  test("unique fields are unique", () => {
    const schema = compileLogicalSchema("main table Tag:\n  name unique Text\n");
    const diagnostics = checkLogicalTables(schema, { Tag: [row([["id", "a"]], { name: "x" }), row([["id", "b"]], { name: "x" })] });
    expect(fields(diagnostics)).toEqual([["duplicate-value", "/fields/name"]]);
  });
});
