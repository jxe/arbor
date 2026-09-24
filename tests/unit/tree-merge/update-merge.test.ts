import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeProtocolTrees } from "@overstory/tree-merge";
import { ProjectionProviderHost } from "@overstory/arborsync/state";
import { decodeProtocolCollectionFile } from "@overstory/collection-schema";
import {
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  type TreeSnapshot,
  type UpdateConflict,
  type ProtocolDirectoryEntry,
  type ProtocolDirectory,
} from "@overstory/protocol";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";

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

const JSON_SCHEMA = 'overstory-schema-version = 1\noverstory-primary-key = ["id"]\nrow = { id: tstr, title: tstr }\n';

async function jsonCollectionFileSnapshot(rows: unknown[]): Promise<TreeSnapshot> {
  return collectionFileSnapshot("_store.json", JSON_SCHEMA, `${JSON.stringify(rows, null, 2)}\n`);
}

async function collectionFileSnapshot(store: string, schema: string, source: string): Promise<TreeSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "arbor-collection-file-merge-"));
  const collections = new ProjectionProviderHost();
  try {
    await writeFile(join(directory, "schema.cddl"), schema);
    await writeFile(join(directory, store), source);
    return await resolveSnapshot(await snapshotDirectory(directory, new Map(), [], (root, name) => collections.collectionFileDescriptor(root, name)));
  } finally {
    await collections[Symbol.asyncDispose]();
    await rm(directory, { recursive: true, force: true });
  }
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
  await readFile(join(import.meta.dir, "../../fixtures/canopy/merge.json"), "utf8"),
) as MergeFixtures;

describe("reference Canopy merge fixtures", () => {
  test("disjoint stable-row changes merge semantically", async () => {
    const [base, candidate, remote] = await Promise.all([
      jsonCollectionFileSnapshot([{ id: "a", title: "A" }, { id: "b", title: "B" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "Candidate A" }, { id: "b", title: "B" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "A" }, { id: "b", title: "Remote B" }]),
    ]);
    const objects = new Map([...base.objects, ...candidate.objects, ...remote.objects]);
    const result = await mergeProtocolTrees(base.root, candidate.root, remote.root, async (hash) => objects.get(hash)!);
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toEqual({ version: "collection-file-rows-v1", mergedRows: 1 });
    const load = (hash: string) => result.objects.get(hash) ?? objects.get(hash)!;
    const rootObject = decodeProtocolDirectory(load(result.root));
    if (rootObject.type !== "directory") throw new Error("Expected collection-file root");
    const descriptor = rootObject.childrenSource!;
    const source = load(rootObject.entries.find((entry) => entry.name === descriptor.source)!.file!);
    const schema = load(rootObject.entries.find((entry) => entry.name === descriptor.schemaSource)!.file!);
    const decoded = decodeProtocolCollectionFile(descriptor, source, schema);
    expect(decoded.rows.map((row) => row.properties)).toEqual([
      { id: "a", title: "Candidate A" },
      { id: "b", title: "Remote B" },
    ]);
  });

  test("typed CSV rows merge and re-encode through their declared column types", async () => {
    const schema = 'overstory-schema-version = 1\noverstory-primary-key = ["id"]\nrow = { id: tstr, count: int, ? note: tstr }\n';
    const [base, candidate, remote] = await Promise.all([
      collectionFileSnapshot("_store.csv", schema, "id,count,note\n001,1,\n002,2,x\n"),
      collectionFileSnapshot("_store.csv", schema, "id,count,note\n001,10,\n002,2,x\n"),
      collectionFileSnapshot("_store.csv", schema, "id,count,note\n001,1,\n002,2,y\n"),
    ]);
    const objects = new Map([...base.objects, ...candidate.objects, ...remote.objects]);
    const result = await mergeProtocolTrees(base.root, candidate.root, remote.root, async (hash) => objects.get(hash)!);
    expect(result.conflicts).toEqual([]);
    const load = (hash: string) => result.objects.get(hash) ?? objects.get(hash)!;
    const rootObject = decodeProtocolDirectory(load(result.root));
    if (rootObject.type !== "directory") throw new Error("Expected collection-file root");
    const descriptor = rootObject.childrenSource!;
    const sourceBytes = load(rootObject.entries.find((entry) => entry.name === descriptor.source)!.file!);
    expect(new TextDecoder().decode(sourceBytes)).toBe("id,count,note\n001,10,\n002,2,y\n");
    const decoded = decodeProtocolCollectionFile(descriptor, sourceBytes, load(rootObject.entries.find((entry) => entry.name === "schema.cddl")!.file!));
    expect(decoded.rows.map((row) => row.properties)).toEqual([{ id: "001", count: 10 }, { id: "002", count: 2, note: "y" }]);
  });

  test("a merge involving a retired version-1 collection is a schema conflict, never an evaluation", async () => {
    const objects = new Map<string, Uint8Array>();
    const legacy = (title: string) => {
      const source = stored({ type: "file", bytes: new TextEncoder().encode(`[{"id":"a","title":"${title}"}]\n`) }, objects);
      const schema = stored({ type: "file", bytes: new TextEncoder().encode('import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"];\n') }, objects);
      return stored({
        type: "directory",
        entries: [{ name: "_store.json", file: source }, { name: "schema.ts", file: schema }],
        childrenSource: {
          version: 1, type: "collection-file", format: "json", source: "_store.json", schemaSource: "schema.ts",
          schemaFingerprint: schema as `sha256:${string}`, childSetHash: source as `sha256:${string}`,
        },
      }, objects);
    };
    const result = await mergeProtocolTrees(legacy("A"), legacy("Candidate"), legacy("Remote"), async (hash) => objects.get(hash)!);
    expect(result.conflicts).toEqual([expect.objectContaining({ reason: "collection-file-schema-conflict" })]);
  });

  test("divergent changes to one stable row conflict", async () => {
    const [base, candidate, remote] = await Promise.all([
      jsonCollectionFileSnapshot([{ id: "a", title: "A" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "Candidate" }]),
      jsonCollectionFileSnapshot([{ id: "a", title: "Remote" }]),
    ]);
    const objects = new Map([...base.objects, ...candidate.objects, ...remote.objects]);
    const result = await mergeProtocolTrees(base.root, candidate.root, remote.root, async (hash) => objects.get(hash)!);
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
