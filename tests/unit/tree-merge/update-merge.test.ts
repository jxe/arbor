import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeProtocolTrees } from "@ovst/tree-merge";
import { collectionRows, collectionTree, idRow, T0 } from "../../support/collection-trees.ts";
import {
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  type TreeSnapshot,
  type UpdateConflict,
  type ProtocolDirectoryEntry,
  type ProtocolDirectory,
  type LogicalRow,
} from "@ovst/protocol";

const T1 = "2026-10-24T10:00:00.000Z";
const T2 = "2026-10-24T11:00:00.000Z";

interface ExpectedMerge {
  conflicts: UpdateConflict[];
  contains?: string[];
  absent?: string[];
  ordered?: Array<[string, string]>;
  counts?: Record<string, number>;
  approximatePlacements?: number;
}

interface MarkdownCase {
  name: string;
  base: string;
  candidate: string;
  remote: string;
  expected: ExpectedMerge;
}

interface PageMoveCase {
  name: string;
  base: { name: string; source: string };
  candidate: { name: string; source: string };
  remote: { name: string; source: string };
  expected: Pick<ExpectedMerge, "conflicts" | "contains"> & { name: string };
}

type StructuralCase = {
  name: string;
  expected: Pick<ExpectedMerge, "conflicts">;
} & (
  | { kind: "binary"; baseBase64: string; candidateBase64: string; remoteBase64: string }
  | { kind: "nested-boundary"; baseTree: string; candidateTree: string; remoteTree: string }
  | { kind: "path-kind" }
);

interface MergeFixtures {
  version: number;
  markdownCases: MarkdownCase[];
  pageMoveCases: PageMoveCase[];
  structuralCases: StructuralCase[];
}

function stored(object: ProtocolDirectory | { type: "file"; bytes: Uint8Array }, objects: Map<string, Uint8Array>): string {
  const bytes = object.type === "file" ? object.bytes : encodeProtocolDirectory(object);
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
}

function root(entries: ProtocolDirectoryEntry[], objects: Map<string, Uint8Array>): string {
  return stored({ type: "directory", entries }, objects);
}

function markdownSnapshot(source: string, objects: Map<string, Uint8Array>): TreeSnapshot {
  return namedMarkdownSnapshot("note.md", source, objects);
}

function namedMarkdownSnapshot(name: string, source: string, objects: Map<string, Uint8Array>): TreeSnapshot {
  const file = stored({ type: "file", bytes: new TextEncoder().encode(source) }, objects);
  return { root: root([{ name, file: file }], objects), objects };
}

const SCHEMA = "model Item {\n  title Text\n}\n";

function itemsSnapshot(schema: string, rows: LogicalRow[]): TreeSnapshot {
  return collectionTree(schema, { Item: rows });
}

async function mergeItems(base: TreeSnapshot, candidate: TreeSnapshot, remote: TreeSnapshot) {
  const objects = new Map([...base.objects, ...candidate.objects, ...remote.objects]);
  const result = await mergeProtocolTrees(base.root, candidate.root, remote.root, async (hash) => objects.get(hash)!);
  const rows = async () => (await collectionRows(result.root, new Map([...objects, ...result.objects]))).Item ?? [];
  return { result, rows };
}

async function mergedSource(
  roots: { base: string; candidate: string; remote: string },
  objects: Map<string, Uint8Array>,
) {
  const result = await mergeProtocolTrees(roots.base, roots.candidate, roots.remote, async (hash) => {
    const bytes = objects.get(hash);
    if (!bytes) throw new Error(`Missing fixture object ${hash}`);
    return bytes;
  });
  const load = (hash: string) => result.objects.get(hash) ?? objects.get(hash);
  const directoryBytes = load(result.root);
  if (!directoryBytes) throw new Error("Missing merged root");
  const directory = decodeProtocolDirectory(directoryBytes);
  if (directory.type !== "directory") throw new Error("Expected merged directory");
  const note = directory.entries.find((entry) => entry.name === "note.md")?.file;
  if (!note) throw new Error("Expected merged note.md");
  const fileBytes = load(note);
  if (!fileBytes) throw new Error("Missing merged Markdown object");
  const file = fileBytes;
  return { result, source: new TextDecoder().decode(file) };
}

