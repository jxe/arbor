import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  mergeWireTrees,
  type TreeSnapshot,
  type UpdateConflict,
  type WireDirectoryEntry,
  type WireObject,
} from "@arbor/wire";

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

interface ReplayCase {
  name: string;
  idempotencyKey: string;
  sameIntent: boolean;
  expected: { sameStatus?: boolean; sameBody?: boolean; error?: string; additionalAcceptedUpdates: number };
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
  replayCases: ReplayCase[];
}

function stored(object: WireObject, objects: Map<string, Uint8Array>): string {
  const bytes = encodeWireObject(object);
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
}

function root(entries: WireDirectoryEntry[], objects: Map<string, Uint8Array>): string {
  return stored({ type: "directory", entries }, objects);
}

function markdownSnapshot(source: string, objects: Map<string, Uint8Array>): TreeSnapshot {
  return namedMarkdownSnapshot("note.md", source, objects);
}

function namedMarkdownSnapshot(name: string, source: string, objects: Map<string, Uint8Array>): TreeSnapshot {
  const file = stored({ type: "file", bytes: new TextEncoder().encode(source) }, objects);
  return { root: root([{ name, hash: file }], objects), objects };
}

async function mergedSource(
  roots: { base: string; candidate: string; remote: string },
  objects: Map<string, Uint8Array>,
) {
  const result = await mergeWireTrees(roots.base, roots.candidate, roots.remote, async (hash) => {
    const bytes = objects.get(hash);
    if (!bytes) throw new Error(`Missing fixture object ${hash}`);
    return bytes;
  });
  const load = (hash: string) => result.objects.get(hash) ?? objects.get(hash);
  const directoryBytes = load(result.root);
  if (!directoryBytes) throw new Error("Missing merged root");
  const directory = decodeWireObject(directoryBytes);
  if (directory.type !== "directory") throw new Error("Expected merged directory");
  const note = directory.entries.find((entry) => entry.name === "note.md")?.hash;
  if (!note) throw new Error("Expected merged note.md");
  const fileBytes = load(note);
  if (!fileBytes) throw new Error("Missing merged Markdown object");
  const file = decodeWireObject(fileBytes);
  if (file.type !== "file") throw new Error("Expected merged Markdown file");
  return { result, source: new TextDecoder().decode(file.bytes) };
}

async function mergedPage(
  roots: { base: string; candidate: string; remote: string },
  objects: Map<string, Uint8Array>,
) {
  const result = await mergeWireTrees(roots.base, roots.candidate, roots.remote, async (hash) => {
    const bytes = objects.get(hash);
    if (!bytes) throw new Error(`Missing fixture object ${hash}`);
    return bytes;
  });
  const load = (hash: string) => result.objects.get(hash) ?? objects.get(hash);
  const directoryBytes = load(result.root);
  if (!directoryBytes) throw new Error("Missing merged root");
  const directory = decodeWireObject(directoryBytes);
  if (directory.type !== "directory" || directory.entries.length !== 1) throw new Error("Expected one merged page");
  const entry = directory.entries[0]!;
  if (!entry.hash) throw new Error("Expected a Markdown hash");
  const fileBytes = load(entry.hash);
  if (!fileBytes) throw new Error("Missing merged page");
  const file = decodeWireObject(fileBytes);
  if (file.type !== "file") throw new Error("Expected a Markdown file");
  return { result, name: entry.name, source: new TextDecoder().decode(file.bytes) };
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
  await readFile(join(import.meta.dir, "../../spec/fixtures/wire-merge.json"), "utf8"),
) as MergeFixtures;

describe("language-neutral authority merge fixtures", () => {
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
        expect(result.summary.approximatePlacements).toBe(fixture.expected.approximatePlacements);
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
        base = root([{ name: "asset.bin", hash: file(fixture.baseBase64) }], objects);
        candidate = root([{ name: "asset.bin", hash: file(fixture.candidateBase64) }], objects);
        remote = root([{ name: "asset.bin", hash: file(fixture.remoteBase64) }], objects);
      } else if (fixture.kind === "nested-boundary") {
        base = root([{ name: "nested", tree: fixture.baseTree }], objects);
        candidate = root([{ name: "nested", tree: fixture.candidateTree }], objects);
        remote = root([{ name: "nested", tree: fixture.remoteTree }], objects);
      } else {
        const baseFile = stored({ type: "file", bytes: new TextEncoder().encode("base") }, objects);
        const remoteFile = stored({ type: "file", bytes: new TextEncoder().encode("remote") }, objects);
        const candidateDirectory = root([], objects);
        base = root([{ name: "item", hash: baseFile }], objects);
        candidate = root([{ name: "item", hash: candidateDirectory }], objects);
        remote = root([{ name: "item", hash: remoteFile }], objects);
      }
      const result = await mergeWireTrees(base, candidate, remote, async (hash) => {
        const bytes = objects.get(hash);
        if (!bytes) throw new Error(`Missing fixture object ${hash}`);
        return bytes;
      });
      expect(result.conflicts).toEqual(fixture.expected.conflicts);
    });
  }

  test("publishes exact replay vectors for every wire client", () => {
    expect(fixtures.replayCases).toEqual(expect.arrayContaining([
      expect.objectContaining({ sameIntent: true, expected: expect.objectContaining({ sameBody: true, additionalAcceptedUpdates: 0 }) }),
      expect.objectContaining({ sameIntent: false, expected: expect.objectContaining({ error: "mutation-mismatch", additionalAcceptedUpdates: 0 }) }),
    ]));
    expect(new Set(fixtures.replayCases.map((fixture) => fixture.idempotencyKey)).size).toBe(fixtures.replayCases.length);
  });
});
