import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  changedPaths,
  compareWireNames,
  decodeCBOR,
  decodeWireObject,
  encodeCanonicalCBOR,
  encodeWireObject,
  hashObject,
  materializeTree,
  snapshotDirectory,
} from "@arbor/wire";
import { ProjectionProviderHost, decodeWireFileRollup, SchemaSandbox } from "@arbor/stores";

describe("canonical tree objects", () => {
  test("matches the language-neutral canonical object vectors", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../conformance/wire-objects.json"), "utf8")) as {
      objects: Array<{
        model: { type: "file"; bytesBase64: string } | {
          type: "directory";
          entries: Array<{ name: string; hash?: string; tree?: string; rollup?: import("@arbor/core").RollupDescriptor }>;
        };
        canonicalCborBase64: string;
        hash: string;
      }>;
    };
    for (const vector of fixture.objects) {
      const object = vector.model.type === "file"
        ? { type: "file" as const, bytes: Uint8Array.from(Buffer.from(vector.model.bytesBase64, "base64")) }
        : vector.model;
      const bytes = encodeWireObject(object);
      expect(Buffer.from(bytes).toString("base64")).toBe(vector.canonicalCborBase64);
      expect(hashObject(bytes)).toBe(vector.hash);
    }
  });

  test("keeps strict invalid object bytes as language-neutral vectors", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../conformance/wire-objects.json"), "utf8")) as {
      invalid: Array<{ name: string; canonicalCborBase64: string }>;
    };
    expect(fixture.invalid.map((item) => item.name)).toEqual([
      "unsorted-directory",
      "duplicate-name",
      "dual-target",
      "noncanonical-cbor",
    ]);
    for (const vector of fixture.invalid) {
      expect(() => decodeWireObject(Buffer.from(vector.canonicalCborBase64, "base64"))).toThrow();
    }
  });

  test("can traverse retained pre-foundation directory order only when explicitly requested", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../conformance/wire-objects.json"), "utf8")) as {
      invalid: Array<{ name: string; canonicalCborBase64: string }>;
    };
    const vector = fixture.invalid.find(({ name }) => name === "unsorted-directory")!;
    const bytes = Buffer.from(vector.canonicalCborBase64, "base64");
    expect(() => decodeWireObject(bytes)).toThrow("Directory entries are not in UTF-8 order");
    expect(decodeWireObject(bytes, { allowLegacyDirectoryOrder: true })).toEqual({
      type: "directory",
      entries: [
        { name: "z", hash: `sha256:${"0".repeat(64)}` },
        { name: "A", hash: `sha256:${"0".repeat(64)}` },
      ],
    });
  });

  test("encodes maps deterministically and hashes exact DAG-CBOR bytes", () => {
    const left = encodeCanonicalCBOR({ z: 1, a: { y: true, x: "value" } });
    const right = encodeCanonicalCBOR({ a: { x: "value", y: true }, z: 1 });
    expect(left).toEqual(right);
    expect(hashObject(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("orders directory names by UTF-8 bytes rather than locale", () => {
    expect(["ä", "z", "A"].sort(compareWireNames)).toEqual(["A", "z", "ä"]);
  });

  test("rejects hostile, duplicate, non-canonical, and excessively deep CBOR", () => {
    const prototypeKey = Uint8Array.from([0xa1, 0x69, 0x5f, 0x5f, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x5f, 0x5f, 0xa0]);
    const decoded = decodeCBOR(prototypeKey) as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(decoded.type).toBeUndefined();
    expect(() => decodeCBOR(Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])))
      .toThrow("Duplicate CBOR map key");
    expect(() => decodeCBOR(Uint8Array.from([0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02])))
      .toThrow("Non-canonical CBOR map key order");
    let deep = Uint8Array.of(0x00);
    for (let index = 0; index < 70; index += 1) deep = Uint8Array.from([0x81, ...deep]);
    expect(() => decodeCBOR(deep)).toThrow("CBOR nesting too deep");
  });

  test("snapshots files once and represents nested trees as boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-wire-objects-"));
    try {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "note.md"), "# Note\n");
      await writeFile(join(root, "nested", "private.md"), "private\n");
      const snapshot = await snapshotDirectory(root, new Map([[join(root, "nested"), "tr_child"]]));
      const object = decodeWireObject(snapshot.objects.get(snapshot.root)!);
      expect(object).toEqual({
        type: "directory",
        entries: [
          { name: "nested", tree: "tr_child" },
          expect.objectContaining({ name: "note.md", hash: expect.stringMatching(/^sha256:/) }),
        ],
      });
      expect(snapshot.objects.size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("snapshots exact file rollups as source-and-schema reachable targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-wire-rollup-"));
    const destination = await mkdtemp(join(tmpdir(), "arbor-wire-rollup-materialized-"));
    try {
      const schemaSource = "export const schema = z.object({ id: z.string() });\nexport const primaryKey = [\"id\"];\n";
      const storeSource = "[{\"id\":\"one\"}]\n";
      await writeFile(join(root, "schema.ts"), schemaSource);
      await writeFile(join(root, "_store.json"), storeSource);
      const snapshot = await snapshotDirectory(root, new Map(), [], async (_directory, sourceName) => ({
        codec: sourceName === "_store.json" ? "json" : "csv",
        schema: `sha256:${"3".repeat(64)}`,
        scope: "children",
        modelDigest: `sha256:${"4".repeat(64)}`,
      }));
      const object = decodeWireObject(snapshot.objects.get(snapshot.root)!);
      if (object.type !== "directory") throw new Error("Expected a directory");
      const descriptor = object.entries.find((entry) => entry.name === "_store.json")?.rollup;
      expect(descriptor).toEqual(expect.objectContaining({ codec: "json", scope: "children" }));
      expect(descriptor?.source).not.toBe(descriptor?.schemaSource);
      expect(decodeWireObject(snapshot.objects.get(descriptor!.source)!)).toEqual({
        type: "file",
        bytes: new TextEncoder().encode(storeSource),
      });
      expect(decodeWireObject(snapshot.objects.get(descriptor!.schemaSource)!)).toEqual({
        type: "file",
        bytes: new TextEncoder().encode(schemaSource),
      });

      await materializeTree(destination, snapshot.root, async (hash) => snapshot.objects.get(hash)!);
      expect(await readFile(join(destination, "_store.json"), "utf8")).toBe(storeSource);
      expect(await readFile(join(destination, "schema.ts"), "utf8")).toBe(schemaSource);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("executes schema.ts and verifies CSV, JSON, and JSONL Wire descriptors", async () => {
    const fixtures = {
      csv: "id,title\none,One\ntwo,Two\n",
      json: '[{"id":"one","title":"One"},{"id":"two","title":"Two"}]\n',
      jsonl: '{"id":"one","title":"One"}\n{"id":"two","title":"Two"}\n',
    } as const;
    for (const [codec, source] of Object.entries(fixtures) as Array<[keyof typeof fixtures, string]>) {
      const root = await mkdtemp(join(tmpdir(), `arbor-wire-${codec}-`));
      const collections = new ProjectionProviderHost();
      const schemas = new SchemaSandbox();
      try {
        await writeFile(join(root, "schema.ts"), [
          'import { z } from "zod";',
          'export const schema = z.object({ id: z.string(), title: z.string() });',
          'export const primaryKey = ["id"];',
          "",
        ].join("\n"));
        await writeFile(join(root, `_store.${codec}`), source);
        const snapshot = await snapshotDirectory(root, new Map(), [], (directory, name) =>
          collections.fileRollupDescriptor(directory, name));
        const object = decodeWireObject(snapshot.objects.get(snapshot.root)!);
        if (object.type !== "directory") throw new Error("Expected a rollup directory");
        const descriptor = object.entries.find((entry) => entry.rollup)?.rollup!;
        const sourceObject = decodeWireObject(snapshot.objects.get(descriptor.source)!);
        const schemaObject = decodeWireObject(snapshot.objects.get(descriptor.schemaSource)!);
        if (sourceObject.type !== "file" || schemaObject.type !== "file") throw new Error("Expected rollup files");
        const decoded = await decodeWireFileRollup(descriptor, sourceObject.bytes, schemaObject.bytes, schemas);
        expect(decoded.rows.map((row) => row.properties), codec).toEqual([
          { id: "one", title: "One" },
          { id: "two", title: "Two" },
        ]);
      } finally {
        await schemas[Symbol.asyncDispose]();
        await collections[Symbol.asyncDispose]();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("finds changed paths without walking unchanged branches", async () => {
    const fileA = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("a") });
    const fileB = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("b") });
    const hashA = hashObject(fileA);
    const hashB = hashObject(fileB);
    const before = encodeWireObject({ type: "directory", entries: [{ name: "note.md", hash: hashA }] });
    const after = encodeWireObject({ type: "directory", entries: [{ name: "note.md", hash: hashB }] });
    const beforeHash = hashObject(before);
    const afterHash = hashObject(after);
    const objects = new Map([[hashA, fileA], [hashB, fileB], [beforeHash, before], [afterHash, after]]);
    expect(await changedPaths(beforeHash, afterHash, async (hash) => objects.get(hash)!)).toEqual(["/note.md"]);
  });

  test("materialization leaves byte-identical authored files untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-materialize-identical-"));
    try {
      const path = join(root, "note.md");
      await writeFile(path, "same bytes\n");
      const fixed = new Date("2024-01-01T00:00:00.000Z");
      await utimes(path, fixed, fixed);
      const before = await stat(path);
      const snapshot = await snapshotDirectory(root);

      await materializeTree(root, snapshot.root, async (hash) => snapshot.objects.get(hash)!);

      const after = await stat(path);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(path, "utf8")).toBe("same bytes\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps reader-local mounts out of snapshots and pull deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-reader-layout-"));
    try {
      const mounted = join(root, "friends");
      await mkdir(mounted, { recursive: true });
      await writeFile(join(root, "parent.md"), "# Parent\n");
      await writeFile(join(mounted, "private-layout.md"), "# Mounted elsewhere\n");

      const snapshot = await snapshotDirectory(root, new Map(), [mounted]);
      const rootObject = decodeWireObject(snapshot.objects.get(snapshot.root)!);
      expect(rootObject.type).toBe("directory");
      if (rootObject.type !== "directory") throw new Error("Expected a directory");
      expect(rootObject.entries.map((entry) => entry.name)).toEqual(["parent.md"]);

      await materializeTree(root, snapshot.root, async (hash) => snapshot.objects.get(hash)!, undefined, [mounted]);
      expect(await readFile(join(mounted, "private-layout.md"), "utf8")).toContain("Mounted elsewhere");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
