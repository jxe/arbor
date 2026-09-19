import { test, expect } from "bun:test";
import { hashObject } from "@arbor/wire";
import {
  LazyStateMap,
  diffStateMap,
  loadStateMap,
  storeStateMap,
  updateStateMap,
} from "../../../packages/merge/src/state-map.ts";

function store() {
  const objects = new Map<string, Uint8Array>();
  let reads = 0;
  return {
    objects,
    get reads() { return reads; },
    reset() { reads = 0; },
    put: (bytes: Uint8Array) => {
      const hash = hashObject(bytes);
      objects.set(hash, bytes);
      return hash;
    },
    read: async (hash: string) => {
      reads++;
      return objects.get(hash)!;
    },
  };
}

test("diff returns exactly the added and replaced records", async () => {
  for (const size of [3, 40, 2_000]) {
    const s = store();
    const values = Object.fromEntries(
      Array.from({ length: size }, (_, i) => [`k${i}`, { i }]),
    );
    const before = storeStateMap(values, s.put);
    const updates = { k1: { i: -1 }, added: { new: true }, other: "x" };
    const after = await updateStateMap(before, updates, s.read, s.put);
    expect(await diffStateMap(after, after, s.read)).toEqual({});
    const diff = await diffStateMap(after, before, s.read);
    const eager = await loadStateMap(after, s.read),
      old = await loadStateMap(before, s.read);
    const expected = Object.fromEntries(
      Object.entries(eager).filter(
        ([k, v]) => JSON.stringify(old[k]) !== JSON.stringify(v),
      ),
    );
    expect({ ...diff }).toEqual(expected);
  }
});

test("diff and lazy reads touch only changed buckets", async () => {
  const counts: number[] = [];
  for (const size of [500, 20_000]) {
    const s = store();
    const before = storeStateMap(
      Object.fromEntries(Array.from({ length: size }, (_, i) => [`k${i}`, i])),
      s.put,
    );
    const after = await updateStateMap(before, { k7: "changed" }, s.read, s.put);
    const lazy = new LazyStateMap(after, s.read);
    expect(await lazy.since(before)).toEqual(
      Object.assign(Object.create(null), { k7: "changed" }),
    );
    expect(await lazy.get("k3")).toBe(3);
    expect(await lazy.has("missing")).toBe(false);
    counts.push(lazy.touched.size);
  }
  // Depth grows by one level per 16x; the read set does not grow with the map.
  expect(counts[1]! - counts[0]!).toBeLessThan(10);
});
