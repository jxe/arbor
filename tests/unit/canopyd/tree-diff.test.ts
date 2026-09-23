import { expect, test } from "bun:test";
import { encodeWireDirectory, hashObject, type ObjectHash, type WireDirectoryEntry } from "@overstory/protocol";
import { TreeReader, walkTreeDiff } from "../../../packages/canopyd/src/updates/tree-diff.ts";
import { buildAcceptedTransitionPayload } from "../../../packages/canopyd/src/updates/transition.ts";
import { entryChanges } from "../../../packages/canopyd/src/updates/entry-metadata.ts";

function store() {
  const objects = new Map<ObjectHash, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes) as ObjectHash; objects.set(hash, bytes); return hash; };
  const file = (text: string) => put(new TextEncoder().encode(text));
  const dir = (entries: WireDirectoryEntry[]) => put(encodeWireDirectory({ type: "directory", entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
  const reads = new Map<ObjectHash, number>();
  const load = async (hash: ObjectHash) => { reads.set(hash, (reads.get(hash) ?? 0) + 1); return objects.get(hash)!; };
  return { file, dir, load, reads, objects };
}

test("a shared reader reads each object once across the transition and entry-change walks", async () => {
  const s = store();
  const before = s.dir([{ name: "a.md", file: s.file("A") }, { name: "gone", directory: s.dir([{ name: "x.md", file: s.file("X") }]) }]);
  const after = s.dir([{ name: "a.md", file: s.file("A!") }, { name: "new", directory: s.dir([{ name: "y.md", file: s.file("Y") }]) }]);
  const reader = new TreeReader(s.load);
  const transition = await buildAcceptedTransitionPayload(before, after, reader);
  const changes = await entryChanges(before, after, reader);
  expect(changes.set.map((c) => c.path)).toEqual(["/a.md", "/new/y.md"]);
  expect(changes.removed).toEqual(["/gone/x.md"]);
  expect(transition.objects.length + transition.deltas.length).toBe(4);
  expect([...s.reads.values()].every((count) => count === 1)).toBe(true);
});

test("a reader refuses bytes whose hash does not match", async () => {
  const s = store();
  const root = s.dir([{ name: "a.md", file: s.file("A") }]);
  const lying = new TreeReader(async () => new TextEncoder().encode("not it"));
  await expect(walkTreeDiff(null, root, lying, { entry: () => true })).rejects.toThrow("hash mismatch");
});
