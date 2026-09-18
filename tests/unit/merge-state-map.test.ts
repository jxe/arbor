import { test, expect } from "bun:test";
import { hashObject } from "@arbor/wire";
import {
  getStateMap,
  loadValidatedStateMap,
  StateMapValidationCache,
  loadStateMap,
  storeStateMap,
  updateStateMap,
} from "../../packages/merge/src/state-map.ts";
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

test("validation proofs reuse unchanged history and retain complete dependencies", async () => {
  for (const count of [100, 10000]) {
    const f = fixture(),
      cache = new StateMapValidationCache();
    let validations = 0;
    const options = {
      cache,
      role: "number",
      maxBytes: 128 * 1024 * 1024,
      validate: (raw: unknown) => {
        validations++;
        if (typeof raw !== "number") throw Error("Expected number");
        return raw;
      },
    };
    const values = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`key-${i}`, i]),
    );
    const root = storeStateMap(values, f.put);
    const initial = await loadValidatedStateMap(root, f.read, options);
    expect(initial.values).toEqual(values);
    expect(new Set(f.reads)).toEqual(new Set(initial.objects));
    const updated = await updateStateMap(root, { next: -1 }, f.read, f.put);
    f.reads.length = 0;
    validations = 0;
    const proof = await loadValidatedStateMap(updated, f.read, options);
    expect(validations).toBe(1);
    expect(f.reads.length).toBeLessThan(10);
    expect(proof.values).toEqual({ ...values, next: -1 });
    f.reads.length = 0;
    await loadStateMap(updated, f.read);
    expect(new Set(f.reads)).toEqual(new Set(proof.objects));
    await expect(
      loadValidatedStateMap(updated, f.read, {
        ...options,
        maxBytes: proof.bytes - 1,
      }),
    ).rejects.toThrow("budget");
  }
});
test("validation proofs cannot cross record roles or radix positions", async () => {
  const f = fixture(),
    cache = new StateMapValidationCache();
  const options = {
    cache,
    role: "number",
    maxBytes: 100000,
    validate: (v: unknown) => v,
  };
  const root = storeStateMap({ a: 1 }, f.put);
  await loadValidatedStateMap(root, f.read, options);
  await expect(
    loadValidatedStateMap(root, f.read, {
      ...options,
      role: "string",
      validate: () => {
        throw Error("Wrong role");
      },
    }),
  ).rejects.toThrow("Wrong role");
  const children = Array(16).fill(null);
  const bucket = parseInt(hashObject(new TextEncoder().encode("a"))[7]!, 16);
  children[(bucket + 1) % 16] = root;
  const misplaced = f.put(
    new TextEncoder().encode(
      JSON.stringify({ format: "arbor-state-map-v1", children }),
    ),
  );
  await expect(
    loadValidatedStateMap(misplaced, f.read, options),
  ).rejects.toThrow("Invalid state map entry");
});
test("evicted proofs revalidate records and cached values are immutable", async () => {
  const f = fixture(),
    root = storeStateMap({ a: { nested: { n: 1 } } }, f.put);
  let validations = 0;
  const options = {
    cache: new StateMapValidationCache(0),
    role: "object",
    maxBytes: 100000,
    validate: (v: unknown) => {
      validations++;
      return v;
    },
  };
  const proof = await loadValidatedStateMap(root, f.read, options);
  expect(Object.isFrozen((proof.values.a as any).nested)).toBe(true);
  await loadValidatedStateMap(root, f.read, options);
  expect(validations).toBe(2);
});

test("successive edits remain correct when a small proof budget evicts history", async () => {
  const f = fixture(),
    cache = new StateMapValidationCache(2 * 1024 * 1024);
  let validations = 0;
  const options = {
    cache,
    role: "number",
    maxBytes: 1000000,
    validate: (v: unknown) => {
      validations++;
      return v;
    },
  };
  let root = storeStateMap(
    Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key-${i}`, i])),
    f.put,
  );
  await loadValidatedStateMap(root, f.read, options);
  let total = 0;
  for (let i = 0; i < 50; i++) {
    root = await updateStateMap(
      root,
      { [`added-${i}`]: 1000 + i },
      f.read,
      f.put,
    );
    validations = 0;
    await loadValidatedStateMap(root, f.read, options);
    total += validations;
  }
  expect(total).toBeGreaterThanOrEqual(50);
  const loaded = await loadValidatedStateMap(root, f.read, options);
  expect(Object.keys(loaded.values)).toHaveLength(1050);
  expect(loaded.values["added-49"]).toBe(1049);
});
