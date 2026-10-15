import { describe, expect, test } from "bun:test";
import {
  checkPlainTrace,
  decodeAuthoredCandidateIntent,
  executeRowOperations,
  validateSourceTrace,
  type ObjectHash,
  type RowOperation,
  type SourceOperation,
} from "@ovst/protocol";
import { replayCollectionRows } from "@ovst/collection-schema";
import { collectionSource, collectionTree, type CollectionTree } from "../../support/collection-trees.ts";

const SCHEMA = "model Item {\n  title Text\n  done  Bool?\n  tags  Text[]\n  notes Markdown?\n}\n";
const HASH = `sha256:${"a".repeat(64)}`;
const key = (id: string) => JSON.stringify([["id", id]]);

function rowOps(tree: CollectionTree) {
  const collection = { material: { kind: "basis" as const, path: "/items", object: tree.collection } };
  const target = (id: string, opKey: string) => ({ key: opKey, collection, table: "Item", row: key(id) });
  return {
    set: (id: string, field: string, before: unknown, value: unknown, k = "set") => ({ ...target(id, k), kind: "rowSet", field, before, value }) as RowOperation,
    connect: (id: string, field: string, member: string, k = "connect") => ({ ...target(id, k), kind: "rowConnect", field, member }) as RowOperation,
    disconnect: (id: string, field: string, member: string, k = "disconnect") => ({ ...target(id, k), kind: "rowDisconnect", field, member }) as RowOperation,
    move: (id: string, field: string, member: string, after: string | null, k = "move") => ({ ...target(id, k), kind: "rowMove", field, member, after }) as RowOperation,
    create: (id: string, values: Record<string, unknown>, k = "create") => ({ ...target(id, k), kind: "rowCreate", values: { id, ...values } }) as RowOperation,
    remove: (id: string, k = "delete") => ({ ...target(id, k), kind: "rowDelete" }) as RowOperation,
  };
}

async function replay(tree: CollectionTree, operations: SourceOperation[]) {
  const load = async (hash: ObjectHash) => tree.objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
  const result = await executeRowOperations(tree.root, operations, load, replayCollectionRows);
  const objects = new Map([...tree.objects, ...result.generated]);
  return { ...result, objects, source: collectionSource(result.root, objects), load: async (hash: ObjectHash) => objects.get(hash)! };
}

describe("row operation grammar", () => {
  const candidate = (operation: unknown) => ({ change: "c1", candidate: HASH, resolves: [], trace: [{ before: HASH, after: HASH, operations: [operation] }] });
  const collection = { material: { kind: "basis", path: "/items", object: HASH } };
  const base = { key: "op", collection, table: "Item", row: key("a") };

  test("accepts every row operation", () => {
    for (const operation of [
      { ...base, kind: "rowCreate", values: { id: "a", title: "A" } },
      { ...base, kind: "rowDelete" },
      { ...base, kind: "rowSet", field: "title", before: "A", value: null },
      { ...base, kind: "rowConnect", field: "tags", member: "x" },
      { ...base, kind: "rowDisconnect", field: "tags", member: 3 },
      { ...base, kind: "rowMove", field: "tags", member: "x", after: null },
      { ...base, kind: "rowMove", field: "tags", member: "x", after: "y" },
    ]) expect(() => decodeAuthoredCandidateIntent(candidate(operation))).not.toThrow();
  });

  test("rejects malformed row operations", () => {
    for (const operation of [
      { ...base, kind: "rowSet", field: "title", value: "B" },
      { ...base, kind: "rowSet", field: "title", before: "A", value: "B", extra: 1 },
      { ...base, row: "a", kind: "rowDelete" },
      { ...base, table: "Item.x", kind: "rowDelete" },
      { ...base, kind: "rowConnect", field: "tags", member: { id: "x" } },
      { ...base, kind: "rowConnect", field: "tags", member: null },
      { ...base, kind: "rowMove", field: "tags", member: "x", after: "x" },
      { ...base, kind: "rowCreate", values: [] },
      { ...base, collection: { ...collection, range: [0, 1] }, kind: "rowDelete" },
    ]) expect(() => decodeAuthoredCandidateIntent(candidate(operation))).toThrow();
  });
});

