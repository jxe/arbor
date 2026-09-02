import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeWireTrees } from "@arbor/canopy";
import { ProjectionProviderHost, decodeWireCollectionFile, SchemaSandbox } from "@arbor/stores";
import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type TreeSnapshot,
  type UpdateConflict,
  type WireDirectoryEntry,
  type WireObject,
} from "@arbor/wire";
import { snapshotDirectory } from "@arbor/fs";

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

async function jsonCollectionFileSnapshot(rows: unknown[]): Promise<TreeSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "arbor-collection-file-merge-"));
  const collections = new ProjectionProviderHost();
  try {
    await writeFile(join(directory, "schema.ts"), `
      import { z } from "zod";
      export const schema = z.object({ id: z.string(), title: z.string() });
      export const primaryKey = ["id"];
    `);
    await writeFile(join(directory, "_store.json"), `${JSON.stringify(rows, null, 2)}\n`);
    return await snapshotDirectory(directory, new Map(), [], (root, name) => collections.collectionFileDescriptor(root, name));
  } finally {
    await collections[Symbol.asyncDispose]();
    await rm(directory, { recursive: true, force: true });
  }
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
  await readFile(join(import.meta.dir, "../../fixtures/canopy/wire-merge.json"), "utf8"),
) as MergeFixtures;

describe("reference Canopy merge fixtures", () => {
  test("disjoint stable-row changes merge semantically", async () => {
    const [base, candidate, remote] = await Promise.all([
      jsonCollectionFileSnapshot([{ id: "a", title: "A" }, { id: "b", title: "B" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "Candidate A" }, { id: "b", title: "B" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "A" }, { id: "b", title: "Remote B" }]),
    ]);
    const objects = new Map([...base.objects, ...candidate.objects, ...remote.objects]);
    const result = await mergeWireTrees(base.root, candidate.root, remote.root, async (hash) => objects.get(hash)!);
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toEqual({ version: "collection-file-rows-v1", mergedRows: 1 });
    const load = (hash: string) => result.objects.get(hash) ?? objects.get(hash)!;
    const rootObject = decodeWireObject(load(result.root));
    if (rootObject.type !== "directory") throw new Error("Expected collection-file root");
    const descriptor = rootObject.childrenSource!;
    const source = decodeWireObject(load(rootObject.entries.find((entry) => entry.name === descriptor.source)!.hash!));
    const schema = decodeWireObject(load(rootObject.entries.find((entry) => entry.name === descriptor.schemaSource)!.hash!));
    if (source.type !== "file" || schema.type !== "file") throw new Error("Expected collection files");
    const sandbox = new SchemaSandbox();
    try {
      const decoded = await decodeWireCollectionFile(descriptor, source.bytes, schema.bytes, sandbox);
      expect(decoded.rows.map((row) => row.properties)).toEqual([
        { id: "a", title: "Candidate A" },
        { id: "b", title: "Remote B" },
      ]);
    } finally {
      await sandbox[Symbol.asyncDispose]();
    }
  });

  test("divergent changes to one stable row conflict", async () => {
    const [base, candidate, remote] = await Promise.all([
      jsonCollectionFileSnapshot([{ id: "a", title: "A" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "Candidate" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "Remote" }]),
    ]);
    const objects = new Map([...base.objects, ...candidate.objects, ...remote.objects]);
    const result = await mergeWireTrees(base.root, candidate.root, remote.root, async (hash) => objects.get(hash)!);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ reason: "collection-file-row-conflict" }),
    ]);
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

});
