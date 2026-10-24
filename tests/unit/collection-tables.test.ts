import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import {
  collectionFileRows,
  compileCollectionSchema,
  compileCollectionSchemas,
  decodeProtocolCollectionTables,
  deriveRowOperations,
  replayCollectionRows,
} from "@ovst/collection-schema";
import {
  decodeChildrenSourceDescriptor,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  executeRowOperations,
  hashObject,
  type CollectionTablesDescriptor,
  type ObjectHash,
  type RowOperation,
} from "@ovst/protocol";
import { mergeProtocolTrees } from "@ovst/tree-merge";
import { ProjectionProviderHost } from "@ovst/story-sync/state";
import { compileUsl } from "@ovst/usl";
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
const HASH = `sha256:${"1".repeat(64)}`;
const key = (id: string) => JSON.stringify([["id", id]]);

let sandbox: string;
beforeAll(async () => { sandbox = await mkdtemp(join(tmpdir(), "story-collection-tables-")); });
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

/** Snapshot a folder holding `schema.usl` and `files`, as Story Sync describes it. */
async function folder(name: string, files: Record<string, string>, schema = SCHEMA) {
  const directory = join(sandbox, name);
  await rm(directory, { recursive: true, force: true });
  await Bun.write(join(directory, "schema.usl"), schema);
  for (const [file, text] of Object.entries(files)) await writeFile(join(directory, file), text);
  const stores = new ProjectionProviderHost();
  try {
    const snapshot = await resolveSnapshot(await snapshotDirectory(directory, new Map(), [], (dir, names) => stores.collectionDescriptor(dir, names)));
    return { directory, ...snapshot };
  } finally { await stores[Symbol.asyncDispose](); }
}

const text = (objects: ReadonlyMap<ObjectHash, Uint8Array>, root: ObjectHash, name: string) => {
  const directory = decodeProtocolDirectory(objects.get(root)!);
  return new TextDecoder().decode(objects.get(directory.entries.find((e) => e.name === name)!.file!)!);
};

describe("multi-table collection descriptor", () => {
  const valid = {
    version: 1, type: "collection-tables", format: "jsonl", schemaSource: "schema.usl", schemaFingerprint: HASH,
    tables: [{ table: "Game", source: "Game.jsonl", childSetHash: HASH }, { table: "List", source: "List.jsonl", childSetHash: HASH }],
  };

  test("decodes strictly", () => {
    expect(decodeChildrenSourceDescriptor(valid)).toEqual(valid as CollectionTablesDescriptor);
    const invalid: Array<[string, unknown]> = [
      ["unsorted tables", { ...valid, tables: [...valid.tables].reverse() }],
      ["a repeated table", { ...valid, tables: [valid.tables[0], valid.tables[0]] }],
      ["no tables", { ...valid, tables: [] }],
      ["a source in another format", { ...valid, tables: [{ ...valid.tables[0], source: "Game.csv" }] }],
      ["a source for another table", { ...valid, tables: [{ ...valid.tables[0], source: "List.jsonl" }] }],
      ["a table name that is not a name", { ...valid, tables: [{ table: "_store", source: "_store.jsonl", childSetHash: HASH }] }],
      ["an unknown member", { ...valid, extra: 1 }],
      ["an unknown table member", { ...valid, tables: [{ ...valid.tables[0], extra: 1 }] }],
      ["a bad hash", { ...valid, tables: [{ ...valid.tables[0], childSetHash: "sha256:00" }] }],
    ];
    for (const [label, value] of invalid) expect(() => decodeChildrenSourceDescriptor(value), label).toThrow();
  });

  test("a directory names exactly its table files, the schema and a body", () => {
    const file = (body: string) => hashObject(new TextEncoder().encode(body));
    const entries = [
      { name: "Game.jsonl", file: file("g") },
      { name: "List.jsonl", file: file("l") },
      { name: "schema.usl", file: file("s") },
    ];
    const directory = { type: "directory" as const, entries, childrenSource: valid as CollectionTablesDescriptor };
    expect(decodeProtocolDirectory(encodeProtocolDirectory(directory)).childrenSource).toEqual(valid as CollectionTablesDescriptor);
    expect(() => encodeProtocolDirectory({ ...directory, entries: entries.filter((e) => e.name !== "List.jsonl") })).toThrow("ordinary file entries");
    expect(() => encodeProtocolDirectory({ ...directory, entries: [...entries.slice(0, 2), { name: "notes.md", file: file("n") }, entries[2]!] })).toThrow("mixes");
  });
});

