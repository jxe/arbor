import { describe, expect, test } from "bun:test";
import { buildAcceptedTransitionPayload } from "@arbor/canopy";
import {
  applyFileDelta,
  applyFilePatch,
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
} from "@arbor/wire";

function graph(name: string, payload: Uint8Array) {
  const file = encodeWireObject({ type: "file", bytes: payload });
  const fileHash = hashObject(file);
  const root = encodeWireObject({ type: "directory", entries: [{ name, hash: fileHash }] });
  const rootHash = hashObject(root);
  return { root: rootHash, file: fileHash, objects: new Map<ObjectHash, Uint8Array>([[fileHash, file], [rootHash, root]]) };
}

describe("accepted transition derivation", () => {
  test("uses the shared guarded splice representation for a small Markdown edit", async () => {
    const encoder = new TextEncoder();
    const before = graph("note.md", encoder.encode(`# Note\n\n${"shared text\n".repeat(1_000)}`));
    const after = graph("note.md", encoder.encode(`# Note\n\nEdited\n${"shared text\n".repeat(1_000)}`));
    const objects = new Map([...before.objects, ...after.objects]);

    const transition = await buildAcceptedTransitionPayload(before.root, after.root, async (hash) => objects.get(hash)!);

    expect(transition.filePatches).toHaveLength(1);
    expect(transition.fileDeltas).toBeUndefined();
    expect(transition.objects.map(({ hash }) => hash)).toEqual([after.root]);
    const base = decodeWireObject(objects.get(before.file)!);
    if (base.type !== "file") throw new Error("Expected a file");
    const reconstructed = applyFilePatch(base.bytes, transition.filePatches![0]!);
    expect(hashObject(encodeWireObject({ type: "file", bytes: reconstructed }))).toBe(after.file);
  });

  test("uses copy/insert for a large binary edit and whole bytes for a new file", async () => {
    const baseBytes = new Uint8Array(300_000).fill(7);
    const nextBytes = baseBytes.slice();
    nextBytes[150_000] = 9;
    const before = graph("archive.bin", baseBytes);
    const after = graph("archive.bin", nextBytes);
    const objects = new Map([...before.objects, ...after.objects]);

    const deltaTransition = await buildAcceptedTransitionPayload(before.root, after.root, async (hash) => objects.get(hash)!);

    expect(deltaTransition.filePatches).toBeUndefined();
    expect(deltaTransition.fileDeltas).toHaveLength(1);
    const base = decodeWireObject(objects.get(before.file)!);
    if (base.type !== "file") throw new Error("Expected a file");
    const reconstructed = applyFileDelta(base.bytes, deltaTransition.fileDeltas![0]!);
    expect(hashObject(encodeWireObject({ type: "file", bytes: reconstructed }))).toBe(after.file);

    const emptyRootBytes = encodeWireObject({ type: "directory", entries: [] });
    const emptyRoot = hashObject(emptyRootBytes);
    objects.set(emptyRoot, emptyRootBytes);
    const creation = await buildAcceptedTransitionPayload(emptyRoot, after.root, async (hash) => objects.get(hash)!);
    expect(creation.filePatches).toBeUndefined();
    expect(creation.fileDeltas).toBeUndefined();
    expect(new Set(creation.objects.map(({ hash }) => hash))).toEqual(new Set([after.root, after.file]));
  });
});
