import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareProtocolNames,
  decodeProtocolDirectory,
  decodeProtocolRows,
  decodeProtocolTable,
  encodeProtocolDirectory,
  encodeProtocolRows,
  encodeProtocolTable,
  hashObject,
  type ProtocolTable,
  type LogicalRow,
} from "@ovst/protocol";
import { canonicalCBORHash, decodeCBOR, encodeCanonicalCBOR } from "@ovst/protocol";
import { ObjectIndex } from "@ovst/story-sync/state";
import { CollectionProjections } from "../../packages/story-sync/src/state/providers/collection-projection.ts";
import { loadDirectoryCollection } from "@ovst/collection-schema";
import {
  loadIgnorePolicy,
  materializeTree,
  membershipSkip,
  resolveSnapshot,
  snapshotDirectory,
  trackedEntries,
  type SnapshotObjectIndex,
} from "@ovst/fs";

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
    const { root, index, exclusions } = await fixture("story-lazy-root-");
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
    const { root, index, exclusions } = await fixture("story-lazy-index-");
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
    const { root, index, exclusions } = await fixture("story-lazy-tamper-");
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
    const { root, index, exclusions } = await fixture("story-lazy-dirs-");
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
        model: { type: "file"; bytesBase64: string } | ProtocolTable | { type: "rows"; rows: LogicalRow[] } | {
          type: "directory";
          entries: import("@ovst/protocol").ProtocolDirectoryEntry[];
          collection?: import("@ovst/protocol").CollectionReference;
        };
        bytesBase64: string;
        hash: string;
      }>;
    };
    for (const vector of fixture.objects) {
      const model = vector.model;
      const bytes = model.type === "file" ? Uint8Array.from(Buffer.from(model.bytesBase64, "base64"))
        : model.type === "table" ? encodeProtocolTable(model)
        : model.type === "rows" ? encodeProtocolRows(model.rows)
        : encodeProtocolDirectory(model);
      expect(Buffer.from(bytes).toString("base64")).toBe(vector.bytesBase64);
      expect(hashObject(bytes)).toBe(vector.hash);
      // Each decodes back to its model, strictly.
      if (model.type === "table") expect(decodeProtocolTable(bytes)).toEqual(model);
      if (model.type === "rows") expect(decodeProtocolRows(bytes)).toEqual(model);
      if (model.type === "directory") expect(decodeProtocolDirectory(bytes)).toEqual(model);
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
      "collection-without-schema",
      "collection-schema-directory",
      "collection-unknown-version",
      "collection-extra-member",
      "collection-tables-unsorted",
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

  test("rejects legacy collection shapes", () => {
    const hash = `sha256:${"1".repeat(64)}`;
    expect(() => decodeProtocolDirectory(encodeCanonicalCBOR({
      type: "directory",
      entries: [{ name: "_store.json", rollup: { version: 1 } }],
    }))).toThrow("Invalid directory entry");
    // A collection's rows are never files the tree describes.
    expect(() => decodeProtocolDirectory(encodeCanonicalCBOR({
      type: "directory",
      entries: [{ name: "_store.json", file: hash }, { name: "schema.usl", file: hash }],
      childrenSource: { version: 1, type: "collection-file", format: "json", source: "_store.json", schemaSource: "schema.usl", schemaFingerprint: hash, childSetHash: hash },
    }))).toThrow("Unknown wire object");
  });

  test("snapshots files once and represents nested trees as boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-wire-objects-"));
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

  test("a collection's rows are logical objects, and its projection files are not entries", async () => {
    const fixtures = {
      csv: "id,title\none,One\ntwo,Two\n",
      json: '[{"id":"one","title":"One"},{"id":"two","title":"Two"}]\n',
      jsonl: '{"id":"one","title":"One"}\n{"id":"two","title":"Two"}\n',
    } as const;
    const roots = new Set<string>();
    for (const [codec, source] of Object.entries(fixtures) as Array<[keyof typeof fixtures, string]>) {
      const root = await mkdtemp(join(tmpdir(), `story-wire-${codec}-`));
      const destination = await mkdtemp(join(tmpdir(), `story-wire-${codec}-materialized-`));
      const collections = new CollectionProjections({ now: () => "2026-10-24T09:00:00.000Z" });
      try {
        await writeFile(join(root, "schema.usl"), "model Item {\n  title Text\n}\n");
        await writeFile(join(root, `_store.${codec}`), source);
        const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (directory, names) => collections.read(directory, names)));
        roots.add(snapshot.root);
        const object = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
        expect(object.entries.map((entry) => entry.name)).toEqual(["schema.usl"]);
        const loaded = await loadDirectoryCollection(object, async (hash) => snapshot.objects.get(hash)!);
        expect(loaded!.tables.Item!.map((row) => [row.key, row.fields]), codec).toEqual([
          [[["id", "one"]], { title: "One" }],
          [[["id", "two"]], { title: "Two" }],
        ]);
        // Another placement writes the rows into its own projection.
        await materializeTree(destination, snapshot.root, async (hash) => snapshot.objects.get(hash)!, undefined, [], undefined,
          (directory, value, load) => new CollectionProjections().write(directory, value, load));
        expect(await readFile(join(destination, "_store.jsonl"), "utf8")).toBe(
          '{"id":"one","title":"One","created":"2026-10-24T09:00:00.000Z","modified":"2026-10-24T09:00:00.000Z"}\n'
          + '{"id":"two","title":"Two","created":"2026-10-24T09:00:00.000Z","modified":"2026-10-24T09:00:00.000Z"}\n');
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(destination, { recursive: true, force: true });
      }
    }
    // Three formats, one tree.
    expect(roots.size).toBe(1);
  });

  test("treats a schema.ts as an ordinary file, never as a collection schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-wire-schema-ts-"));
    const collections = new CollectionProjections();
    const describe = (directory: string, names: readonly string[]) => collections.read(directory, names);
    try {
      // Without schema.usl, _store.json and schema.ts are ordinary files.
      await writeFile(join(root, "schema.ts"), "export const schema = {};\n");
      await writeFile(join(root, "_store.json"), '[{"id":"one"}]\n');
      const plain = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], describe));
      const object = decodeProtocolDirectory(plain.objects.get(plain.root)!);
      expect(object.collection).toBeUndefined();
      expect(object.entries.map((entry) => entry.name)).toEqual(["_store.json", "schema.ts"]);

      // Beside a collection it stays an ordinary entry.
      await writeFile(join(root, "schema.usl"), "model Item {}\n");
      const collection = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], describe));
      const folder = decodeProtocolDirectory(collection.objects.get(collection.root)!);
      expect(folder.collection).toBeDefined();
      expect(folder.entries.map((entry) => entry.name)).toEqual(["schema.ts", "schema.usl"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("platform metadata is never snapshotted, written or removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-platform-metadata-"));
    const destination = await mkdtemp(join(tmpdir(), "story-platform-metadata-out-"));
    try {
      await mkdir(join(root, "notes"));
      await writeFile(join(root, "note.md"), "# Note\n");
      await writeFile(join(root, "notes", "idea.md"), "# Idea\n");
      const clean = await resolveSnapshot(await snapshotDirectory(root));
      await writeFile(join(root, ".DS_Store"), "finder");
      await writeFile(join(root, "notes", "._idea.md"), "appledouble");
      expect((await snapshotDirectory(root)).root).toBe(clean.root);

      // A root written before the exclusion still names Finder's file.
      const objects = new Map(clean.objects);
      const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
      const top = decodeProtocolDirectory(objects.get(clean.root)!);
      const legacy = put(encodeProtocolDirectory({ ...top, entries: [{ name: ".DS_Store", file: put(new TextEncoder().encode("old finder")) }, ...top.entries] }));
      const load = async (hash: string) => objects.get(hash)!;

      await writeFile(join(destination, ".DS_Store"), "local finder");
      await materializeTree(destination, legacy, load);
      expect(await readFile(join(destination, ".DS_Store"), "utf8")).toBe("local finder");
      await materializeTree(destination, clean.root, load);
      expect(await readFile(join(destination, ".DS_Store"), "utf8")).toBe("local finder");
      expect(await readFile(join(destination, "notes", "idea.md"), "utf8")).toBe("# Idea\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("materialization leaves byte-identical authored files untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-materialize-identical-"));
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

  test("ignored, untracked content stays out of snapshots and is never deleted by materialization", async () => {
    const source = await realpath(await mkdtemp(join(tmpdir(), "story-ignore-source-")));
    const destination = await realpath(await mkdtemp(join(tmpdir(), "story-ignore-destination-")));
    try {
      await writeFile(join(source, ".gitignore"), "*.log\ncache/\n");
      await writeFile(join(source, "page.md"), "# Page\n");
      await writeFile(join(source, "tracked.log"), "tracked before its rule\n");
      const held = await resolveSnapshot(await snapshotDirectory(source));
      const load = async (hash: string) => held.objects.get(hash as never)!;
      await writeFile(join(source, "untracked.log"), "local\n");
      await mkdir(join(source, "cache"));
      await writeFile(join(source, "cache", "blob"), "generated\n");
      await writeFile(join(source, ".evicted.log.icloud"), "placeholder");

      const policy = await loadIgnorePolicy(source);
      const tracked = await snapshotDirectory(source, new Map(), [], undefined, undefined, membershipSkip(policy, trackedEntries(held.root, load)));
      expect(tracked.root).toBe(held.root);
      const fresh = await resolveSnapshot(await snapshotDirectory(source, new Map(), [], undefined, undefined, membershipSkip(policy, null)));
      const names = decodeProtocolDirectory(fresh.objects.get(fresh.root)!);
      expect(names.type === "directory" && names.entries.map((entry) => entry.name)).toEqual([".gitignore", "page.md"]);
      // An evicted file a rule keeps out is not needed; without the rules it is.
      await expect(snapshotDirectory(source)).rejects.toThrow("not materialized");

      await writeFile(join(destination, ".gitignore"), "*.log\ncache/\n");
      await writeFile(join(destination, "untracked.log"), "local\n");
      await mkdir(join(destination, "cache"));
      await writeFile(join(destination, "cache", "blob"), "generated\n");
      await writeFile(join(destination, "stray.txt"), "not in the tree\n");
      const skip = membershipSkip(await loadIgnorePolicy(destination), trackedEntries(held.root, load));
      await materializeTree(destination, held.root, load, undefined, [], skip);
      expect(await readFile(join(destination, "untracked.log"), "utf8")).toBe("local\n");
      expect(await readFile(join(destination, "cache", "blob"), "utf8")).toBe("generated\n");
      expect(await readFile(join(destination, "tracked.log"), "utf8")).toBe("tracked before its rule\n");
      await expect(readFile(join(destination, "stray.txt"))).rejects.toThrow();
      const written = await snapshotDirectory(destination, new Map(), [], undefined, undefined, skip);
      expect(written.root).toBe(held.root);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("keeps reader-local mounts out of snapshots and pull deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-reader-layout-"));
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