describe("a schema with several tables", () => {
  test("compiles to one schema per table, and only the single-table compile refuses it", () => {
    const set = compileCollectionSchemas(SCHEMA);
    expect(set.tables.map((t) => t.model)).toEqual(["Game", "List", "List_games"]);
    expect(set.tables[2]!.primaryKey).toEqual(["list", "game"]);
    expect(() => compileCollectionSchema(SCHEMA)).toThrow("one table");
  });

  test("Story Sync describes a <Table>.jsonl folder, and the rows validate", async () => {
    const snapshot = await folder("described", FILES);
    const descriptor = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!).childrenSource!;
    expect(descriptor).toMatchObject({ type: "collection-tables", format: "jsonl", tables: [
      { table: "Game", source: "Game.jsonl" }, { table: "List", source: "List.jsonl" }, { table: "List_games", source: "List_games.jsonl" },
    ] });
    const directory = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
    const bytes = (name: string) => snapshot.objects.get(directory.entries.find((e) => e.name === name)!.file!)!;
    const tables = decodeProtocolCollectionTables(descriptor, bytes, bytes("schema.usl"));
    expect(tables.map((t) => [t.table, t.rows.length])).toEqual([["Game", 2], ["List", 1], ["List_games", 1]]);
  });

  test("a folder missing a table's file, or with one invalid row, is ordinary files", async () => {
    const missing = await folder("missing", { "Game.jsonl": FILES["Game.jsonl"], "List.jsonl": FILES["List.jsonl"] });
    expect(decodeProtocolDirectory(missing.objects.get(missing.root)!).childrenSource).toBeUndefined();
    const invalid = await folder("invalid", { ...FILES, "List.jsonl": '{"id":"l1"}\n' });
    expect(decodeProtocolDirectory(invalid.objects.get(invalid.root)!).childrenSource).toBeUndefined();
  });

  test("passes usl verify", async () => {
    const snapshot = await folder("verified", FILES);
    const diagnostics = await verifyStore(compileUsl(SCHEMA), snapshot.directory);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("the plan's games.usl with Game.jsonl, List.jsonl and List_games.jsonl passes usl verify", async () => {
    const games = (await readFile(join(import.meta.dir, "../../plans/soon/schema-language/examples/games.usl"), "utf8"))
      .replace("ordered List.games[] @fold", "ordered List.games[]");
    const directory = join(sandbox, "games");
    await Bun.write(join(directory, "schema.usl"), games);
    await writeFile(join(directory, "Game.jsonl"), '{"id":"g1","name":"Chess","status":"Draft","tags":["board"],"authors":["joe"]}\n');
    await writeFile(join(directory, "List.jsonl"), '{"id":"l1","name":"Favorites"}\n');
    await writeFile(join(directory, "List_games.jsonl"), '{"list":"l1","game":"g1","games_position":1}\n');
    const diagnostics = await verifyStore(compileUsl(games), directory);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("rows of several tables", () => {
  const collection = (object: ObjectHash) => ({ material: { kind: "basis" as const, path: "/", object } });

  test("operations replay into the file of their table, and each table's child set is re-derived", async () => {
    const snapshot = await folder("replay", FILES);
    const operations: RowOperation[] = [
      { key: "a", kind: "rowSet", collection: collection(snapshot.root), table: "Game", row: key("g2"), field: "name", before: "Go", value: "Weiqi" },
      { key: "b", kind: "rowCreate", collection: collection(snapshot.root), table: "List", row: key("l2"), values: { id: "l2", name: "Later" } },
      { key: "c", kind: "rowDelete", collection: collection(snapshot.root), table: "List_games", row: JSON.stringify([["list", "l1"], ["game", "g1"]]) },
    ];
    const load = async (hash: ObjectHash) => snapshot.objects.get(hash)!;
    const result = await executeRowOperations(snapshot.root, operations, load, replayCollectionRows);
    const objects = new Map([...snapshot.objects, ...result.generated]);
    expect(text(objects, result.root, "Game.jsonl")).toBe('{"id":"g1","name":"Chess","tags":["board"]}\n{"id":"g2","name":"Weiqi"}\n');
    expect(text(objects, result.root, "List.jsonl")).toBe('{"id":"l1","name":"Favorites"}\n{"id":"l2","name":"Later"}\n');
    expect(text(objects, result.root, "List_games.jsonl")).toBe("");
    const descriptor = decodeProtocolDirectory(objects.get(result.root)!).childrenSource as CollectionTablesDescriptor;
    const schemas = compileCollectionSchemas(SCHEMA).tables;
    for (const [index, table] of descriptor.tables.entries()) {
      expect(table.childSetHash).toBe(collectionFileRows("jsonl", new TextEncoder().encode(text(objects, result.root, table.source)), schemas[index]!).childSetHash);
    }
    // A folder edit that replay reproduces is described as the same operations.
    const edited = await folder("replay-edited", {
      "Game.jsonl": text(objects, result.root, "Game.jsonl"), "List.jsonl": text(objects, result.root, "List.jsonl"), "List_games.jsonl": "",
    });
    const read = async (hash: ObjectHash) => objects.get(hash) ?? edited.objects.get(hash)!;
    expect(edited.root).toBe(result.root);
    const derived = await deriveRowOperations(snapshot.root, edited.root, read);
    expect(derived?.map((op) => [op.table, op.kind])).toEqual([["Game", "rowSet"], ["List", "rowCreate"], ["List_games", "rowDelete"]]);
  });

  test("an operation on a table the schema does not store is invalid", async () => {
    const snapshot = await folder("unknown-table", FILES);
    const op: RowOperation = { key: "a", kind: "rowDelete", collection: collection(snapshot.root), table: "Status", row: key("g1") };
    await expect(executeRowOperations(snapshot.root, [op], async (hash) => snapshot.objects.get(hash)!, replayCollectionRows)).rejects.toThrow("not in this collection");
  });

  test("concurrent edits to different tables, and to different fields of one row, merge", async () => {
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
    expect(text(merged, result.root, "Game.jsonl")).toBe('{"id":"g1","name":"Chess!","tags":["board","classic"]}\n{"id":"g2","name":"Go"}\n');
    expect(text(merged, result.root, "List.jsonl")).toBe('{"id":"l1","name":"Best"}\n');
    // The merged directory is a valid collection.
    const directory = decodeProtocolDirectory(merged.get(result.root)!);
    const bytes = (name: string) => merged.get(directory.entries.find((e) => e.name === name)!.file!)!;
    expect(() => decodeProtocolCollectionTables(directory.childrenSource!, bytes, bytes("schema.usl"))).not.toThrow();
  });

  test("the same field set twice in one table is a field conflict naming that table", async () => {
    const base = await folder("conflict-base", FILES);
    const candidate = await folder("conflict-candidate", { ...FILES, "List.jsonl": '{"id":"l1","name":"Mine"}\n' });
    const current = await folder("conflict-current", { ...FILES, "List.jsonl": '{"id":"l1","name":"Theirs"}\n' });
    const objects = new Map([...base.objects, ...candidate.objects, ...current.objects]);
    const result = await mergeProtocolTrees(base.root, candidate.root, current.root, async (hash) => objects.get(hash)!);
    expect(result.fields).toEqual([expect.objectContaining({ table: "List", row: key("l1"), field: "name" })]);
  });
});
