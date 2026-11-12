// Schema language 005 milestone 3, done when: one tree placed as SQLite and as
// JSONL holds the same root, and reformatting a CSV publishes nothing. And
// milestone 4's games example, at the end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { deriveRowOperations, loadDirectoryCollection, snapshotEntry, useSnapshotDatabase } from "@ovst/collection-schema";
import { sqliteSnapshots } from "@ovst/beetle/sqlite";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type ObjectHash } from "@ovst/protocol";
import { CollectionProjections, type CollectionProjectionForm } from "@ovst/story-sync/state";
import { layoutOf } from "@ovst/usl";
import { compileSchema } from "@ovst/beetle";
import { verifyStore } from "@ovst/usl/verify";
import { collectionBasis, collectionTree, idRow, T0 } from "../support/collection-trees.ts";
const TEST_AT = Date.UTC(2026, 10, 11);

const GAMES = `main table Game:
  name  Text
  year  Int?
  done  Bool?
  tags  Text[]
  lists List[]

table List:
  name  Text
  games Game[]

ordered List.games[] <-> Game.lists[]
`;
const ITEMS = "main table Item:\n  title Text\n  count Int\n  done  Bool?\n  note  Text?\n";

useSnapshotDatabase(sqliteSnapshots);
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
    expect((await readdir(sqlite.items)).sort()).toEqual(["_store.sqlite3", "schema.beetle"]);
    expect((await readdir(jsonl.items)).sort()).toEqual(["Game.jsonl", "List.jsonl", "List_games.jsonl", "schema.beetle"]);
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
    const operations = (await deriveRowOperations(tree.root, edited.root, async (hash) => objects.get(hash)!, TEST_AT))?.operations;
    expect(operations).toEqual([expect.objectContaining({ kind: "set", model: "Game", field: "name", before: "Go", value: "Weiqi", at: "2026-10-24T12:00:00.000Z" })]);

    // The JSONL placement takes the accepted tree, changing one line.
    const before = await readFile(join(jsonl.items, "Game.jsonl"), "utf8");
    const accepted = { root: edited.root, objects };
    const projections = new CollectionProjections({ basis: () => collectionBasis(tree.root, tree.objects) });
    await materializeTree(jsonl.root, accepted.root, async (hash) => objects.get(hash)!, undefined, [], undefined, (directory, object, read) => projections.write(directory, object, read));
    const after = await readFile(join(jsonl.items, "Game.jsonl"), "utf8");
    expect(after.split("\n")[0]).toBe(before.split("\n")[0]);
    expect(after.split("\n")[1]).toContain('"name":"Weiqi"');
    const reread = resolveSnapshot(await snapshotDirectory(jsonl.root, new Map(), [], (directory, names) => projections.read(directory, names)));
    expect((await reread).root).toBe(edited.root);
  });
});

