import { describe, expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, type ObjectHash } from "@ovst/protocol";
import { memorySource, ObjectSourceChain, ObjectSourceMissing, type ObjectSourceSkip } from "@ovst/object-store/sources";
import { NodeIndex } from "@ovst/working-tree";

// Clients 003 modules 2 and 3: the object source chain and the lazy node index.

const text = (value: string) => new TextEncoder().encode(value);

describe("object source chain", () => {
  test("tries sources in order, passes over wrong bytes and failures, and checks every answer", async () => {
    const page = text("# Page\n");
    const hash = hashObject(page);
    const skips: ObjectSourceSkip[] = [];
    const chain = new ObjectSourceChain([
      { object: async () => text("stale") },
      { object: async () => { throw new Error("offline"); } },
      memorySource(new Map([[hash, page]])),
    ], (skip) => skips.push(skip));
    expect(await chain.object(hash)).toEqual(page);
    expect(skips.map((skip) => [skip.source, skip.reason])).toEqual([[0, "hash-mismatch"], [1, "error"]]);
  });

  test("a miss everywhere is undefined, or the last failure when a source failed", async () => {
    const hash = hashObject(text("absent"));
    expect(await new ObjectSourceChain([memorySource(new Map())]).object(hash)).toBeUndefined();
    await expect(new ObjectSourceChain([memorySource(new Map())]).require(hash)).rejects.toBeInstanceOf(ObjectSourceMissing);
    await expect(new ObjectSourceChain([{ object: async () => { throw new Error("offline"); } }, memorySource(new Map())]).object(hash))
      .rejects.toThrow("offline");
  });
});

describe("lazy node index", () => {
  const page = text("# Paris\n");
  const other = text("# Rome\n");
  const trips = encodeProtocolDirectory({ type: "directory", entries: [{ name: "Paris.md", file: hashObject(page), created: 0, modified: 0 }] });
  const notes = encodeProtocolDirectory({ type: "directory", entries: [{ name: "Rome.md", file: hashObject(other), created: 0, modified: 0 }] });
  const root = encodeProtocolDirectory({ type: "directory", entries: [
    { name: "Notes", directory: hashObject(notes) },
    { name: "Trips", directory: hashObject(trips) },
  ] });
  const objects = new Map([page, other, trips, notes, root].map((bytes) => [hashObject(bytes), bytes] as const));

  function counted() {
    const reads: string[] = [];
    return { reads, source: { object: async (hash: string) => { reads.push(hash); return objects.get(hash); } } };
  }

  test("loads only the directories a path needs, once", async () => {
    const { reads, source } = counted();
    const index = new NodeIndex(hashObject(root) as ObjectHash, source);
    expect((await index.entry("/Trips/Paris.md"))?.file).toBe(hashObject(page));
    expect(reads).toEqual([hashObject(root), hashObject(trips)]);
    expect((await index.children("/Trips")).map((child) => child.path)).toEqual(["/Trips/Paris.md"]);
    expect(reads.length).toBe(2);
    expect(await index.directory("/Missing")).toBeUndefined();
  });

  test("a path read brings what the protocol's walk names; prefetch runs over the same index", async () => {
    const { reads, source } = counted();
    const index = new NodeIndex(hashObject(root) as ObjectHash, source);
    expect(new Set((await index.pathRead("/Trips/Paris")).keys())).toEqual(new Set([hashObject(root), hashObject(trips), hashObject(page)]));
    expect(index.heldDirectories).toBe(2);
    reads.length = 0;
    await index.prefetch("opened-pages");
    expect(reads).toEqual([]);
    await index.prefetch("directories-and-pages");
    expect(index.heldDirectories).toBe(3);
    expect(reads).toContain(hashObject(other));
  });

  test("another root reuses the directories that did not change", async () => {
    const { reads, source } = counted();
    const index = new NodeIndex(hashObject(root) as ObjectHash, source);
    await index.entry("/Trips/Paris.md");
    const changed = encodeProtocolDirectory({ type: "directory", entries: [
      { name: "Notes", directory: hashObject(notes) },
      { name: "Today.md", file: hashObject(other), created: 0, modified: 0 },
      { name: "Trips", directory: hashObject(trips) },
    ] });
    objects.set(hashObject(changed), changed);
    reads.length = 0;
    index.rebase(hashObject(changed) as ObjectHash);
    expect((await index.entry("/Trips/Paris.md"))?.file).toBe(hashObject(page));
    expect(reads).toEqual([hashObject(changed)]);
    expect(index.at(hashObject(root) as ObjectHash).root).toBe(hashObject(root) as ObjectHash);
  });
});
