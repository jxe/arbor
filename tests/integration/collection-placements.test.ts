// Schema language 005 milestone 3, done when: one tree placed as SQLite and as
// JSONL holds the same root, and reformatting a CSV publishes nothing. And
// milestone 4's games example, at the end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { deriveRowOperations } from "@ovst/collection-schema";
import type { ObjectHash } from "@ovst/protocol";
import { CollectionProjections, type CollectionProjectionForm } from "@ovst/story-sync/state";
import { compileUsl, layoutOf } from "@ovst/usl";
import { verifyStore } from "@ovst/usl/verify";
import { collectionRows, collectionTree, idRow, T0 } from "../support/collection-trees.ts";

const GAMES = `main model Game {
  name  Text
  year  Int?
  done  Bool?
  tags  Text[]
  lists List[]
}

model List {
  name  Text
  games Game[]
}

ordered List.games[] <-> Game.lists[]
`;
const ITEMS = "main model Item {\n  title Text\n  count Int\n  done  Bool?\n  note  Text?\n}\n";

let sandbox: string;
beforeAll(async () => { sandbox = await mkdtemp(join(tmpdir(), "story-collection-placements-")); });
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

/** A placement of a tree in its own folder, projecting its collections in `form`. */
async function place(name: string, tree: { root: ObjectHash; objects: Map<ObjectHash, Uint8Array> }, form: CollectionProjectionForm) {
  const root = join(sandbox, name);
  const projections = new CollectionProjections({ form: () => form, now: () => "2026-10-24T12:00:00.000Z" });
  const load = async (hash: ObjectHash) => tree.objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
  await materializeTree(root, tree.root, load, undefined, [], undefined, (directory, object, read) => projections.write(directory, object, read));
  const scan = async () => resolveSnapshot(await snapshotDirectory(root, new Map(), [], (directory, names) => projections.read(directory, names)));
  return { root, items: join(root, "items"), scan, projections, };
}

describe("one tree, placed with different projections", () => {
  const tree = collectionTree(GAMES, {
    Game: [idRow("g1", { name: "Chess", year: 1475, done: true, tags: ["board", "classic"] }), idRow("g2", { name: "Go", tags: ["board"] }, T0, "2026-10-24T10:00:00.000Z")],
    List: [idRow("l1", { name: "Favorites", games: ["g1"] })],
  });

  test("SQLite and JSONL placements hold the same root as the tree", async () => {
    const sqlite = await place("sqlite", tree, { kind: "sqlite" });
    const jsonl = await place("jsonl", tree, { kind: "files", format: "jsonl" });
    expect((await readdir(sqlite.items)).sort()).toEqual(["_store.sqlite3", "schema.usl"]);
    expect((await readdir(jsonl.items)).sort()).toEqual(["Game.jsonl", "List.jsonl", "List_games.jsonl", "schema.usl"]);
    expect((await sqlite.scan()).root).toBe(tree.root);
    expect((await jsonl.scan()).root).toBe(tree.root);
  });

  test("an edit in the SQLite placement is row operations, and the JSONL placement reaches the same root", async () => {
    const sqlite = await place("sqlite-edit", tree, { kind: "sqlite" });
    const jsonl = await place("jsonl-edit", tree, { kind: "files", format: "jsonl" });
    const database = new Database(join(sqlite.items, "_store.sqlite3"));
    database.query("update Game set name = 'Weiqi' where id = 'g2'").run();
    database.close();
    const edited = await sqlite.scan();
    const objects = new Map([...tree.objects, ...edited.objects]);
    const operations = await deriveRowOperations(tree.root, edited.root, async (hash) => objects.get(hash)!);
    expect(operations).toEqual([expect.objectContaining({ kind: "rowSet", model: "Game", field: "name", before: "Go", value: "Weiqi", at: "2026-10-24T12:00:00.000Z" })]);

    // The JSONL placement takes the accepted tree, changing one line.
    const before = await readFile(join(jsonl.items, "Game.jsonl"), "utf8");
    const accepted = { root: edited.root, objects };
    const projections = new CollectionProjections({ basis: async () => (await collectionRows(tree.root, tree.objects)) });
    await materializeTree(jsonl.root, accepted.root, async (hash) => objects.get(hash)!, undefined, [], undefined, (directory, object, read) => projections.write(directory, object, read));
    const after = await readFile(join(jsonl.items, "Game.jsonl"), "utf8");
    expect(after.split("\n")[0]).toBe(before.split("\n")[0]);
    expect(after.split("\n")[1]).toContain('"name":"Weiqi"');
    const reread = resolveSnapshot(await snapshotDirectory(jsonl.root, new Map(), [], (directory, names) => projections.read(directory, names)));
    expect((await reread).root).toBe(edited.root);
  });
});