describe("a SQLite placement's base", () => {
  const tree = collectionTree(GAMES, {
    Game: [idRow("g1", { name: "Chess", tags: ["board"] }), idRow("g2", { name: "Go", tags: ["board"] }), idRow("g3", { name: "Hex", tags: ["board"] })],
    List: [idRow("l1", { name: "Favorites", games: ["g1", "g2"] })],
  });
  const ownTables = (path: string) => {
    const database = new Database(path, { readonly: true });
    try { return database.query("select name from sqlite_master where name like '\\_%' escape '\\'").all(); } finally { database.close(); }
  };
  /** The folder read whole by a projection that has never seen it and keeps no base. */
  const fresh = async (root: string) =>
    (await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (directory, names) =>
      new CollectionProjections({ basis: () => collectionBasis(tree.root, tree.objects), now: () => "2026-10-24T12:00:00.000Z", baseDirectory: join(sandbox, "no-bases") }).read(directory, names)))).root;

  test("Story Sync adds nothing to the database, and usl verify accepts it", async () => {
    const placed = await place("sqlite-base", tree, { kind: "sqlite" });
    const path = join(placed.items, "_store.sqlite3");
    expect(ownTables(path)).toEqual([]);
    expect(await verifyStore(compileSchema(GAMES), path)).toEqual([]);
    expect((await placed.scan()).root).toBe(tree.root);
  });

  test("another program's inserts, updates and deletes are found against the base, and reach the same root as a whole read", async () => {
    const placed = await place("sqlite-base-edits", tree, { kind: "sqlite" });
    const path = join(placed.items, "_store.sqlite3");
    expect((await placed.scan()).root).toBe(tree.root);
    const database = new Database(path);
    database.query("update Game set name = 'Weiqi' where id = 'g2'").run();
    database.query(`insert into Game (id, name, tags, created, modified) values ('g4', 'Shogi', '["board"]', '2026-10-24T12:00:00.000Z', '2026-10-24T12:00:00.000Z')`).run();
    database.query("delete from List_games where list = 'l1' and game = 'g1'").run();
    database.query("delete from Game where id = 'g3'").run();
    database.close();
    const scanned = (await placed.scan()).root;
    expect(scanned).not.toBe(tree.root);
    expect(scanned).toBe(await fresh(placed.root));
    // A new instance, as after a restart, reads the base file and finds the same edits.
    const restarted = new CollectionProjections({ basis: () => collectionBasis(tree.root, tree.objects), now: () => "2026-10-24T12:00:00.000Z" });
    expect((await resolveSnapshot(await snapshotDirectory(placed.root, new Map(), [], (directory, names) => restarted.read(directory, names)))).root).toBe(scanned);
  });

  test("an edit another program makes between a scan and an accepted write is kept, and reads as a local change", async () => {
    const placed = await place("sqlite-base-race", tree, { kind: "sqlite" });
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
    expect((await deriveRowOperations(accepted.root, scanned.root, async (hash) => objects.get(hash)!, TEST_AT))?.operations)
      .toEqual([expect.objectContaining({ kind: "set", model: "Game", field: "name", before: "Baduk", value: "Weiqi" })]);
  });

  test("a new database starts as the host's snapshot file", async () => {
    const objects = new Map(tree.objects);
    const items = decodeProtocolDirectory(objects.get(tree.collection)!);
    const collection = (await loadDirectoryCollection(items, async (hash) => objects.get(hash)!))!;
    const snapshot = snapshotEntry(collection.schema, collection.state);
    objects.set(snapshot.hash as ObjectHash, snapshot.bytes);
    objects.set(snapshot.file.hash as ObjectHash, snapshot.file.bytes);
    const folder = encodeProtocolDirectory({ ...items, collection: { ...items.collection!, log: snapshot.hash } });
    objects.set(hashObject(folder), folder);
    const top = decodeProtocolDirectory(objects.get(tree.root)!);
    const root = encodeProtocolDirectory({ ...top, entries: top.entries.map((e) => (e.name === "items" ? { name: "items", directory: hashObject(folder) } : e)) });
    objects.set(hashObject(root), root);
    const placed = await place("sqlite-from-snapshot", { root: hashObject(root), objects }, { kind: "sqlite" });
    expect(new Uint8Array(await readFile(join(placed.items, "_store.sqlite3")))).toEqual(new Uint8Array(snapshot.file.bytes));
    expect((await placed.scan()).root).toBe(hashObject(root));
  });

  test("an earlier Story Sync's change log is dropped by the next write", async () => {
    const placed = await place("sqlite-base-legacy", tree, { kind: "sqlite" });
    const path = join(placed.items, "_store.sqlite3");
    const database = new Database(path);
    database.exec("create table _overstory_changes (id integer primary key, model text, key text)");
    database.exec("create trigger _overstory_Game_update after update on Game begin insert into _overstory_changes (model, key) values ('Game', new.id); end");
    database.close();
    const accepted = collectionTree(GAMES, {
      Game: [idRow("g1", { name: "Chess", tags: ["board"] }), idRow("g2", { name: "Go", tags: ["board"] })],
      List: [idRow("l1", { name: "Favorites", games: ["g1", "g2"] })],
    });
    await materializeTree(placed.root, accepted.root, async (hash) => accepted.objects.get(hash)!, undefined, [], undefined,
      (directory, object, read) => placed.projections.write(directory, object, read));
    expect(ownTables(path)).toEqual([]);
    expect((await placed.scan()).root).toBe(accepted.root);
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
    expect((await deriveRowOperations(tree.root, edited.root, async (hash) => objects.get(hash)!, TEST_AT))?.operations)
      .toEqual([expect.objectContaining({ kind: "set", model: "Item", field: "title", before: "Apples", value: "Green apples" })]);
  });
});

// Schema language 005 milestone 4, done when: a games collection projected
// as files holds one <Table>.jsonl per table of its file layout and passes
// `usl verify`.
describe("the games example placed as files", () => {
  test("holds one <Table>.jsonl per table of its file layout, which usl verify accepts", async () => {
    const source = await readFile(join(import.meta.dir, "../fixtures/games.beetle"), "utf8");
    const tree = collectionTree(source, {
      Game: [
        idRow("g1", { name: "Chess", status: "Polished", tags: ["board", "classic"], authors: ["tr_ada"] }),
        idRow("g2", { name: "Go", status: "Draft", description: "Black and **white**.\n" }),
      ],
      List: [idRow("l1", { name: "Favorites", games: ["g1"] })],
    });
    const placed = await place("games-files", tree, { kind: "files", format: "jsonl" });
    const schema = compileSchema(source);
    const files = layoutOf(schema, { store: "files" }).map((table) => `${table.name}.jsonl`);
    expect((await readdir(placed.items)).sort()).toEqual([...files, "schema.beetle"].sort());
    expect(await verifyStore(schema, placed.items)).toEqual([]);
    expect((await placed.scan()).root).toBe(tree.root);
  });
});
