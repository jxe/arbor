import { describe, expect, test } from "bun:test";
import { reconcileUpdate } from "@overstory/canopyd";
import { mergeProtocolTrees } from "@overstory/tree-merge";
import { encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectoryEntry, type ProtocolDirectory } from "@overstory/protocol";

const objects = new Map<string, Uint8Array>();
const load = async (hash: ObjectHash) => {
  const bytes = objects.get(hash);
  if (!bytes) throw new Error(`missing ${hash}`);
  return bytes;
};
function stored(object: ProtocolDirectory | { type: "file"; bytes: Uint8Array }): ObjectHash {
  const bytes = object.type === "file" ? object.bytes : encodeProtocolDirectory(object);
  const hash = hashObject(bytes);
  objects.set(hash, bytes);
  return hash;
}
const file = (text: string) => stored({ type: "file", bytes: new TextEncoder().encode(text) });
const dir = (entries: ProtocolDirectoryEntry[]) => stored({
  type: "directory",
  entries: entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))),
});

describe("snapshot reconciliation", () => {
  test("reconciles concurrent changes", async () => {
    const base = dir([{ name: "a.md", file: file("A\n") }]);
    const candidate = dir([{ name: "a.md", file: file("A2\n") }]);
    const current = dir([{ name: "a.md", file: file("A\n") }, { name: "b.md", file: file("B\n") }]);
    const result = await reconcileUpdate(base, candidate, current, load, { merge: mergeProtocolTrees });
    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") throw new Error("expected merge");
    expect(result.conflicts).toEqual([]);
    expect(result.root).toBe(dir([{ name: "a.md", file: file("A2\n") }, { name: "b.md", file: file("B\n") }]));
  });

  test("an unchanged candidate needs no merge", async () => {
    const root = dir([{ name: "a.md", file: file("A\n") }]);
    expect((await reconcileUpdate(root, root, root, load, { merge: mergeProtocolTrees })).outcome).toBe("current");
  });
});