async function mergedPage(
  roots: { base: string; candidate: string; remote: string },
  objects: Map<string, Uint8Array>,
) {
  const result = await mergeProtocolTrees(roots.base, roots.candidate, roots.remote, async (hash) => {
    const bytes = objects.get(hash);
    if (!bytes) throw new Error(`Missing fixture object ${hash}`);
    return bytes;
  });
  const load = (hash: string) => result.objects.get(hash) ?? objects.get(hash);
  const directoryBytes = load(result.root);
  if (!directoryBytes) throw new Error("Missing merged root");
  const directory = decodeProtocolDirectory(directoryBytes);
  if (directory.type !== "directory" || directory.entries.length !== 1) throw new Error("Expected one merged page");
  const entry = directory.entries[0]!;
  if (!entry.file) throw new Error("Expected a Markdown hash");
  const fileBytes = load(entry.file);
  if (!fileBytes) throw new Error("Missing merged page");
  const file = fileBytes;
  return { result, name: entry.name, source: new TextDecoder().decode(file) };
}

function occurrences(source: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    count++;
    offset += needle.length;
  }
  return count;
}

function lineCounts(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of source.match(/.*?(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function expectNoAddedLineOmitted(base: string, candidate: string, remote: string, merged: string): void {
  const baseCounts = lineCounts(base);
  const candidateCounts = lineCounts(candidate);
  const remoteCounts = lineCounts(remote);
  const mergedCounts = lineCounts(merged);
  for (const line of new Set([...candidateCounts.keys(), ...remoteCounts.keys()])) {
    const before = baseCounts.get(line) ?? 0;
    const candidateAdditions = Math.max(0, (candidateCounts.get(line) ?? 0) - before);
    const remoteAdditions = Math.max(0, (remoteCounts.get(line) ?? 0) - before);
    expect(mergedCounts.get(line) ?? 0).toBeGreaterThanOrEqual(Math.max(candidateAdditions, remoteAdditions));
  }
}

const fixtures = JSON.parse(
  await readFile(join(import.meta.dir, "../../fixtures/overstoryd/merge.json"), "utf8"),
) as MergeFixtures;

describe("reference host merge fixtures", () => {
  test("disjoint row changes merge by row", async () => {
    const { result, rows } = await mergeItems(
      itemsSnapshot(SCHEMA, [idRow("a", { title: "A" }), idRow("b", { title: "B" })]),
      itemsSnapshot(SCHEMA, [idRow("a", { title: "Candidate A" }, T0, T1), idRow("b", { title: "B" })]),
      itemsSnapshot(SCHEMA, [idRow("a", { title: "A" }), idRow("b", { title: "Remote B" }, T0, T1)]),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toEqual({ version: "collection-fields-v1", mergedRows: 1 });
    expect(await rows()).toEqual([idRow("a", { title: "Candidate A" }, T0, T1), idRow("b", { title: "Remote B" }, T0, T1)]);
  });

  test("one field set differently on both sides is a field conflict that keeps current's value", async () => {
    const { result, rows } = await mergeItems(
      itemsSnapshot(SCHEMA, [idRow("a", { title: "A" })]),
      itemsSnapshot(SCHEMA, [idRow("a", { title: "Candidate" }, T0, T1)]),
      itemsSnapshot(SCHEMA, [idRow("a", { title: "Remote" }, T0, T1)]),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.fields).toEqual([{ path: "/items", table: "Item", row: '[["id","a"]]', field: "title", current: "Remote", candidate: "Candidate" }]);
    expect((await rows()).map((row) => row.fields)).toEqual([{ title: "Remote" }]);
  });

  test("one row merges field by field and member by member", async () => {
    const schema = "model Item {\n  title Text\n  done Bool?\n  tags Text[]\n  steps ordered Text[]\n  notes Markdown?\n}\n";
    const a = (fields: LogicalRow["fields"], modified = T1) => idRow("a", { title: "A", ...fields }, T0, modified);
    const b = idRow("b", { title: "B" });
    const { result, rows } = await mergeItems(
      itemsSnapshot(schema, [a({ tags: ["x", "y"], steps: ["1", "2", "3"], notes: "one\ntwo\nthree\n" }, T0), b]),
      itemsSnapshot(schema, [a({ title: "Alpha", tags: ["c", "x"], steps: ["3", "1", "2"], notes: "ONE\ntwo\nthree\n" }), b]),
      itemsSnapshot(schema, [a({ done: true, tags: ["r", "y"], steps: ["1", "2", "3", "4"], notes: "one\ntwo\nTHREE\n" }, T2), b]),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.fields).toBeUndefined();
    expect(result.summary).toEqual({ version: "collection-fields-v1", mergedRows: 1 });
    expect((await rows())[0]).toEqual(a({ title: "Alpha", done: true, tags: ["c", "r"], steps: ["3", "4", "1", "2"], notes: "ONE\ntwo\nTHREE\n" }, T2));
  });

  test("row times never conflict: created keeps current's and modified takes the later", async () => {
    const { result, rows } = await mergeItems(
      itemsSnapshot(SCHEMA, [idRow("a", { title: "A" })]),
      itemsSnapshot(SCHEMA, [idRow("a", { title: "A" }, T0, T2)]),
      itemsSnapshot(SCHEMA, [idRow("a", { title: "Remote" }, T0, T1)]),
    );
    expect(result.fields).toBeUndefined();
    expect(await rows()).toEqual([idRow("a", { title: "Remote" }, T0, T2)]);
  });

  test("reordering an ordered field on both sides, or deleting a row the other side changed, conflicts", async () => {
    const schema = "model Item {\n  title Text\n  steps ordered Text[]\n}\n";
    const { result, rows } = await mergeItems(
      itemsSnapshot(schema, [idRow("a", { title: "A", steps: ["1", "2", "3"] }), idRow("b", { title: "B" })]),
      itemsSnapshot(schema, [idRow("a", { title: "A", steps: ["2", "1", "3"] }, T0, T1)]),
      itemsSnapshot(schema, [idRow("a", { title: "A", steps: ["1", "3", "2"] }, T0, T1), idRow("b", { title: "Bee" }, T0, T1)]),
    );
    expect(result.fields).toEqual([
      { path: "/items", table: "Item", row: '[["id","a"]]', field: "steps", current: ["1", "3", "2"], candidate: ["2", "1", "3"] },
      { path: "/items", table: "Item", row: '[["id","b"]]', field: null, current: { id: "b", title: "Bee" }, candidate: null },
    ]);
    expect((await rows()).map((row) => row.fields)).toEqual([{ title: "A", steps: ["1", "3", "2"] }, { title: "Bee" }]);
  });

  test("a schema change on one side and row edits on the other keep candidate's collection with a conflict", async () => {
    const { result } = await mergeItems(
      itemsSnapshot(SCHEMA, [idRow("a", { title: "A" })]),
      itemsSnapshot("model Item {\n  title Text\n  done Bool?\n}\n", [idRow("a", { title: "A" })]),
      itemsSnapshot(SCHEMA, [idRow("a", { title: "Remote" }, T0, T1)]),
    );
    expect(result.conflicts).toEqual([{ path: "/items", reason: "collection-schema-conflict" }]);
  });

  for (const fixture of fixtures.markdownCases) {
    test(fixture.name, async () => {
      const objects = new Map<string, Uint8Array>();
      const base = markdownSnapshot(fixture.base, objects);
      const candidate = markdownSnapshot(fixture.candidate, objects);
      const remote = markdownSnapshot(fixture.remote, objects);
      const { result, source } = await mergedSource({ base: base.root, candidate: candidate.root, remote: remote.root }, objects);
      const repeated = await mergedSource({ base: base.root, candidate: candidate.root, remote: remote.root }, objects);

      expect(result.conflicts).toEqual(fixture.expected.conflicts);
      expect(repeated.result.root).toBe(result.root);
      expect(repeated.result.summary).toEqual(result.summary);
      expect(repeated.result.conflicts).toEqual(result.conflicts);
      expect(repeated.source).toBe(source);
      expectNoAddedLineOmitted(fixture.base, fixture.candidate, fixture.remote, source);
      if (fixture.expected.approximatePlacements !== undefined) {
        if (fixture.expected.approximatePlacements === 0 && !result.summary) {
          // Disjoint nodes merge without a rule and carry no summary.
        } else {
          expect(result.summary?.version).toBe("markdown-additive-v1");
          if (result.summary?.version === "markdown-additive-v1") {
            expect(result.summary.approximatePlacements).toBe(fixture.expected.approximatePlacements);
          }
        }
      }
      for (const value of fixture.expected.contains ?? []) expect(source).toContain(value);
      for (const value of fixture.expected.absent ?? []) expect(source).not.toContain(value);
      for (const [before, after] of fixture.expected.ordered ?? []) {
        expect(source.indexOf(before)).toBeGreaterThanOrEqual(0);
        expect(source.indexOf(before)).toBeLessThan(source.indexOf(after));
      }
      for (const [value, count] of Object.entries(fixture.expected.counts ?? {})) {
        expect(occurrences(source, value)).toBe(count);
      }
    });
  }

  for (const fixture of fixtures.pageMoveCases) {
    test(fixture.name, async () => {
      const objects = new Map<string, Uint8Array>();
      const base = namedMarkdownSnapshot(fixture.base.name, fixture.base.source, objects);
      const candidate = namedMarkdownSnapshot(fixture.candidate.name, fixture.candidate.source, objects);
      const remote = namedMarkdownSnapshot(fixture.remote.name, fixture.remote.source, objects);
      const { result, name, source } = await mergedPage({ base: base.root, candidate: candidate.root, remote: remote.root }, objects);
      const repeated = await mergedPage({ base: base.root, candidate: candidate.root, remote: remote.root }, objects);
      expect(result.conflicts).toEqual(fixture.expected.conflicts);
      expect(repeated.result.root).toBe(result.root);
      expect(repeated.result.conflicts).toEqual(result.conflicts);
      expect(repeated.name).toBe(name);
      expect(repeated.source).toBe(source);
      expect(name).toBe(fixture.expected.name);
      for (const value of fixture.expected.contains ?? []) expect(source).toContain(value);
      if (!fixture.expected.conflicts.length) {
        expectNoAddedLineOmitted(fixture.base.source, fixture.candidate.source, fixture.remote.source, source);
      }
    });
  }

  for (const fixture of fixtures.structuralCases) {
    test(fixture.name, async () => {
      const objects = new Map<string, Uint8Array>();
      let base: string;
      let candidate: string;
      let remote: string;
      if (fixture.kind === "binary") {
        const file = (value: string) => stored({ type: "file", bytes: Buffer.from(value, "base64") }, objects);
        base = root([{ name: "asset.bin", file: file(fixture.baseBase64) }], objects);
        candidate = root([{ name: "asset.bin", file: file(fixture.candidateBase64) }], objects);
        remote = root([{ name: "asset.bin", file: file(fixture.remoteBase64) }], objects);
      } else if (fixture.kind === "nested-boundary") {
        base = root([{ name: "nested", tree: fixture.baseTree }], objects);
        candidate = root([{ name: "nested", tree: fixture.candidateTree }], objects);
        remote = root([{ name: "nested", tree: fixture.remoteTree }], objects);
      } else {
        const baseFile = stored({ type: "file", bytes: new TextEncoder().encode("base") }, objects);
        const remoteFile = stored({ type: "file", bytes: new TextEncoder().encode("remote") }, objects);
        const candidateDirectory = root([], objects);
        base = root([{ name: "item", file: baseFile }], objects);
        candidate = root([{ name: "item", directory: candidateDirectory }], objects);
        remote = root([{ name: "item", file: remoteFile }], objects);
      }
      const result = await mergeProtocolTrees(base, candidate, remote, async (hash) => {
        const bytes = objects.get(hash);
        if (!bytes) throw new Error(`Missing fixture object ${hash}`);
        return bytes;
      });
      expect(result.conflicts).toEqual(fixture.expected.conflicts);
    });
  }

  test("Markdown line merge conflicts rather than diffing past its budget", async () => {
    const lines = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix} ${i}\n`).join("");
    // Under 256 KiB, but a 5000 x 5000 line table exceeds the diff budget.
    for (const [base, candidate, remote] of [
      [lines("base", 5000), lines("candidate", 5000), lines("base", 5000) + "remote\n"],
      // Over the byte budget before any diff.
      ["x".repeat(300 * 1024), "y", "z"],
    ] as const) {
      const objects = new Map<string, Uint8Array>();
      const roots = {
        base: markdownSnapshot(base, objects).root,
        candidate: markdownSnapshot(candidate, objects).root,
        remote: markdownSnapshot(remote, objects).root,
      };
      const { result, source } = await mergedSource(roots, objects);
      expect(result.conflicts).toEqual([{ path: "/note.md", reason: "node-conflict" }]);
      expect(source).toBe(candidate);
    }
    // Within budget the same shape still merges line by line.
    const objects = new Map<string, Uint8Array>();
    const { result, source } = await mergedSource({
      base: markdownSnapshot(lines("base", 100), objects).root,
      candidate: markdownSnapshot(lines("base", 100) + "candidate\n", objects).root,
      remote: markdownSnapshot("remote\n" + lines("base", 100), objects).root,
    }, objects);
    expect(result.conflicts).toEqual([]);
    expect(source).toBe("remote\n" + lines("base", 100) + "candidate\n");
  });
});
