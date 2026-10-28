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
import { deriveRowOperations, replayCollectionRows } from "@ovst/collection-schema";
import { collectionRows, collectionTree, idRow, T0, type CollectionTree } from "../../support/collection-trees.ts";

const SCHEMA = "model Item {\n  title Text\n  done  Bool?\n  tags  Text[]\n  notes Markdown?\n}\n";
const HASH = `sha256:${"a".repeat(64)}`;
const key = (id: string) => JSON.stringify([["id", id]]);
const AT = "2026-10-24T10:00:00.000Z";

function rowOps(tree: CollectionTree) {
  const collection = { material: { kind: "basis" as const, path: "/items", object: tree.collection } };
  const target = (id: string, opKey: string) => ({ key: opKey, collection, model: "Item", row: key(id), at: AT });
  return {
    set: (id: string, field: string, before: unknown, value: unknown, k = "set") => ({ ...target(id, k), kind: "set", field, before, value }) as RowOperation,
    connect: (id: string, field: string, member: string, k = "connect") => ({ ...target(id, k), kind: "connect", field, member }) as RowOperation,
    disconnect: (id: string, field: string, member: string, k = "disconnect") => ({ ...target(id, k), kind: "disconnect", field, member }) as RowOperation,
    move: (id: string, field: string, member: string, after: string | null, k = "move") => ({ ...target(id, k), kind: "move", field, member, after }) as RowOperation,
    create: (id: string, values: Record<string, unknown>, k = "create") => ({ ...target(id, k), kind: "rowCreate", values: { id, ...values } }) as RowOperation,
    remove: (id: string, k = "delete") => ({ ...target(id, k), kind: "rowDelete" }) as RowOperation,
  };
}

async function replay(tree: CollectionTree, operations: SourceOperation[]) {
  const load = async (hash: ObjectHash) => tree.objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
  const result = await executeRowOperations(tree.root, operations, load, replayCollectionRows);
  const objects = new Map([...tree.objects, ...result.generated]);
  return { ...result, objects, rows: (await collectionRows(result.root, objects)).Item!, load: async (hash: ObjectHash) => objects.get(hash)! };
}

describe("row operation grammar", () => {
  const candidate = (operation: unknown) => ({ change: "c1", candidate: HASH, resolves: [], trace: [{ before: HASH, after: HASH, operations: [operation] }] });
  const collection = { material: { kind: "basis", path: "/items", object: HASH } };
  const base = { key: "op", collection, model: "Item", row: key("a") };

  test("accepts every row operation", () => {
    for (const operation of [
      { ...base, kind: "rowCreate", values: { id: "a", title: "A" } },
      { ...base, kind: "rowDelete" },
      { ...base, kind: "set", field: "title", before: "A", value: null },
      { ...base, kind: "connect", field: "tags", member: "x" },
      { ...base, kind: "disconnect", field: "tags", member: 3 },
      { ...base, kind: "move", field: "tags", member: "x", after: null },
      { ...base, kind: "move", field: "tags", member: "x", after: "y" },
    ]) expect(() => decodeAuthoredCandidateIntent(candidate(operation))).not.toThrow();
  });

  test("rejects malformed row operations", () => {
    for (const operation of [
      { ...base, kind: "set", field: "title", value: "B" },
      { ...base, kind: "set", field: "title", before: "A", value: "B", extra: 1 },
      { ...base, row: "a", kind: "rowDelete" },
      { ...base, model: "Item.x", kind: "rowDelete" },
      { ...base, kind: "connect", field: "tags", member: { id: "x" } },
      { ...base, kind: "connect", field: "tags", member: null },
      { ...base, kind: "move", field: "tags", member: "x", after: "x" },
      { ...base, kind: "rowCreate", values: [] },
      { ...base, collection: { ...collection, range: [0, 1] }, kind: "rowDelete" },
    ]) expect(() => decodeAuthoredCandidateIntent(candidate(operation))).toThrow();
  });
});

