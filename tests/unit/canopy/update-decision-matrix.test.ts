import { describe, expect, test } from "bun:test";
import { mergeWireTrees, reconcileUpdate } from "@arbor/canopy";
import { encodeWireObject, hashObject, type ObjectHash, type WireDirectoryEntry, type WireObject } from "@arbor/wire";

const objects = new Map<string, Uint8Array>();
const load = async (hash: ObjectHash) => {
  const bytes = objects.get(hash);
  if (!bytes) throw new Error(`missing ${hash}`);
  return bytes;
};
function stored(object: WireObject): ObjectHash {
  const bytes = encodeWireObject(object);
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
}
const file = (text: string) => stored({ type: "file", bytes: new TextEncoder().encode(text) });
const dir = (entries: WireDirectoryEntry[]) => stored({
  type: "directory",
  entries: entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))),
});

describe("modelHash merge: node by node", () => {
  test("disjoint nodes merge with no rule and no summary", async () => {
    const base = dir([{ name: "a.md", hash: file("A\n") }, { name: "b.md", hash: file("B\n") }]);
    const candidate = dir([{ name: "a.md", hash: file("A2\n") }, { name: "b.md", hash: file("B\n") }]);
    const current = dir([{ name: "a.md", hash: file("A\n") }, { name: "b.md", hash: file("B2\n") }]);
    const result = await mergeWireTrees(base, candidate, current, load);
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toBeUndefined();
    expect(result.root).toBe(dir([{ name: "a.md", hash: file("A2\n") }, { name: "b.md", hash: file("B2\n") }]));
  });

  test("a node current only reformatted takes the candidate's bytes without conflict", async () => {
    const base = dir([{ name: "note.md", hash: file("---\nid: n1\ntitle: T\n---\nBody\n") }]);
    const candidate = dir([{ name: "note.md", hash: file("---\nid: n1\ntitle: T\n---\nBody\nMore\n") }]);
    const current = dir([{ name: "note.md", hash: file("---\ntitle: T\nid: n1\n---\nBody\n") }]);
    const result = await mergeWireTrees(base, candidate, current, load);
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toBeUndefined();
    expect(result.root).toBe(candidate);
  });

  test("two edits to one Markdown node run the merge rule, or conflict under reject", async () => {
    const base = dir([{ name: "note.md", hash: file("Base\n") }]);
    const candidate = dir([{ name: "note.md", hash: file("Base\nCandidate\n") }]);
    const current = dir([{ name: "note.md", hash: file("Base\nCurrent\n") }]);
    const merged = await mergeWireTrees(base, candidate, current, load, "merge");
    expect(merged.conflicts).toEqual([]);
    expect(merged.summary?.version).toBe("markdown-additive-v1");
    const rejected = await mergeWireTrees(base, candidate, current, load, "reject");
    expect(rejected.conflicts).toEqual([{ path: "/note.md", reason: "node-conflict" }]);
    expect(rejected.summary).toBeUndefined();
    expect(rejected.root).toBe(candidate);
  });

  test("a node without a merge rule conflicts by shape", async () => {
    const base = dir([{ name: "asset.bin", hash: file("0") }]);
    const candidate = dir([{ name: "asset.bin", hash: file("1") }]);
    const current = dir([{ name: "asset.bin", hash: file("2") }]);
    const result = await mergeWireTrees(base, candidate, current, load);
    expect(result.conflicts).toEqual([{ path: "/asset.bin", reason: "binary-conflict" }]);
  });
});

describe("reconcile under ifMatch", () => {
  test("bytesHash rejects any concurrent change and keeps the candidate as the draft", async () => {
    const base = dir([{ name: "a.md", hash: file("A\n") }]);
    const candidate = dir([{ name: "a.md", hash: file("A2\n") }]);
    const current = dir([{ name: "b.md", hash: file("B\n") }]);
    const result = await reconcileUpdate(base, candidate, current, load, { ifMatch: "bytesHash", onConflict: "reject" });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("expected rejection");
    expect(result.root).toBe(candidate);
    expect(result.conflicts).toEqual([{ path: "/", reason: "node-conflict" }]);
  });

  test("modelHash merges the same concurrent change", async () => {
    const base = dir([{ name: "a.md", hash: file("A\n") }]);
    const candidate = dir([{ name: "a.md", hash: file("A2\n") }]);
    const current = dir([{ name: "a.md", hash: file("A\n") }, { name: "b.md", hash: file("B\n") }]);
    const result = await reconcileUpdate(base, candidate, current, load, { ifMatch: "modelHash", onConflict: "merge" });
    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") throw new Error("expected merge");
    expect(result.conflicts).toEqual([]);
    expect(result.merge).toBeUndefined();
    expect(result.root).toBe(dir([{ name: "a.md", hash: file("A2\n") }, { name: "b.md", hash: file("B\n") }]));
  });

  test("a candidate equal to current or base is current, whatever the match", async () => {
    const root = dir([{ name: "a.md", hash: file("A\n") }]);
    for (const ifMatch of ["bytesHash", "modelHash"] as const) {
      expect((await reconcileUpdate(root, root, root, load, { ifMatch, onConflict: "merge" })).outcome).toBe("current");
    }
  });
});
