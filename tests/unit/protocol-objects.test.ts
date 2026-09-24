import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareProtocolNames,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
} from "@overstory/protocol";
import { canonicalCBORHash, decodeCBOR, encodeCanonicalCBOR } from "@overstory/protocol";
import { ProjectionProviderHost, ObjectIndex } from "@overstory/arborsync/state";
import { decodeProtocolCollectionFile } from "@overstory/collection-schema";
import { materializeTree, resolveSnapshot, snapshotDirectory, type SnapshotObjectIndex } from "@overstory/fs";

function objectIndexOf(index: ObjectIndex): SnapshotObjectIndex {
  return {
    fileHash: (absolute, info) => index.objectRow(absolute, info)?.hash,
    remember: (absolute, kind, info, hash) => index.rememberObject(absolute, kind, info, hash),
  };
}

describe("lazy snapshots and the object index", () => {
  async function fixture(prefix: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "note.md"), "# Note\n");
    await writeFile(join(root, "nested", "photo.bin"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    await writeFile(join(root, "nested", "deep.md"), "deep\n");
    const index = new ObjectIndex(join(root, "index.sqlite"));
    return { root, index, exclusions: [join(root, "index.sqlite"), join(root, "index.sqlite-wal"), join(root, "index.sqlite-shm")] };
  }

  test("the lazy root equals the eager root and loads identical bytes", async () => {
    const { root, index, exclusions } = await fixture("arbor-lazy-root-");
    try {
      const lazy = await snapshotDirectory(root, new Map(), exclusions);
      const eager = await resolveSnapshot(await snapshotDirectory(root, new Map(), exclusions));
      expect(lazy.root).toBe(eager.root);
      expect([...lazy.objects.keys()].sort()).toEqual([...eager.objects.keys()].sort());
      for (const [hash, source] of lazy.objects) {
        expect(source.hash).toBe(hash);
        expect(Buffer.from(await source.bytes()).equals(Buffer.from(eager.objects.get(hash)!))).toBe(true);
        expect(hashObject(await source.bytes())).toBe(hash);
      }
    } finally {
      index.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second walk with the index reads no non-Markdown file", async () => {
    const { root, index, exclusions } = await fixture("arbor-lazy-index-");
    try {
      const first = await snapshotDirectory(root, new Map(), exclusions, undefined, objectIndexOf(index));
      const photo = join(root, "nested", "photo.bin");
      const note = join(root, "note.md");
      const photoHash = hashObject(await readFile(photo));
      expect(index.objectRow(photo, await stat(photo, { bigint: true }))?.hash).toBe(photoHash);
      // Plant rows with wrong hashes under the current stat tuples: a walk that
      // trusts the row reproduces the planted hash, a walk that reads does not.
      const planted = "sha256:" + "ab".repeat(32);
      index.rememberObject(photo, "file", await stat(photo, { bigint: true }), planted);
      index.rememberObject(note, "file", await stat(note, { bigint: true }), planted);
      const second = await snapshotDirectory(root, new Map(), exclusions, undefined, objectIndexOf(index));
      expect(second.root).not.toBe(first.root);
      expect(second.objects.has(planted)).toBe(true);
      expect(second.objects.has(photoHash)).toBe(false);
      await expect(second.objects.get(planted)!.bytes()).rejects.toThrow("changed after its snapshot");
      // Markdown is read eagerly regardless of the row, which the walk then repairs.
      const noteHash = hashObject(await readFile(note));
      expect(second.objects.has(noteHash)).toBe(true);
      expect(index.objectRow(note, await stat(note, { bigint: true }))?.hash).toBe(noteHash);
    } finally {
      index.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a rewritten file with the same size and mtime but a new inode invalidates its row", async () => {
    const { root, index, exclusions } = await fixture("arbor-lazy-tamper-");
    try {
      const photo = join(root, "nested", "photo.bin");
      const fixed = new Date("2024-01-01T00:00:00.000Z");
      await utimes(photo, fixed, fixed);
      const first = await snapshotDirectory(root, new Map(), exclusions, undefined, objectIndexOf(index));
      const before = await stat(photo, { bigint: true });
      const replacement = join(root, "nested", "photo.bin.tmp");
      await writeFile(replacement, Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]));
      await rename(replacement, photo);
      await utimes(photo, fixed, fixed);
      const after = await stat(photo, { bigint: true });
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ino).not.toBe(before.ino);
      expect(index.objectRow(photo, after)).toBeUndefined();
      const second = await snapshotDirectory(root, new Map(), exclusions, undefined, objectIndexOf(index));
      expect(second.root).not.toBe(first.root);
      expect(index.objectRow(photo, after)?.hash).toBe(hashObject(await readFile(photo)));
    } finally {
      index.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("directory rows re-encode to the same hash from their children rows", async () => {
    const { root, index, exclusions } = await fixture("arbor-lazy-dirs-");
    try {
      const first = await snapshotDirectory(root, new Map(), exclusions, undefined, objectIndexOf(index));
      const rootObject = decodeProtocolDirectory(await first.objects.get(first.root)!.bytes());
      if (rootObject.type !== "directory") throw new Error("Expected a directory");
      const nestedHash = rootObject.entries.find((entry) => entry.name === "nested")!.directory!;
      expect(index.lookupHash(nestedHash)).toEqual({ path: join(root, "nested"), kind: "directory" });
      expect(index.lookupHash(first.root)).toEqual({ path: root, kind: "directory" });
      const cached: SnapshotObjectIndex = {
        ...objectIndexOf(index),
        directoryHash: (absolute) => {
          const stored = index.storedObjectHash(absolute);
          return stored?.kind === "directory" ? stored.hash : undefined;
        },
      };
      const again = await snapshotDirectory(root, new Map(), exclusions, undefined, cached);
      expect(again.root).toBe(first.root);
      expect(again.objects.has(nestedHash)).toBe(false); // adopted from the row, not walked
      const nested = await snapshotDirectory(join(root, "nested"), new Map(), exclusions, undefined, objectIndexOf(index));
      expect(nested.root).toBe(nestedHash);
    } finally {
      index.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("canonical tree objects", () => {
  test("matches the language-neutral canonical object vectors", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../docs/overstory-spec/conformance/protocol-objects.json"), "utf8")) as {
      objects: Array<{
        model: { type: "file"; bytesBase64: string } | {
          type: "directory";
          entries: import("@overstory/protocol").ProtocolDirectoryEntry[];
          childrenSource?: import("@overstory/protocol").CollectionFileDescriptor;
        };
        bytesBase64: string;
        hash: string;
      }>;
    };
    for (const vector of fixture.objects) {
      const object = vector.model.type === "file"
        ? { type: "file" as const, bytes: Uint8Array.from(Buffer.from(vector.model.bytesBase64, "base64")) }
        : vector.model;
      const bytes = object.type === "file" ? object.bytes : encodeProtocolDirectory(object);
      expect(Buffer.from(bytes).toString("base64")).toBe(vector.bytesBase64);
      expect(hashObject(bytes)).toBe(vector.hash);
    }
  });

  test("keeps strict invalid object bytes as language-neutral vectors", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../docs/overstory-spec/conformance/protocol-objects.json"), "utf8")) as {
      invalid: Array<{ name: string; canonicalCborBase64: string }>;
    };
    expect(fixture.invalid.map((item) => item.name)).toEqual([
      "unsorted-directory",
      "duplicate-name",
      "dual-target",
      "entry-with-hash-key",
      "file-and-directory",
      "collection-file-version-2-schema-ts",
      "collection-file-version-1-schema-cddl",
      "collection-file-unknown-version",
      "noncanonical-cbor",
    ]);
    for (const vector of fixture.invalid) {
      expect(() => decodeProtocolDirectory(Buffer.from(vector.canonicalCborBase64, "base64"))).toThrow();
    }
  });

  test("encodes maps deterministically and hashes exact DAG-CBOR bytes", () => {
    const left = encodeCanonicalCBOR({ z: 1, a: { y: true, x: "value" } });
    const right = encodeCanonicalCBOR({ a: { x: "value", y: true }, z: 1 });
    expect(left).toEqual(right);
    expect(hashObject(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("orders directory names by UTF-8 bytes rather than locale", () => {
    expect(["ä", "z", "A"].sort(compareProtocolNames)).toEqual(["A", "z", "ä"]);
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

  test("rejects legacy, missing, and mixed collection-file directory shapes", () => {
    const hash = `sha256:${"1".repeat(64)}`;
    expect(() => decodeProtocolDirectory(encodeCanonicalCBOR({
      type: "directory",
      entries: [{ name: "_store.json", rollup: { version: 1 } }],
    }))).toThrow("Invalid directory entry");
    expect(() => decodeProtocolDirectory(encodeCanonicalCBOR({
      type: "directory",
      entries: [{ name: "_store.json", file: hash }],
      childrenSource: {
        version: 1,
        type: "collection-file",
        format: "json",
        source: "_store.json",
        schemaSource: "schema.ts",
        schemaFingerprint: hash,
        childSetHash: hash,
      },
    }))).toThrow("ordinary file entries");
    expect(() => decodeProtocolDirectory(encodeCanonicalCBOR({
      type: "directory",
      entries: [
        { name: "_store.json", file: hash },
        { name: "extra.md", file: hash },
        { name: "schema.ts", file: hash },
      ],
      childrenSource: {
        version: 1,
        type: "collection-file",
        format: "json",
        source: "_store.json",
        schemaSource: "schema.ts",
        schemaFingerprint: hash,
        childSetHash: hash,
      },
    }))).toThrow("mixes immediate-child backings");
  });

  test("snapshots files once and represents nested trees as boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-wire-objects-"));
    try {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "note.md"), "# Note\n");
      await writeFile(join(root, "nested", "private.md"), "private\n");
      const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map([[join(root, "nested"), "tr_child"]])));
      const object = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
      expect(object).toEqual({
        type: "directory",
        entries: [
          { name: "nested", tree: "tr_child" },
          expect.objectContaining({ name: "note.md", file: expect.stringMatching(/^sha256:/) }),
        ],
      });
      expect(snapshot.objects.size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("snapshots exact collection files as ordinary source-and-schema entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-wire-collection-file-"));
    const destination = await mkdtemp(join(tmpdir(), "arbor-wire-collection-file-materialized-"));
    try {
      const schemaSource = "overstory-schema-version = 1\noverstory-primary-key = [\"id\"]\nrow = { id: tstr }\n";
      const storeSource = "[{\"id\":\"one\"}]\n";
      await writeFile(join(root, "schema.cddl"), schemaSource);
      await writeFile(join(root, "_store.json"), storeSource);
      const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], async (_directory, sourceName) => ({
        format: sourceName === "_store.json" ? "json" : "csv",
        schemaFingerprint: `sha256:${"3".repeat(64)}`,
        childSetHash: `sha256:${"4".repeat(64)}`,
      })));
      const object = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
      if (object.type !== "directory") throw new Error("Expected a directory");
      const descriptor = object.childrenSource!;
      expect(descriptor).toEqual(expect.objectContaining({ version: 2, type: "collection-file", format: "json", schemaSource: "schema.cddl" }));
      const sourceHash = object.entries.find((entry) => entry.name === descriptor.source)!.file!;
      const schemaHash = object.entries.find((entry) => entry.name === descriptor.schemaSource)!.file!;
      expect(sourceHash).not.toBe(schemaHash);
      expect(snapshot.objects.get(sourceHash)!).toEqual(new TextEncoder().encode(storeSource));
      expect(snapshot.objects.get(schemaHash)!).toEqual(new TextEncoder().encode(schemaSource));

      await materializeTree(destination, snapshot.root, async (hash) => snapshot.objects.get(hash)!);
      expect(await readFile(join(destination, "_store.json"), "utf8")).toBe(storeSource);
      expect(await readFile(join(destination, "schema.cddl"), "utf8")).toBe(schemaSource);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("validates schema.cddl and verifies CSV, JSON, and JSONL protocol descriptors without executing code", async () => {
    const fixtures = {
      csv: "id,title\none,One\ntwo,Two\n",
      json: '[{"id":"one","title":"One"},{"id":"two","title":"Two"}]\n',
      jsonl: '{"id":"one","title":"One"}\n{"id":"two","title":"Two"}\n',
    } as const;
    for (const [codec, source] of Object.entries(fixtures) as Array<[keyof typeof fixtures, string]>) {
      const root = await mkdtemp(join(tmpdir(), `arbor-wire-${codec}-`));
      const collections = new ProjectionProviderHost();
      try {
        await writeFile(join(root, "schema.cddl"), [
          "overstory-schema-version = 1",
          'overstory-primary-key = ["id"]',
          "row = { id: tstr, title: tstr }",
          "",
        ].join("\n"));
        await writeFile(join(root, `_store.${codec}`), source);
        const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (directory, name) =>
          collections.collectionFileDescriptor(directory, name)));
        const object = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
        if (object.type !== "directory") throw new Error("Expected a collection-file directory");
        const descriptor = object.childrenSource!;
        const sourceHash = object.entries.find((entry) => entry.name === descriptor.source)!.file!;
        const schemaHash = object.entries.find((entry) => entry.name === descriptor.schemaSource)!.file!;
        const sourceObject = snapshot.objects.get(sourceHash)!;
        const schemaObject = snapshot.objects.get(schemaHash)!;
        const decoded = decodeProtocolCollectionFile(descriptor, sourceObject, schemaObject);
        expect(decoded.rows.map((row) => row.properties), codec).toEqual([
          { id: "one", title: "One" },
          { id: "two", title: "Two" },
        ]);
      } finally {
        await collections[Symbol.asyncDispose]();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("refuses to snapshot a retired schema.ts collection file as ordinary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-wire-legacy-collection-"));
    const collections = new ProjectionProviderHost();
    try {
      await writeFile(join(root, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string() }); export const primaryKey = ["id"];\n');
      await writeFile(join(root, "_store.json"), '[{"id":"one"}]\n');
      await expect(snapshotDirectory(root, new Map(), [], (directory, name) =>
        collections.collectionFileDescriptor(directory, name))).rejects.toThrow("convert this collection to schema.cddl");
    } finally {
      await collections[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("materialization leaves byte-identical authored files untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-materialize-identical-"));
    try {
      const path = join(root, "note.md");
      await writeFile(path, "same bytes\n");
      const fixed = new Date("2024-01-01T00:00:00.000Z");
      await utimes(path, fixed, fixed);
      const before = await stat(path);
      const snapshot = await resolveSnapshot(await snapshotDirectory(root));

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

      const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [mounted]));
      const rootObject = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
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

const cborVectors = JSON.parse(await readFile(join(import.meta.dir, "../../docs/overstory-spec/conformance/canonical-cbor-values.json"), "utf8")) as {
  valid: Array<{ name: string; value: unknown; canonicalCBORBase64: string; hash: `sha256:${string}` }>;
  invalid: Array<{ name: string; canonicalCBORBase64: string }>;
};

describe("canonical CBOR value vectors", () => {
  const fixture = cborVectors;
  test("encodes and hashes every valid vector", () => {
    for (const entry of fixture.valid) {
      const encoded = encodeCanonicalCBOR(entry.value);
      expect(Buffer.from(encoded).toString("base64"), entry.name).toBe(entry.canonicalCBORBase64);
      expect(canonicalCBORHash(entry.value), entry.name).toBe(entry.hash);
      expect(decodeCBOR(encoded), entry.name).toEqual(entry.value);
    }
  });
  test("rejects every invalid vector and non-finite numbers", () => {
    for (const entry of fixture.invalid) {
      expect(() => decodeCBOR(new Uint8Array(Buffer.from(entry.canonicalCBORBase64, "base64"))), entry.name).toThrow();
    }
    expect(() => encodeCanonicalCBOR(Number.NaN)).toThrow("Non-finite");
    expect(() => encodeCanonicalCBOR([Number.POSITIVE_INFINITY])).toThrow("Non-finite");
  });
});
