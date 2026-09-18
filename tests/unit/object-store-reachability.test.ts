import { expect, test } from "bun:test";
import { ObjectStore } from "../../packages/object-store/src/index.ts";
import { encodeWireDirectory, hashObject, type WireDirectoryEntry } from "@arbor/wire";

class ReadTrace extends ObjectStore {
  objects = new Map<string, Uint8Array>();
  reads: string[] = [];
  constructor() { super("/unused"); }
  put(bytes: Uint8Array) { const hash = hashObject(bytes); this.objects.set(hash, bytes); return hash; }
  directory(entries: WireDirectoryEntry[]) { return this.put(encodeWireDirectory({type: "directory", entries})); }
  override async read(hash: string) {
    this.reads.push(hash);
    const bytes = this.objects.get(hash);
    if (!bytes) throw Object.assign(Error("missing"), {code: "ENOENT"});
    return bytes;
  }
}

test("membership reads directory edges, not file bodies, and stops at nested trees", async () => {
  const store = new ReadTrace();
  const files = Array.from({length: 1000}, (_, i) => ({name: `f${String(i).padStart(4,"0")}`, file: hashObject(new TextEncoder().encode(String(i)))}));
  const nested = store.directory([{name: "secret", file: hashObject(new TextEncoder().encode("secret"))}]);
  const root = store.directory([...files, {name:"nested",tree:"tr_other"}]);
  expect(await store.contains(root, files[999]!.file)).toBe(true);
  expect(store.reads).toEqual([root]);
  store.reads = [];
  expect(await store.contains(root, nested)).toBe(false);
  expect(store.reads).toEqual([root]);
  // Availability/full snapshot validation still reads and rejects missing bodies.
  await expect(store.completeSnapshot(root)).rejects.toThrow("missing");
});

test("historical membership visits shared directories once and retains older-only objects", async () => {
  const store = new ReadTrace();
  const shared = store.directory([{name:"common",file:hashObject(new TextEncoder().encode("common"))}]);
  const old = hashObject(new TextEncoder().encode("old"));
  const roots = Array.from({length:100}, (_, i) => store.directory([
    {name:"shared",directory:shared}, {name:`version${i}`,file:i===0?old:hashObject(new TextEncoder().encode(`v${i}`))},
  ]));
  const missing = hashObject(new TextEncoder().encode("missing"));
  expect(await store.containsAny(roots, missing)).toBe(false);
  expect(store.reads).toHaveLength(101);
  expect(new Set(store.reads).size).toBe(101);
  store.reads=[];
  expect(await store.containsAny([...roots].reverse(), old)).toBe(true);
  expect(store.reads.filter(hash=>hash===shared)).toHaveLength(1);
  expect(await store.containsAny([shared], old)).toBe(false);
});


test("full integrity verification reads shared bytes once across accepted roots", async () => {
  const store = new ReadTrace();
  const file = store.put(new TextEncoder().encode("retained"));
  const shared = store.directory([{name:"file",file}]);
  const roots = Array.from({length:100}, (_, i)=>store.directory([{name:`sub${i}`,directory:shared}]));
  await store.verifyReachable(roots);
  expect(store.reads).toHaveLength(102);
  expect(store.reads.filter(hash=>hash===file)).toHaveLength(1);
  store.objects.delete(file);
  await expect(store.verifyReachable(roots)).rejects.toThrow("missing");
});


test("integrity traversal retains directory obligations after historical file reclassification", async () => {
  const store = new ReadTrace();
  const missing = hashObject(new TextEncoder().encode("missing child"));
  const directory = store.directory([{name:"child",file:missing}]);
  const asFile = store.directory([{name:"entry",file:directory}]);
  const asDirectory = store.directory([{name:"entry",directory}]);
  await expect(store.verifyReachable([asFile, asDirectory])).rejects.toThrow("missing");
});


test("current membership does not enumerate historical roots", async () => {
  const store = new ReadTrace();
  const file = hashObject(new TextEncoder().encode("current"));
  const root = store.directory([{name:"file",file}]);
  function* roots() { yield root; throw Error("History should not be queried"); }
  expect(await store.containsAny(roots(), file)).toBe(true);
});
