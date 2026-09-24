import { describe, expect, test } from "bun:test";
import { reconcileUpdate } from "@overstory/canopyd";
import { mergeWireTrees } from "@overstory/canopyd-merge";
import { encodeWireDirectory, hashObject, type ObjectHash, type WireDirectoryEntry, type WireDirectory } from "@overstory/protocol";

const objects = new Map<string, Uint8Array>();
const load = async (hash: ObjectHash) => {
  const bytes = objects.get(hash);
  if (!bytes) throw new Error(`missing ${hash}`);
  return bytes;
};
function stored(object: WireDirectory | { type: "file"; bytes: Uint8Array }): ObjectHash {
  const bytes = object.type === "file" ? object.bytes : encodeWireDirectory(object);
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
}
const file = (text: string) => stored({ type: "file", bytes: new TextEncoder().encode(text) });
const dir = (entries: WireDirectoryEntry[]) => stored({
  type: "directory",
  entries: entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))),
});

describe("snapshot merge: node by node", () => {
  test("disjoint nodes merge with no rule and no summary", async () => {
    const base = dir([{ name: "a.md", file: file("A\n") }, { name: "b.md", file: file("B\n") }]);
    const candidate = dir([{ name: "a.md", file: file("A2\n") }, { name: "b.md", file: file("B\n") }]);
    const current = dir([{ name: "a.md", file: file("A\n") }, { name: "b.md", file: file("B2\n") }]);
    const result = await mergeWireTrees(base, candidate, current, load);
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toBeUndefined();
    expect(result.root).toBe(dir([{ name: "a.md", file: file("A2\n") }, { name: "b.md", file: file("B2\n") }]));
  });

  test("a node current only reformatted takes the candidate's bytes without conflict", async () => {
    const base = dir([{ name: "note.md", file: file("---\nid: n1\ntitle: T\n---\nBody\n") }]);
    const candidate = dir([{ name: "note.md", file: file("---\nid: n1\ntitle: T\n---\nBody\nMore\n") }]);
    const current = dir([{ name: "note.md", file: file("---\ntitle: T\nid: n1\n---\nBody\n") }]);
    const result = await mergeWireTrees(base, candidate, current, load);
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toBeUndefined();
    expect(result.root).toBe(candidate);
  });

  test("two edits to one Markdown node run the merge rule", async () => {
    const base = dir([{ name: "note.md", file: file("Base\n") }]);
    const candidate = dir([{ name: "note.md", file: file("Base\nCandidate\n") }]);
    const current = dir([{ name: "note.md", file: file("Base\nCurrent\n") }]);
    const merged = await mergeWireTrees(base, candidate, current, load);
    expect(merged.conflicts).toEqual([]);
    expect(merged.summary?.version).toBe("markdown-additive-v1");
  });

  test("a node without a merge rule conflicts by shape", async () => {
    const base = dir([{ name: "asset.bin", file: file("0") }]);
    const candidate = dir([{ name: "asset.bin", file: file("1") }]);
    const current = dir([{ name: "asset.bin", file: file("2") }]);
    const result = await mergeWireTrees(base, candidate, current, load);
    expect(result.conflicts).toEqual([{ path: "/asset.bin", reason: "binary-conflict" }]);
  });
});

describe("snapshot reconciliation", () => {
  test("reconciles concurrent changes", async () => {
    const base = dir([{ name: "a.md", file: file("A\n") }]);
    const candidate = dir([{ name: "a.md", file: file("A2\n") }]);
    const current = dir([{ name: "a.md", file: file("A\n") }, { name: "b.md", file: file("B\n") }]);
    const result = await reconcileUpdate(base, candidate, current, load, { merge: mergeWireTrees });
    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") throw new Error("expected merge");
    expect(result.conflicts).toEqual([]);
    expect(result.root).toBe(dir([{ name: "a.md", file: file("A2\n") }, { name: "b.md", file: file("B\n") }]));
  });

  test("an unchanged candidate needs no merge", async () => {
    const root = dir([{ name: "a.md", file: file("A\n") }]);
    expect((await reconcileUpdate(root, root, root, load, { merge: mergeWireTrees })).outcome).toBe("current");
  });
});
