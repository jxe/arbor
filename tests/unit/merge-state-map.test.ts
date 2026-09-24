import { test, expect } from "bun:test";
import { hashObject } from "@overstory/protocol";
import {
  getStateMap,
  loadStateMap,
  storeStateMap,
  updateStateMap,
} from "../../packages/canopyd-merge/src/state-map.ts";
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const put = (bytes: Uint8Array) => {
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  const read = async (hash: string) => {
    reads.push(hash);
    const bytes = objects.get(hash);
    if (!bytes) throw Error("Missing object");
    return bytes;
  };
  return { objects, reads, put, read };
}
test("path updates equal a canonical rebuild without reading historical values", async () => {
  for (const count of [0, 16, 17, 100, 10_000]) {
    const f = fixture(),
      values = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`key-${i}`, { number: i }]),
      );
    const root = storeStateMap(values, f.put);
    const changes = { "key-0": { number: -1 }, next: { number: count } };
    const updated = await updateStateMap(root, changes, f.read, f.put);
    expect(updated).toBe(storeStateMap({ ...values, ...changes }, f.put));
    expect(f.reads.length).toBeLessThan(15);
    expect(
      f.reads.every(
        (hash) =>
          JSON.parse(new TextDecoder().decode(f.objects.get(hash)!)).format ===
          "arbor-state-map-v1",
      ),
    ).toBe(true);
    expect(await loadStateMap(updated, f.read)).toEqual({
      ...values,
      ...changes,
    });
    f.reads.length = 0;
    expect(await getStateMap(updated, "next", f.read)).toEqual(changes.next);
    expect(f.reads.length).toBeLessThan(8);
    expect(await getStateMap(updated, "absent", f.read)).toBeUndefined();
  }
});
test("map reads reject misplaced keys and corrupt record objects", async () => {
  const f = fixture(),
    encode = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value));
  const root = storeStateMap({ a: 1 }, f.put);
  const leaf = JSON.parse(new TextDecoder().decode(f.objects.get(root)!));
  f.objects.set(leaf.entries[0][1], encode({ invalid: true }));
  await expect(getStateMap(root, "a", f.read)).rejects.toThrow(
    "Invalid state map hash",
  );
  const children = Array(16).fill(null);
  const bucket = parseInt(hashObject(new TextEncoder().encode("a"))[7]!, 16);
  children[(bucket + 1) % 16] = root;
  const malformed = f.put(encode({ format: "arbor-state-map-v1", children }));
  await expect(loadStateMap(malformed, f.read)).rejects.toThrow(
    "Invalid state map entry",
  );
});
