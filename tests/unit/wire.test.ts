import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("canonical tree objects", () => {
  test("matches the language-neutral canonical object vectors", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../spec/fixtures/wire-objects.json"), "utf8")) as {
      objects: Array<{
        model: { type: "file"; bytesBase64: string } | { type: "directory"; entries: Array<{ name: string; hash?: string; tree?: string }> };
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
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../spec/fixtures/wire-objects.json"), "utf8")) as {
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
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../spec/fixtures/wire-objects.json"), "utf8")) as {
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
