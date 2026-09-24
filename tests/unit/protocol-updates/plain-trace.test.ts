import { expect, test } from "bun:test";
import { checkPlainTrace, encodeWireDirectory, hashObject, type SourceOperation, type WireDirectoryEntry } from "@overstory/protocol";
import { decodeLogEntry, encodeLogEntry, LOG_ENTRY_FORMAT, type LogEntry } from "@overstory/merge-protocol";

const objects = new Map<string, Uint8Array>();
const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
const text = (value: string) => put(new TextEncoder().encode(value));
const dir = (entries: WireDirectoryEntry[]) => put(encodeWireDirectory({ type: "directory", entries: [...entries].sort((a, b) => a.name < b.name ? -1 : 1) }));
const load = async (hash: string) => objects.get(hash) ?? Promise.reject(new Error("missing"));

const note = text("hello world"), inner = dir([{ name: "a.md", file: note }]);
const root = dir([{ name: "docs", directory: inner }, { name: "top.md", file: note }]);
const edit = (path: string, object: string, range: [number, number], value: string, key = "edit"): SourceOperation =>
  ({ key, kind: "editSource", source: { material: { kind: "basis", path, object }, range }, text: value });
const add = (name: string, file: string, key = "add"): SourceOperation =>
  ({ key, kind: "addEntry", destination: { parent: { material: { kind: "basis", path: "/docs", object: inner } }, name }, value: { file } });

test("plain edits and additions that reproduce each frame are plain, naming what they touch", async () => {
  const edited = text("HELLO world"), added = text("new");
  const after = dir([{ name: "docs", directory: dir([{ name: "a.md", file: edited }, { name: "b.md", file: added }]) }, { name: "top.md", file: note }]);
  const checked = await checkPlainTrace([{ before: root, after, operations: [edit("/docs/a.md", note, [0, 5], "HELLO"), add("b.md", added)] }], load);
  expect(checked).toMatchObject({ plain: true });
  expect(checked.plain && checked.touched.sort()).toEqual(["/docs/a.md", "/docs/b.md"]);
});

test("anything else falls through with its reason and is never a rejection", async () => {
  const added = text("new");
  const wrong = dir([{ name: "docs", directory: inner }, { name: "top.md", file: added }]);
  const cases: Array<[SourceOperation[], string, RegExp]> = [
    [[{ key: "move", kind: "moveEntry", source: { material: { kind: "basis", path: "/top.md", object: note } }, destination: { parent: { material: { kind: "basis", path: "/", object: root } }, name: "moved.md" } } as SourceOperation], wrong, /operation moveEntry/],
    [[add("a.md", added)], wrong, /existing entry/],
    [[edit("/top.md", note, [0, 5], "HELLO")], wrong, /do not reproduce/],
    [[edit("/top.md", note, [0, 5], "A", "same"), edit("/docs/a.md", note, [0, 1], "B", "same")], wrong, /duplicate operation key/],
  ];
  for (const [operations, after, reason] of cases) {
    const checked = await checkPlainTrace([{ before: root, after, operations }], load);
    expect(checked.plain).toBe(false);
    expect(!checked.plain && checked.reason).toMatch(reason);
  }
  expect(await checkPlainTrace([], load)).toEqual({ plain: false, reason: "empty trace" });
});

test("a log entry's bytes are canonical and name it", () => {
  const entry: LogEntry = { format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: null, root, change: "c", trace: null, resolves: [],
    decisions: [{ key: "k", path: ["top.md"], dependencies: [], selected: 0, alternatives: [{ object: root, contributions: [] }, { object: inner, contributions: [{ change: "c", operation: null }] }] }] };
  const bytes = encodeLogEntry(entry);
  expect(decodeLogEntry(bytes)).toEqual(entry);
  expect(() => decodeLogEntry(new TextEncoder().encode(JSON.stringify(entry, null, 1)))).toThrow("canonical");
  expect(() => encodeLogEntry({ ...entry, decisions: [{ ...entry.decisions[0]!, selected: 2 }] })).toThrow();
  expect(() => encodeLogEntry({ ...entry, decisions: [{ ...entry.decisions[0]!, path: undefined, range: [0, 1] }] })).toThrow();
});
