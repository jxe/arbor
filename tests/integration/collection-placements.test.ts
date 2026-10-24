// Schema language 005 milestone 3, done when: one tree placed as SQLite and as
// JSONL holds the same root, and reformatting a CSV publishes nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { deriveRowOperations } from "@ovst/collection-schema";
import type { ObjectHash } from "@ovst/protocol";
import { CollectionProjections, type CollectionProjectionForm } from "@ovst/story-sync/state";
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
  return { root, items: join(root, "items"), scan };
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
    expect(operations).toEqual([expect.objectContaining({ kind: "rowSet", table: "Game", field: "name", before: "Go", value: "Weiqi", at: "2026-10-24T12:00:00.000Z" })]);

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
      .toEqual([expect.objectContaining({ kind: "rowSet", table: "Item", field: "title", before: "Apples", value: "Green apples" })]);
  });
});
