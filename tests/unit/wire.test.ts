import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  changedPaths,
  decodeWireObject,
  encodeCanonicalCBOR,
  encodeWireObject,
  hashObject,
  materializeTree,
  snapshotDirectory,
} from "@arbor/wire";

describe("canonical tree objects", () => {
  test("encodes maps deterministically and hashes exact DAG-CBOR bytes", () => {
    const left = encodeCanonicalCBOR({ z: 1, a: { y: true, x: "value" } });
    const right = encodeCanonicalCBOR({ a: { x: "value", y: true }, z: 1 });
    expect(left).toEqual(right);
    expect(hashObject(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
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