describe("a SQLite placement's change log", () => {
  const tree = collectionTree(GAMES, {
    Game: [idRow("g1", { name: "Chess", tags: ["board"] }), idRow("g2", { name: "Go", tags: ["board"] }), idRow("g3", { name: "Hex", tags: ["board"] })],
    List: [idRow("l1", { name: "Favorites", games: ["g1", "g2"] })],
  });
  const changes = (path: string) => {
    const database = new Database(path, { readonly: true });
    try { return database.query("select model, key from _overstory_changes order by id").all(); } finally { database.close(); }
  };
  /** The folder read whole by a projection that has never seen it. */
  const fresh = async (root: string) =>
    (await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (directory, names) =>
      new CollectionProjections({ basis: async () => collectionRows(tree.root, tree.objects), now: () => "2026-10-24T12:00:00.000Z" }).read(directory, names)))).root;

  test("Story Sync's own writes leave nothing to read back, and usl verify ignores the log", async () => {
    const placed = await place("sqlite-log", tree, { kind: "sqlite" });
    const path = join(placed.items, "_store.sqlite3");
    expect(changes(path)).toEqual([]);
    expect(await verifyStore(compileUsl(GAMES), path)).toEqual([]);
    expect((await placed.scan()).root).toBe(tree.root);
  });

  test("another program's inserts, updates and deletes are logged, and a scan of only those rows reaches the same root as a whole read", async () => {
    const placed = await place("sqlite-log-edits", tree, { kind: "sqlite" });
    const path = join(placed.items, "_store.sqlite3");
    expect((await placed.scan()).root).toBe(tree.root);
    const database = new Database(path);
    database.query("update Game set name = 'Weiqi' where id = 'g2'").run();
    database.query(`insert into Game (id, name, tags, created, modified) values ('g4', 'Shogi', '["board"]', '2026-10-24T12:00:00.000Z', '2026-10-24T12:00:00.000Z')`).run();
    database.query("delete from List_games where list = 'l1' and game = 'g1'").run();
    database.query("delete from Game where id = 'g3'").run();
    database.close();
    expect(changes(path)).toEqual([
      { model: "Game", key: '["g2"]' }, { model: "Game", key: '["g2"]' },
      { model: "Game", key: '["g4"]' },
      { model: "List_games", key: '["l1","g1"]' },
      { model: "Game", key: '["g3"]' },
    ]);
    const scanned = (await placed.scan()).root;
    expect(scanned).not.toBe(tree.root);
    expect(scanned).toBe(await fresh(placed.root));
  });

  test("an edit another program makes between a scan and an accepted write is kept, and reads as a local change", async () => {
    const placed = await place("sqlite-log-race", tree, { kind: "sqlite" });
    const path = join(placed.items, "_store.sqlite3");
    expect((await placed.scan()).root).toBe(tree.root);
    const database = new Database(path);
    database.query("update Game set name = 'Weiqi' where id = 'g2'").run();
    database.close();
    // The host accepted another device's edits to g2 and g3 meanwhile.
    const accepted = collectionTree(GAMES, {
      Game: [idRow("g1", { name: "Chess", tags: ["board"] }), idRow("g2", { name: "Baduk", tags: ["board"] }, T0, "2026-10-24T11:00:00.000Z"),
        idRow("g3", { name: "Havannah", tags: ["board"] }, T0, "2026-10-24T11:00:00.000Z")],
      List: [idRow("l1", { name: "Favorites", games: ["g1", "g2"] })],
    });
    await materializeTree(placed.root, accepted.root, async (hash) => accepted.objects.get(hash)!, undefined, [], undefined,
      (directory, object, read) => placed.projections.write(directory, object, read));
    const names = () => {
      const reader = new Database(path, { readonly: true });
      try { return reader.query("select id, name from Game order by id").all(); } finally { reader.close(); }
    };
    expect(names()).toEqual([{ id: "g1", name: "Chess" }, { id: "g2", name: "Weiqi" }, { id: "g3", name: "Havannah" }]);
    const scanned = await placed.scan();
    const objects = new Map([...accepted.objects, ...scanned.objects]);
    expect(await deriveRowOperations(accepted.root, scanned.root, async (hash) => objects.get(hash)!))
      .toEqual([expect.objectContaining({ kind: "rowSet", model: "Game", field: "name", before: "Baduk", value: "Weiqi" })]);
  });

  test("a database whose log lost a trigger is read whole, and gets its log back", async () => {
    const placed = await place("sqlite-log-dropped", tree, { kind: "sqlite" });
    const path = join(placed.items, "_store.sqlite3");
    expect((await placed.scan()).root).toBe(tree.root);
    const database = new Database(path);
    database.exec('drop trigger "_overstory_Game_update"');
    database.query("update Game set name = 'Weiqi' where id = 'g2'").run();
    database.close();
    expect(changes(path)).toEqual([]);
    const scanned = (await placed.scan()).root;
    expect(scanned).toBe(await fresh(placed.root));
    expect(scanned).not.toBe(tree.root);
    const again = new Database(path);
    again.query("update Game set name = 'Go' where id = 'g2'").run();
    again.close();
    expect(changes(path)).toEqual([{ model: "Game", key: '["g2"]' }, { model: "Game", key: '["g2"]' }]);
  });
});