describe("row operation replay", () => {
  const items = () => collectionTree(SCHEMA, { Item: [
    idRow("a", { title: "A", tags: ["x", "y", "z"] }),
    idRow("b", { title: "B" }),
    idRow("c", { title: "C" }),
  ] });

  test("changes only the rows it names, stamps their times, and keeps sets sorted", async () => {
    const tree = items();
    const op = rowOps(tree);
    const result = await replay(tree, [
      op.set("b", "done", null, true, "s1"),
      op.disconnect("a", "tags", "y"),
      op.connect("a", "tags", "w"),
      op.remove("c"),
      op.create("d", { title: "D", tags: ["q"] }),
    ]);
    expect(result.rows).toEqual([
      idRow("a", { title: "A", tags: ["w", "x", "z"] }, T0, AT),
      idRow("b", { title: "B", done: true }, T0, AT),
      idRow("d", { title: "D", tags: ["q"] }, AT),
    ]);
    expect(result.touched).toEqual(["/items"]);
    const frames = [{ before: tree.root, after: result.root, operations: [op.set("b", "title", "B", "Bee")] }];
    const renamed = await replay(tree, frames[0]!.operations as SourceOperation[]);
    frames[0]!.after = renamed.root;
    expect(await checkPlainTrace(frames, renamed.load, replayCollectionRows)).toMatchObject({ plain: true, touched: ["/items"] });
    expect((await validateSourceTrace(frames, renamed.load, replayCollectionRows)).root).toBe(renamed.root);
    expect(await checkPlainTrace(frames, renamed.load)).toEqual({ plain: false, reason: "row operations need a collection replay" });
  });

  test("an ordered field moves its members", async () => {
    const schema = "model Item {\n  title Text\n  steps ordered Text[]\n}\n";
    const tree = collectionTree(schema, { Item: [idRow("a", { title: "A", steps: ["x", "y", "z"] })] });
    const op = rowOps(tree);
    const result = await replay(tree, [op.move("a", "steps", "z", null), op.connect("a", "steps", "w")]);
    expect(result.rows[0]!.fields.steps).toEqual(["z", "x", "y", "w"]);
    const unordered = collectionTree(SCHEMA, { Item: [idRow("a", { title: "A", tags: ["x", "y"] })] });
    await expect(replay(unordered, [rowOps(unordered).move("a", "tags", "y", null)])).rejects.toThrow(/is a set/);
  });

  test("a frame that does not equal the replay is not plain", async () => {
    const tree = items();
    const op = rowOps(tree);
    const load = async (hash: ObjectHash) => tree.objects.get(hash)!;
    const checked = await checkPlainTrace([{ before: tree.root, after: tree.root, operations: [op.set("a", "title", "A", "Z")] }], load, replayCollectionRows);
    expect(checked).toEqual({ plain: false, reason: "operations do not reproduce the frame" });
  });

  test("setting null or emptying a list removes the field", async () => {
    const tree = collectionTree(SCHEMA, { Item: [idRow("a", { title: "A", done: false, tags: ["x"] })] });
    const op = rowOps(tree);
    const result = await replay(tree, [op.set("a", "done", false, null), op.disconnect("a", "tags", "x")]);
    expect(result.rows[0]!.fields).toEqual({ title: "A" });
  });

  test("an operation that does not hold on its basis is invalid", async () => {
    const tree = items();
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
      [[{ ...op.remove("a"), model: "Other" }], /not a model/],
      [[op.set("a", "title", "A", 5)], /Expected text/],
      [[op.set("a", "modified", null, AT)], /operation's time/],
      [[{ ...op.set("a", "title", "A", "Z"), at: undefined }], /carries its time/],
      [[{ ...op.set("a", "title", "A", "Z"), at: "2026-10-24T10:00:00Z" }], /milliseconds/],
    ] as Array<[SourceOperation[], RegExp]>) await expect(replay(tree, operations)).rejects.toThrow(message);
  });
});

describe("derived row operations", () => {
  test("explain a change to rows, each stamped with its row's new time", async () => {
    const before = collectionTree(SCHEMA, { Item: [idRow("a", { title: "A" }), idRow("c", { title: "C", tags: ["x"] })] });
    const after = collectionTree(SCHEMA, { Item: [
      idRow("a", { title: "Alpha" }, T0, AT),
      idRow("b", { title: "B" }, AT),
      idRow("c", { title: "C", tags: ["w", "x"] }, T0, AT),
    ] }, new Map(before.objects));
    const operations = await deriveRowOperations(before.root, after.root, async (hash) => after.objects.get(hash)!);
    expect(operations).toEqual([
      expect.objectContaining({ kind: "set", field: "title", before: "A", value: "Alpha", at: AT }),
      expect.objectContaining({ kind: "rowCreate", values: { id: "b", title: "B" }, at: AT }),
      expect.objectContaining({ kind: "connect", field: "tags", member: "w", at: AT }),
    ]);
  });

  test("a change only operations can't make stays a snapshot", async () => {
    const before = collectionTree(SCHEMA, { Item: [idRow("a", { title: "A" })] });
    for (const rows of [
      [idRow("a", { title: "A" }, T0, AT)],            // modified with no change
      [idRow("a", { title: "Alpha" }, AT, AT)],        // created changed
      [idRow("a", { title: "A" }), idRow("b", { title: "B" }, T0, AT)], // a new row's times differ
    ]) {
      const after = collectionTree(SCHEMA, { Item: rows }, new Map(before.objects));
      expect(await deriveRowOperations(before.root, after.root, async (hash) => after.objects.get(hash)!)).toBeNull();
    }
  });
});
