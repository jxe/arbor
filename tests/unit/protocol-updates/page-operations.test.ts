import { describe, expect, test } from "bun:test";
import {
  applyPageOperations,
  decodeAuthoredCandidateIntent,
  decodeProtocolDirectory,
  decodeProtocolPage,
  encodeProtocolDirectory,
  encodeProtocolPage,
  hashObject,
  pageDate,
  pageValueFromJSON,
  pageValueJSON,
  validateSourceTrace,
  type ObjectHash,
  type PageProperty,
  type ProtocolPage,
  type SourceOperation,
} from "@ovst/protocol";

const objects = new Map<string, Uint8Array>();
const put = (bytes: Uint8Array) => {
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
};
const load = async (hash: ObjectHash) => objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
const encoder = new TextEncoder(), decoder = new TextDecoder();
const pageOf = (properties: PageProperty[], body: string, id?: string): ProtocolPage =>
  ({ type: "page", ...(id ? { id } : {}), properties, body: encoder.encode(body) });
const tree = (page: ProtocolPage) => {
  const object = put(encodeProtocolPage(page));
  const folder = put(encodeProtocolDirectory({ type: "directory", entries: [{ name: "a.md", page: object }] }));
  return { object, root: put(encodeProtocolDirectory({ type: "directory", entries: [{ name: "notes", directory: folder }] })) };
};
const target = (object: ObjectHash) => ({ material: { kind: "basis" as const, path: "/notes/a.md", object } });

describe("page values in JSON", () => {
  test("timestamps and maps that look like them have one spelling each", () => {
    for (const value of [pageDate("2026-10-28"), { $date: "x" }, { $map: 1 }, { a: { $dateTime: "y" } }, [1, "two", null]]) {
      const json = pageValueJSON(value as never);
      expect(pageValueJSON(pageValueFromJSON(json))).toEqual(json);
    }
    expect(pageValueJSON({ $date: "x" })).toEqual({ $map: { $date: "x" } });
    expect(() => pageValueFromJSON({ $date: "2026-02-30" })).toThrow();
    expect(() => pageValueFromJSON({ $dateTime: "2026-10-28T09:00:00+02:00" })).toThrow();
  });
});

describe("page property operations", () => {
  const page = pageOf([["title", "A"], ["tags", ["x", "y"]]], "Body\n", "p1");

  test("set, connect, disconnect and move edit properties and leave the body", () => {
    const next = applyPageOperations(page, [
      { kind: "set", field: "title", before: "A", value: "B" },
      { kind: "set", field: "due", before: null, value: { $date: "2026-10-28" } },
      { kind: "connect", field: "tags", member: "z" },
      { kind: "move", field: "tags", member: "z", after: null },
      { kind: "disconnect", field: "tags", member: "x" },
      { kind: "connect", field: "people", member: "jo" },
    ]);
    expect(next.id).toBe("p1");
    expect(next.properties).toEqual([["title", "B"], ["tags", ["z", "y"]], ["due", pageDate("2026-10-28")], ["people", ["jo"]]]);
    expect(next.body).toEqual(page.body);
    expect(applyPageOperations(next, [{ kind: "set", field: "title", before: "B", value: null }]).properties.map(([name]) => name))
      .toEqual(["tags", "due", "people"]);
  });

  test("operations that do not apply are invalid", () => {
    for (const operation of [
      { kind: "set", field: "title", before: "stale", value: "B" },
      { kind: "set", field: "id", before: null, value: "q" },
      { kind: "connect", field: "tags", member: "x" },
      { kind: "connect", field: "title", member: "x" },
      { kind: "disconnect", field: "tags", member: "q" },
      { kind: "move", field: "tags", member: "y", after: "x" },
    ] as const) expect(() => applyPageOperations(page, [operation as never])).toThrow();
  });

  test("a trace of property operations on a page replays to its candidate", async () => {
    const before = tree(page);
    const after = tree(applyPageOperations(page, [{ kind: "set", field: "title", before: "A", value: "B" }]));
    const operations: SourceOperation[] = [{ key: "op-1", kind: "set", page: target(before.object), field: "title", before: "A", value: "B" }];
    const result = await validateSourceTrace([{ before: before.root, after: after.root, operations }], load);
    expect(result.root).toBe(after.root);
    const wrong = tree(applyPageOperations(page, [{ kind: "set", field: "title", before: "A", value: "C" }]));
    await expect(validateSourceTrace([{ before: before.root, after: wrong.root, operations }], load)).rejects.toThrow();
  });

  test("the contract accepts page targets and rejects an id or a ranged target", () => {
    const frame = (operation: Record<string, unknown>) => ({ change: "c1", candidate: null, resolves: [], trace: [{ operations: [{ key: "k1", ...operation }] }] });
    const ref = target(`sha256:${"0".repeat(64)}`);
    expect(() => decodeAuthoredCandidateIntent(frame({ kind: "set", page: ref, field: "title", before: null, value: { $date: "2026-10-28" } }))).not.toThrow();
    expect(() => decodeAuthoredCandidateIntent(frame({ kind: "set", page: ref, field: "id", before: null, value: "x" }))).toThrow();
    expect(() => decodeAuthoredCandidateIntent(frame({ kind: "set", page: { ...ref, range: [0, 1] }, field: "t", before: null, value: "x" }))).toThrow();
    expect(() => decodeAuthoredCandidateIntent(frame({ kind: "rowCreate", page: ref, values: {} }))).toThrow();
  });
});

describe("a page's body is its source text", () => {
  test("editSource on a page replaces body bytes and keeps its properties", async () => {
    const page = pageOf([["title", "A"]], "Hello world\n", "p1");
    const before = tree(page);
    const after = tree({ ...page, body: encoder.encode("Hello there\n") });
    const operations: SourceOperation[] = [{ key: "e1", kind: "editSource", source: { ...target(before.object), range: [6, 11] }, text: "there" }];
    const result = await validateSourceTrace([{ before: before.root, after: after.root, operations }], load);
    expect(result.root).toBe(after.root);
    const folder = decodeProtocolDirectory(result.generated.get(decodeProtocolDirectory(result.generated.get(result.root)!).entries[0]!.directory!)!);
    const written = decodeProtocolPage(result.generated.get(folder.entries[0]!.page!)!);
    expect(written.properties).toEqual([["title", "A"]]);
    expect(decoder.decode(written.body)).toBe("Hello there\n");
  });
});