describe("a CSV placement", () => {
  const tree = collectionTree(ITEMS, {
    Item: [idRow("a", { title: "Apples", count: 3, done: true }), idRow("b", { title: "Pears, ripe", count: 0, note: "x" })],
  });

  test("reformatting the CSV publishes nothing", async () => {
    const csv = await place("csv", tree, { kind: "files", format: "csv" });
    const path = join(csv.items, "_store.csv");
    expect((await csv.scan()).root).toBe(tree.root);
    const reformats = [
      // Columns reordered, every cell quoted, CRLF line ends.
      '"note","done","count","title","id"\r\n"","true","3","Apples","a"\r\n"x","","0","Pears, ripe","b"\r\n',
      // Rows reordered, no trailing newline.
      'id,title,count,done,note\nb,"Pears, ripe",0,,x\na,Apples,3,true,',
    ];
    for (const text of reformats) {
      await writeFile(path, text);
      expect((await csv.scan()).root).toBe(tree.root);
    }
  });

  test("a CSV cell edit is one row operation", async () => {
    const csv = await place("csv-edit", tree, { kind: "files", format: "csv" });
    const path = join(csv.items, "_store.csv");
    await writeFile(path, (await readFile(path, "utf8")).replace("Apples", "Green apples"));
    const edited = await csv.scan();
    const objects = new Map([...tree.objects, ...edited.objects]);
    expect(await deriveRowOperations(tree.root, edited.root, async (hash) => objects.get(hash)!))
      .toEqual([expect.objectContaining({ kind: "rowSet", model: "Item", field: "title", before: "Apples", value: "Green apples" })]);
  });
});

// Schema language 005 milestone 4, done when: a games.usl collection projected
// as files holds one <Table>.jsonl per table of its file layout and passes
// `usl verify`.
describe("the games example placed as files", () => {
  test("holds one <Table>.jsonl per table of its file layout, which usl verify accepts", async () => {
    const source = await readFile(join(import.meta.dir, "../../packages/usl/examples/games.usl"), "utf8");
    const tree = collectionTree(source, {
      Game: [
        idRow("g1", { name: "Chess", status: "Polished", tags: ["board", "classic"], authors: ["tr_ada"] }),
        idRow("g2", { name: "Go", status: "Draft", description: "Black and **white**.\n" }),
      ],
      List: [idRow("l1", { name: "Favorites", games: ["g1"] })],
    });
    const placed = await place("games-files", tree, { kind: "files", format: "jsonl" });
    const schema = compileUsl(source);
    const files = layoutOf(schema, { store: "files" }).map((table) => `${table.name}.jsonl`);
    expect((await readdir(placed.items)).sort()).toEqual([...files, "schema.usl"].sort());
    expect(await verifyStore(schema, placed.items)).toEqual([]);
    expect((await placed.scan()).root).toBe(tree.root);
  });
});
