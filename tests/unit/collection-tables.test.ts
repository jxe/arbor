import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import {
  compileCollectionSchema,
  compileCollectionSchemas,
  deriveRowOperations,
  loadDirectoryCollection,
  replayCollectionRows,
} from "@ovst/collection-schema";
import { decodeProtocolDirectory, executeRowOperations, type ObjectHash, type RowOperation } from "@ovst/protocol";
import { mergeProtocolTrees } from "@ovst/tree-merge";
import { CollectionProjections } from "@ovst/story-sync/state";
import { compileUsl, type LogicalTables } from "@ovst/usl";
import { verifyStore } from "@ovst/usl/verify";

const SCHEMA = `model Game {
  name  Text
  tags  Text[]
  lists List[]
}

model List {
  name  Text
  games Game[]
}

ordered List.games[] <-> Game.lists[]
`;
const FILES = {
  "Game.jsonl": '{"id":"g1","name":"Chess","tags":["board"]}\n{"id":"g2","name":"Go"}\n',
  "List.jsonl": '{"id":"l1","name":"Favorites"}\n',
  "List_games.jsonl": '{"list":"l1","game":"g1","games_position":1}\n',
};
const NOW = "2026-10-24T09:00:00.000Z";
const key = (id: string) => JSON.stringify([["id", id]]);

let sandbox: string;
// realpath: on macOS tmpdir is under /var, a symlink, and snapshots read the resolved path.
beforeAll(async () => { sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-collection-tables-"))); });
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

/** Snapshot a tree whose `games` folder holds `schema.usl` and `files`, as Story Sync reads it. */
async function folder(name: string, files: Record<string, string>, schema = SCHEMA, projections = new CollectionProjections({ now: () => NOW })) {
  const root = join(sandbox, name);
  const directory = join(root, "games");
  await rm(root, { recursive: true, force: true });
  await Bun.write(join(directory, "schema.usl"), schema);
  for (const [file, text] of Object.entries(files)) await writeFile(join(directory, file), text);
  const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (dir, names) => projections.read(dir, names)));
  return { root: snapshot.root, objects: snapshot.objects, directory, projections };
}

const games = (objects: ReadonlyMap<ObjectHash, Uint8Array>, root: ObjectHash) => {
  const top = decodeProtocolDirectory(objects.get(root)!);
  return decodeProtocolDirectory(objects.get(top.entries.find((e) => e.name === "games")!.directory!)!);
};
const tables = async (objects: ReadonlyMap<ObjectHash, Uint8Array>, root: ObjectHash) =>
  (await loadDirectoryCollection(games(objects, root), async (hash) => objects.get(hash)!))?.tables ?? null;
const names = (rows: LogicalTables) => Object.fromEntries(Object.entries(rows).map(([model, list]) => [model, list.map((row) => ({ ...Object.fromEntries(row.key), ...row.fields }))]));

