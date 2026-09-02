import { describe, expect, test } from "bun:test";
import { buildAcceptedTransitionPayload } from "@arbor/canopy";
import {
  applyObjectDelta,
  encodeTransitionPayloadJSON,
  encodeWireObject,
  hashObject,
  type AcceptedTransitionPayload,
  type ObjectHash,
} from "@arbor/wire";

function graph(name: string, payload: Uint8Array) {
  const file = encodeWireObject({ type: "file", bytes: payload });
  const fileHash = hashObject(file);
  const root = encodeWireObject({ type: "directory", entries: [{ name, hash: fileHash }] });
  const rootHash = hashObject(root);
  return { root: rootHash, file: fileHash, objects: new Map<ObjectHash, Uint8Array>([[fileHash, file], [rootHash, root]]) };
}

function results(payload: AcceptedTransitionPayload): Set<ObjectHash> {
  return new Set([
    ...payload.objects.map(({ hash }) => hash),
    ...payload.deltas.map(({ result }) => result),
  ]);
}

function reconstruct(payload: AcceptedTransitionPayload, retained: Map<ObjectHash, Uint8Array>): Map<ObjectHash, Uint8Array> {
  const objects = new Map(retained);
  for (const object of payload.objects) objects.set(object.hash, object.bytes);
  for (const delta of payload.deltas) {
    const base = objects.get(delta.base);
    if (!base) throw new Error(`Delta base is not retained: ${delta.base}`);
    const bytes = applyObjectDelta(base, delta);
    expect(hashObject(bytes)).toBe(delta.result);
    objects.set(delta.result, bytes);
  }
  return objects;
}

function encodedBytes(payload: AcceptedTransitionPayload): number {
  return Buffer.byteLength(JSON.stringify(encodeTransitionPayloadJSON(payload)));
}

describe("accepted transition derivation", () => {
  test("sends a small Markdown edit as a delta against its predecessor", async () => {
    const encoder = new TextEncoder();
    const before = graph("note.md", encoder.encode(`# Note\n\n${"shared text\n".repeat(1_000)}`));
    const after = graph("note.md", encoder.encode(`# Note\n\nEdited\n${"shared text\n".repeat(1_000)}`));
    const objects = new Map([...before.objects, ...after.objects]);

    const transition = await buildAcceptedTransitionPayload(before.root, after.root, async (hash) => objects.get(hash)!);

    expect(results(transition)).toEqual(new Set([after.root, after.file]));
    expect(transition.deltas.some((delta) => delta.base === before.file && delta.result === after.file)).toBe(true);
    expect(encodedBytes(transition)).toBeLessThan(1_000);
    const rebuilt = reconstruct(transition, before.objects);
    expect(rebuilt.get(after.file)).toEqual(after.objects.get(after.file));
    expect(rebuilt.get(after.root)).toEqual(after.objects.get(after.root));
  });

  test("diffs a large binary edit far from the start and sends a new file complete", async () => {
    const baseBytes = new Uint8Array(300_000).map((_, index) => index % 251);
    const nextBytes = baseBytes.slice();
    nextBytes[299_000] = 255;
    const before = graph("archive.bin", baseBytes);
    const after = graph("archive.bin", nextBytes);
    const objects = new Map([...before.objects, ...after.objects]);

    const transition = await buildAcceptedTransitionPayload(before.root, after.root, async (hash) => objects.get(hash)!);
    expect(transition.deltas.some((delta) => delta.base === before.file && delta.result === after.file)).toBe(true);
    expect(encodedBytes(transition)).toBeLessThan(2_000);
    expect(reconstruct(transition, before.objects).get(after.file)).toEqual(after.objects.get(after.file));

    const emptyRootBytes = encodeWireObject({ type: "directory", entries: [] });
    const emptyRoot = hashObject(emptyRootBytes);
    objects.set(emptyRoot, emptyRootBytes);
    const creation = await buildAcceptedTransitionPayload(emptyRoot, after.root, async (hash) => objects.get(hash)!);
    expect(creation.deltas).toEqual([]);
    expect(new Set(creation.objects.map(({ hash }) => hash))).toEqual(new Set([after.root, after.file]));
  });

  test("diffs a large directory so one changed entry costs a few instructions", async () => {
    const encoder = new TextEncoder();
    const shared = encodeWireObject({ type: "file", bytes: encoder.encode("# Page\n") });
    const changed = encodeWireObject({ type: "file", bytes: encoder.encode("# Page\n\nChanged\n") });
    const names = Array.from({ length: 400 }, (_, index) => `page-${String(index).padStart(4, "0")}.md`);
    const beforeRoot = encodeWireObject({ type: "directory", entries: names.map((name) => ({ name, hash: hashObject(shared) })) });
    const afterRoot = encodeWireObject({
      type: "directory",
      entries: names.map((name) => ({ name, hash: hashObject(name === "page-0200.md" ? changed : shared) })),
    });
    const objects = new Map<ObjectHash, Uint8Array>([
      [hashObject(shared), shared],
      [hashObject(changed), changed],
      [hashObject(beforeRoot), beforeRoot],
      [hashObject(afterRoot), afterRoot],
    ]);

    const transition = await buildAcceptedTransitionPayload(hashObject(beforeRoot), hashObject(afterRoot), async (hash) => objects.get(hash)!);

    expect(results(transition)).toEqual(new Set([hashObject(afterRoot), hashObject(changed)]));
    expect(transition.deltas.some((delta) => delta.base === hashObject(beforeRoot) && delta.result === hashObject(afterRoot))).toBe(true);
    expect(encodedBytes({ objects: [{ hash: hashObject(afterRoot), bytes: afterRoot }], deltas: [] })).toBeGreaterThan(20_000);
    expect(encodedBytes(transition)).toBeLessThan(1_500);
    const rebuilt = reconstruct(transition, new Map([[hashObject(shared), shared], [hashObject(beforeRoot), beforeRoot]]));
    expect(rebuilt.get(hashObject(afterRoot))).toEqual(afterRoot);
  });
});