describe("row operation replay", () => {
  const jsonl = '{"id":"a","title":"A","tags":["x","y","z"]}\n  {"title":"B","id":"b"}  \n{"id":"c","title":"C"}\n';

  test("splices only the rows it changes and re-derives the descriptor", async () => {
    const tree = collectionTree("jsonl", SCHEMA, jsonl);
    const op = rowOps(tree);
    const result = await replay(tree, [
      op.set("b", "done", null, true, "s1"),
      op.move("a", "tags", "z", null),
      op.disconnect("a", "tags", "y"),
      op.connect("a", "tags", "w"),
      op.remove("c"),
      op.create("d", { title: "D", tags: ["q"] }),
    ]);
    expect(result.source).toBe(
      '{"id":"a","title":"A","tags":["z","x","w"]}\n  {"id":"b","title":"B","done":true}  \n{"id":"d","title":"D","tags":["q"]}\n',
    );
    expect(result.touched).toEqual(["/items"]);
    const frames = [{ before: tree.root, after: result.root, operations: [op.set("b", "title", "B", "Bee")] }];
    const renamed = await replay(tree, frames[0]!.operations as SourceOperation[]);
    frames[0]!.after = renamed.root;
    expect(await checkPlainTrace(frames, renamed.load, replayCollectionRows)).toMatchObject({ plain: true, touched: ["/items"] });
    expect((await validateSourceTrace(frames, renamed.load, replayCollectionRows)).root).toBe(renamed.root);
    expect(await checkPlainTrace(frames, renamed.load)).toEqual({ plain: false, reason: "row operations need a collection replay" });
  });

  test("a frame that does not equal the replay is not plain", async () => {
    const tree = collectionTree("jsonl", SCHEMA, jsonl);
    const op = rowOps(tree);
    const load = async (hash: ObjectHash) => tree.objects.get(hash)!;
    const checked = await checkPlainTrace([{ before: tree.root, after: tree.root, operations: [op.set("a", "title", "A", "Z")] }], load, replayCollectionRows);
    expect(checked).toEqual({ plain: false, reason: "operations do not reproduce the frame" });
  });

  test("setting null or emptying a list removes the member", async () => {
    const tree = collectionTree("jsonl", SCHEMA, '{"id":"a","title":"A","done":false,"tags":["x"]}\n');
    const op = rowOps(tree);
    const result = await replay(tree, [op.set("a", "done", false, null), op.disconnect("a", "tags", "x")]);
    expect(result.source).toBe('{"id":"a","title":"A"}\n');
  });

  test("pretty JSON keeps its layout", async () => {
    const source = '[\n  {"id": "a", "title": "A"},\n  {"id": "b", "title": "B"}\n]\n';
    const tree = collectionTree("json", SCHEMA, source);
    const op = rowOps(tree);
    expect((await replay(tree, [op.set("a", "title", "A", "Alpha")])).source)
      .toBe('[\n  {"id":"a","title":"Alpha"},\n  {"id": "b", "title": "B"}\n]\n');
    expect((await replay(tree, [op.remove("a"), op.create("c", { title: "C" })])).source)
      .toBe('[\n  {"id": "b", "title": "B"},\n  {"id":"c","title":"C"}\n]\n');
    const empty = collectionTree("json", SCHEMA, "[]\n");
    expect((await replay(empty, [rowOps(empty).create("a", { title: "A" })])).source).toBe('[\n  {"id":"a","title":"A"}\n]\n');
  });

  test("CSV re-encodes a changed record in the file's header order", async () => {
    const tree = collectionTree("csv", "model Item {\n  title Text\n  count Int?\n}\n", "title,id,count\nA,a,1\nB,b,\n");
    const op = rowOps(tree);
    expect((await replay(tree, [op.set("b", "count", null, 7), op.remove("a"), op.create("c", { title: "C, too" })])).source)
      .toBe('title,id,count\nB,b,7\n"C, too",c,\n');
  });

  test("an operation that does not hold on its basis is invalid", async () => {
    const tree = collectionTree("jsonl", SCHEMA, jsonl);
    const op = rowOps(tree);
    for (const [operations, message] of [
      [[op.set("a", "title", "stale", "Z")], /value seen/],
      [[op.set("zz", "title", null, "Z")], /row is absent/],
      [[op.set("a", "id", "a", "q")], /key field/],
      [[op.set("a", "title", "A", "A")], /changes nothing/],
      [[op.create("a", { title: "A2" })], /already exists/],
      [[{ ...op.create("e", { title: "E" }), row: key("f") }], /row's key/],
      [[op.connect("a", "tags", "x")], /already present/],
      [[op.disconnect("a", "tags", "nope")], /absent/],
      [[op.move("a", "tags", "x", "nope")], /anchor/],
      [[op.move("a", "tags", "x", null)], /changes nothing/],
      [[{ ...op.remove("a"), table: "Other" }], /table/],
      [[op.set("a", "title", "A", 5)], /does not satisfy schema/],
    ] as Array<[SourceOperation[], RegExp]>) await expect(replay(tree, operations)).rejects.toThrow(message);
  });
});

describe("row operation times", () => {
  const at = "2026-10-15T09:00:00.000Z", later = "2026-10-15T10:00:00Z";
  test("a timed operation writes created and modified, and a set of either is invalid", async () => {
    const tree = collectionTree("jsonl", SCHEMA, '{"id":"a","title":"A"}\n');
    const op = rowOps(tree);
    const result = await replay(tree, [{ ...op.create("b", { title: "B" }), at }, { ...op.set("a", "title", "A", "Alpha"), at: later }]);
    expect(result.source).toBe(`{"id":"a","title":"Alpha","modified":"${later}"}\n{"id":"b","title":"B","created":"${at}","modified":"${at}"}\n`);
    await expect(replay(tree, [op.set("a", "modified", null, at)])).rejects.toThrow(/operation's time/);
    await expect(replay(tree, [{ ...op.create("c", { title: "C", created: at }), at }])).rejects.toThrow(/times come from/);
  });

  test("a CSV file without time columns keeps none", async () => {
    const tree = collectionTree("csv", "model Item {\n  title Text\n}\n", "id,title\na,A\n");
    expect((await replay(tree, [{ ...rowOps(tree).set("a", "title", "A", "B"), at }])).source).toBe("id,title\na,B\n");
  });

  test("Story Sync's derived operations carry a changed row's time", async () => {
    const { deriveRowOperations } = await import("@ovst/collection-schema");
    const before = collectionTree("jsonl", SCHEMA, '{"id":"a","title":"A"}\n');
    const after = collectionTree("jsonl", SCHEMA, `{"id":"a","title":"Alpha","modified":"${later}"}\n{"id":"b","title":"B","created":"${at}","modified":"${at}"}\n`, new Map(before.objects));
    const operations = await deriveRowOperations(before.root, after.root, async (hash) => after.objects.get(hash)!);
    expect(operations).toEqual([
      expect.objectContaining({ kind: "rowSet", field: "title", before: "A", value: "Alpha", at: later }),
      expect.objectContaining({ kind: "rowCreate", values: { id: "b", title: "B" }, at }),
    ]);
  });
});