describe("a schema with several tables", () => {
  test("compiles to one schema per table, and only the single-table compile refuses it", () => {
    const set = compileCollectionSchemas(SCHEMA);
    expect(set.tables.map((t) => t.model)).toEqual(["Game", "List", "List_games"]);
    expect(set.tables[2]!.primaryKey).toEqual(["list", "game"]);
    expect(() => compileCollectionSchema(SCHEMA)).toThrow("one table");
  });

  test("Story Sync reads a <Table>.jsonl folder as one collection, the join table becoming the held connection", async () => {
    const snapshot = await folder("described", FILES);
    expect(games(snapshot.objects, snapshot.root).entries.map((e) => e.name)).toEqual(["schema.usl"]);
    expect(names((await tables(snapshot.objects, snapshot.root))!)).toEqual({
      Game: [{ id: "g1", name: "Chess", tags: ["board"] }, { id: "g2", name: "Go" }],
      List: [{ id: "l1", name: "Favorites", games: ["g1"] }],
    });
  });

  test("a missing table file holds no rows, and an invalid row leaves the folder ordinary files", async () => {
    const missing = await folder("missing", { "Game.jsonl": FILES["Game.jsonl"], "List.jsonl": FILES["List.jsonl"] });
    expect(names((await tables(missing.objects, missing.root))!).List).toEqual([{ id: "l1", name: "Favorites" }]);
    const invalid = await folder("invalid", { ...FILES, "List.jsonl": '{"id":"l1"}\n' });
    expect(games(invalid.objects, invalid.root).collection).toBeUndefined();
    expect(games(invalid.objects, invalid.root).entries.map((e) => e.name)).toContain("List.jsonl");
  });

  test("passes usl verify", async () => {
    const snapshot = await folder("verified", FILES);
    const diagnostics = await verifyStore(compileUsl(SCHEMA), snapshot.directory);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("the plan's games.usl with Game.jsonl, List.jsonl and List_games.jsonl passes usl verify", async () => {
    const games = (await readFile(join(import.meta.dir, "../../packages/usl/examples/games.usl"), "utf8"))
      .replace("ordered List.games[] @fold", "ordered List.games[]");
    const directory = join(sandbox, "games");
    await Bun.write(join(directory, "schema.usl"), games);
    await writeFile(join(directory, "Game.jsonl"), '{"id":"g1","name":"Chess","status":"Draft","tags":["board"],"authors":["tr_joe"]}\n');
    await writeFile(join(directory, "List.jsonl"), '{"id":"l1","name":"Favorites"}\n');
    await writeFile(join(directory, "List_games.jsonl"), '{"list":"l1","game":"g1","games_position":1}\n');
    const diagnostics = await verifyStore(compileUsl(games), directory);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("rows of several tables", () => {
  const collection = (root: ObjectHash) => ({ material: { kind: "basis" as const, path: "/games", object: gamesHash(root) } });
  let current: ReadonlyMap<ObjectHash, Uint8Array> = new Map();
  const gamesHash = (root: ObjectHash) => decodeProtocolDirectory(current.get(root)!).entries.find((e) => e.name === "games")!.directory!;

  test("operations replay into their tables, the projection writes only changed rows in the file's own shape, and reading it back derives the same operations", async () => {
    const snapshot = await folder("replay", FILES);
    current = snapshot.objects;
    const at = "2026-10-24T10:00:00.000Z";
    const operations: RowOperation[] = [
      { key: "a", kind: "set", collection: collection(snapshot.root), model: "Game", row: key("g2"), field: "name", before: "Go", value: "Weiqi", at },
      { key: "b", kind: "rowCreate", collection: collection(snapshot.root), model: "List", row: key("l2"), values: { id: "l2", name: "Later" }, at },
      { key: "c", kind: "disconnect", collection: collection(snapshot.root), model: "List", row: key("l1"), field: "games", member: "g1", at },
    ];
    const load = async (hash: ObjectHash) => objects.get(hash)!;
    const objects = new Map(snapshot.objects);
    const result = await executeRowOperations(snapshot.root, operations, load, replayCollectionRows);
    for (const [hash, bytes] of result.generated) objects.set(hash, bytes);
    expect(names((await tables(objects, result.root))!)).toEqual({
      Game: [{ id: "g1", name: "Chess", tags: ["board"] }, { id: "g2", name: "Weiqi" }],
      List: [{ id: "l1", name: "Favorites" }, { id: "l2", name: "Later" }],
    });

    await snapshot.projections.write(snapshot.directory, games(objects, result.root), load);
    const file = (name: string) => readFile(join(snapshot.directory, name), "utf8");
    expect(await file("Game.jsonl")).toBe('{"id":"g1","name":"Chess","tags":["board"]}\n{"id":"g2","name":"Weiqi"}\n');
    expect(await file("List.jsonl")).toBe('{"id":"l1","name":"Favorites"}\n{"id":"l2","name":"Later"}\n');
    expect(await file("List_games.jsonl")).toBe("");

    // The same projections read the written folder back as the replayed tree.
    const reread = await resolveSnapshot(await snapshotDirectory(join(sandbox, "replay"), new Map(), [], (dir, list) => snapshot.projections.read(dir, list)));
    expect(reread.root).toBe(result.root);
    const derived = await deriveRowOperations(snapshot.root, reread.root, async (hash) => objects.get(hash) ?? reread.objects.get(hash)!);
    expect(derived?.map((op) => [op.model, op.kind])).toEqual([["Game", "set"], ["List", "disconnect"], ["List", "rowCreate"]]);
  });

  test("an operation on a model the schema does not have is invalid", async () => {
    const snapshot = await folder("unknown-table", FILES);
    current = snapshot.objects;
    const op: RowOperation = { key: "a", kind: "rowDelete", collection: collection(snapshot.root), model: "Status", row: key("g1") };
    await expect(executeRowOperations(snapshot.root, [op], async (hash) => snapshot.objects.get(hash)!, replayCollectionRows)).rejects.toThrow();
  });

  test("concurrent edits to different models, and to different fields of one row, merge", async () => {
    const base = await folder("merge-base", FILES);
    const candidate = await folder("merge-candidate", { ...FILES, "Game.jsonl": '{"id":"g1","name":"Chess!","tags":["board"]}\n{"id":"g2","name":"Go"}\n' });
    const current = await folder("merge-current", {
      ...FILES,
      "Game.jsonl": '{"id":"g1","name":"Chess","tags":["board","classic"]}\n{"id":"g2","name":"Go"}\n',
      "List.jsonl": '{"id":"l1","name":"Best"}\n',
    });
    const objects = new Map([...base.objects, ...candidate.objects, ...current.objects]);
    const result = await mergeProtocolTrees(base.root, candidate.root, current.root, async (hash) => objects.get(hash)!);
    expect(result.conflicts).toEqual([]);
    expect(result.fields ?? []).toEqual([]);
    const merged = new Map([...objects, ...result.objects]);
    expect(names((await tables(merged, result.root))!)).toEqual({
      Game: [{ id: "g1", name: "Chess!", tags: ["board", "classic"] }, { id: "g2", name: "Go" }],
      List: [{ id: "l1", name: "Best", games: ["g1"] }],
    });
  });

  test("the same field set twice in one model is a field conflict naming that model", async () => {
    const base = await folder("conflict-base", FILES);
    const candidate = await folder("conflict-candidate", { ...FILES, "List.jsonl": '{"id":"l1","name":"Mine"}\n' });
    const current = await folder("conflict-current", { ...FILES, "List.jsonl": '{"id":"l1","name":"Theirs"}\n' });
    const objects = new Map([...base.objects, ...candidate.objects, ...current.objects]);
    const result = await mergeProtocolTrees(base.root, candidate.root, current.root, async (hash) => objects.get(hash)!);
    expect(result.fields).toEqual([expect.objectContaining({ path: "/games", table: "List", row: key("l1"), field: "name" })]);
  });
});
