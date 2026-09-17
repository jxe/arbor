import { describe, expect, test } from "bun:test";
import { hashObject } from "@arbor/wire";
import { partitionSourceRegions, projectSourceRegions, type RegionContribution } from "../../../packages/canopy/src/updates/source-regions.ts";

function fixture(text: string) {
  const source = new TextEncoder().encode(text), object = hashObject(source), path = "/nested/note.md";
  const edit = (change: string, operation: string, range: [number, number], text: string): RegionContribution =>
    ({ change, edit: { operation, path, source: { object, range }, text, lineage: [] } });
  const partition = (...edits: RegionContribution[]) => partitionSourceRegions(path, object, source, edits);
  const project = (layout: ReturnType<typeof partition>, choices: Array<[number, string]> = []) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(projectSourceRegions(source, layout, new Map(choices)));
  return { source, object, path, edit, partition, project };
}

describe("same-basis source regions", () => {
  test("two overlaps remain independently selectable, with independent work retained", () => {
    const f = fixture("one / two / tail\r\n");
    const layout = f.partition(f.edit("a", "first", [0, 3], "ONE"), f.edit("b", "first", [0, 3], "Uno"),
      f.edit("a", "second", [6, 9], "TWO"), f.edit("b", "second", [6, 9], "Dos"),
      f.edit("c", "tail", [12, 16], "end"));
    expect(layout.regions.map(r => r.range)).toEqual([[0, 3], [6, 9], [12, 16]]);
    expect(f.project(layout, [[0, "a"], [1, "b"]])).toBe("ONE / Dos / end\r\n");
    expect(f.project(layout, [[0, "b"], [1, "a"]])).toBe("Uno / TWO / end\r\n");
    expect(() => f.project(layout)).toThrow("explicit valid choice");
  });

  test("connected overlap builds exact regional alternatives, preserving intervening bytes", () => {
    const f = fixture("0123456789");
    const layout = f.partition(f.edit("a", "left", [1, 3], "A"), f.edit("a", "right", [5, 7], "B"),
      f.edit("b", "bridge", [2, 6], "X"));
    expect(layout.regions).toEqual([{ range: [1, 7], alternatives: [
      { change: "a", text: "A34B", operations: ["left", "right"] },
      { change: "b", text: "1X6", operations: ["bridge"] },
    ] }]);
    expect(f.project(layout, [[0, "a"]])).toBe("0A34B789");
    expect(f.project(layout, [[0, "b"]])).toBe("01X6789");
  });

  test("same-anchor inserts stay separate even when their bytes are equal", () => {
    const f = fixture("ab");
    const layout = f.partition(f.edit("a", "insert", [1, 1], "!"), f.edit("b", "insert", [1, 1], "!"));
    expect(layout.regions[0]!.alternatives).toHaveLength(2);
    expect(() => f.project(layout)).toThrow();
    expect(f.project(layout, [[0, "a"]])).toBe("a!b");
  });

  test("boundary anchors follow exact execution, including end-of-file", () => {
    const f = fixture("abcd");
    const layout = f.partition(f.edit("a", "replace", [0, 2], "A"), f.edit("b", "start", [0, 0], "B"),
      f.edit("c", "end", [2, 2], "C"), f.edit("d", "eof", [4, 4], "D"));
    expect(layout.regions.map(r => r.range)).toEqual([[0, 2], [2, 2], [4, 4]]);
    expect(f.project(layout, [[0, "b"]])).toBe("BabCcdD");
  });

  test("UTF-8 coordinates, BOM, CRLF, and equal-byte edits retain exact source", () => {
    const f = fixture("\ufeffé\r\n終");
    const layout = f.partition(f.edit("a", "same", [3, 5], "é"), f.edit("b", "other", [3, 5], "e"));
    expect(f.project(layout, [[0, "a"]])).toBe("\ufeffé\r\n終");
    expect(layout.regions[0]!.alternatives[0]!.operations).toEqual(["same"]);
    expect(() => f.partition(f.edit("a", "bad", [4, 5], "x"))).toThrow("range");
    expect(() => f.partition(f.edit("a", "bad", [3, 5], "\ud800"))).toThrow("text");
  });

  test("arrival permutations and serialization preserve regional evidence and projection", () => {
    const f = fixture("abcde");
    const edits = [f.edit("z", "a", [0, 2], "Z"), f.edit("a", "b", [1, 3], "A"), f.edit("c", "c", [4, 5], "C")];
    const expected = f.partition(...edits);
    for (const permutation of [edits, [...edits].reverse(), [edits[1]!, edits[2]!, edits[0]!]]) {
      expect(f.partition(...permutation)).toEqual(expected);
      expect(f.project(JSON.parse(JSON.stringify(f.partition(...permutation))), [[0, "z"]])).toBe("ZcdC");
    }
  });

  test("rejects mixed occurrences, mixed bases, duplicate identity and invalid authored overlaps", () => {
    const f = fixture("abcd");
    const a = f.edit("a", "first", [0, 2], "X");
    expect(() => f.partition(a, a)).toThrow("Duplicate");
    expect(() => f.partition(a, f.edit("a", "second", [1, 3], "Y"))).toThrow("one authored change");
    expect(() => f.partition({ ...a, edit: { ...a.edit, path: "/other.md" } })).toThrow("basis mismatch");
    expect(() => partitionSourceRegions(f.path, hashObject(new Uint8Array()), f.source, [a])).toThrow("object mismatch");
    expect(() => f.partition(f.edit("a", "bad", [-1, 2], "X"))).toThrow("range");
    expect(() => f.project(f.partition(a), [[0, "unknown"]])).toThrow();
    expect(() => f.project(f.partition(a), [[1, "a"]])).toThrow("Unknown");
  });

  test("empty layout and whole-source deletion project without normalization", () => {
    const f = fixture("raw\r\n");
    expect(f.project(f.partition())).toBe("raw\r\n");
    expect(f.project(f.partition(f.edit("a", "delete", [0, 5], "")))).toBe("");
  });

  test("many independent decisions store alternatives without enumerating document combinations", () => {
    const f = fixture("x ".repeat(40));
    const edits = Array.from({ length: 40 }, (_, index) => [
      f.edit("a", `edit-${index}`, [index * 2, index * 2 + 1], "A"),
      f.edit("b", `edit-${index}`, [index * 2, index * 2 + 1], "B"),
    ]).flat();
    const layout = f.partition(...edits);
    expect(layout.regions).toHaveLength(40);
    expect(layout.regions.reduce((count, region) => count + region.alternatives.length, 0)).toBe(80);
    expect(f.project(layout, Array.from({ length: 40 }, (_, index) => [index, index % 2 ? "b" : "a"])))
      .toBe("A B ".repeat(20));
  });
});
