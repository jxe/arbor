import { expect, test } from "bun:test";
import { hashObject } from "@overstory/protocol";
import {
  loadIntentState,
  storeIntentState,
  storeSharedIntentState,
} from "../../packages/canopyd-merge/src/state-storage.ts";
import type { IntentState } from "../../packages/canopyd-merge/src/intent-model.ts";
const bytes = (s: string) => new TextEncoder().encode(s);
function state(count: number): IntentState {
  return {
    format: "arbor-merge-intent-state",
    tree: "tr_test",
    root: "root",
    nodes: {
      root: {
        id: "root",
        parent: null,
        name: "",
        kind: "directory",
        object: hashObject(bytes("directory")),
        active: true,
      },
    },
    changes: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        "change-" + i,
        hashObject(bytes("envelope-" + i)),
      ]),
    ),
    origins: {},
    outputs: {},
    alternatives: {},
    effects: {},
    decisions: [],
  };
}
function store() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: (b: Uint8Array) => {
      const h = hashObject(b);
      objects.set(h, b);
      return h;
    },
    load: async (h: string) => {
      const b = objects.get(h);
      if (!b) throw Error("Missing chunk");
      return b;
    },
  };
}
test("indexed states reconstruct the exact state; full-copy and bare shared roots are refused", async () => {
  const f = store(),
    original = state(1000);
  const legacy = f.put(bytes(JSON.stringify(original))),
    shared = storeIntentState(original, f.put);
  // Pinned: the shared-value encoding and the indexed root never change.
  const v2 = storeSharedIntentState(original, f.put);
  expect(v2).toBe(
    "sha256:abf2e3e5e1337bc169c7a71de9ac309783012bed053146e06aad4267a981061d",
  );
  expect(shared).toBe(
    "sha256:d7039f55610cd20e7eccc3b129a44ce3856655eecc36ae1299354b7d5fd44767",
  );
  expect(await loadIntentState(shared, f.load)).toEqual(original);
  expect(storeIntentState(original, f.put)).toBe(shared);
  // Migration 013 rewrote every stored state to the indexed format.
  await expect(loadIntentState(legacy, f.load)).rejects.toThrow("Invalid indexed state root");
  await expect(loadIntentState(v2, f.load)).rejects.toThrow("Invalid indexed state root");
});
test("one new history entry rewrites a bounded radix path rather than its history", async () => {
  for (const count of [100, 1000, 10000]) {
    const f = store(),
      original = state(count);
    storeIntentState(original, f.put);
    const before = new Set(f.objects.keys());
    original.changes["next-change"] = hashObject(bytes("next-envelope"));
    const next = storeIntentState(original, f.put);
    let added = 0;
    for (const [hash, b] of f.objects) if (!before.has(hash)) added += b.length;
    expect(added).toBeLessThan(12_000);
    expect(await loadIntentState(next, f.load)).toEqual(original);
  }
});
test("missing or corrupt chunks fail rather than manufacturing partial state", async () => {
  const f = store(),
    root = storeIntentState(state(1000), f.put);
  const manifest = JSON.parse(new TextDecoder().decode(f.objects.get(root)));
  f.objects.set(manifest.active, bytes("{}"));
  await expect(loadIntentState(root, f.load)).rejects.toThrow(
    "Invalid state chunk hash",
  );
  f.objects.delete(manifest.active);
  await expect(loadIntentState(root, f.load)).rejects.toThrow("Missing chunk");
});
test("retention includes every shared chunk, not only logical file dependencies", async () => {
  const f = store(),
    root = storeIntentState(state(1000), f.put),
    visited = new Set<string>();
  await loadIntentState(root, f.load, (hash) => visited.add(hash));
  expect(visited).toEqual(new Set(f.objects.keys()));
});

test("cached history validation equals full validation and reports all retained objects", async () => {
  const { StateMapValidationCache } = await import(
    "../../packages/canopyd-merge/src/state-map.ts"
  );
  const f = store(),
    cache = new StateMapValidationCache();
  const original = state(1000);
  for (let i = 0; i < 3; i++) {
    original.changes[`new-${i}`] = hashObject(bytes(`new-${i}`));
    const root = storeIntentState(original, f.put);
    const fullObjects = new Set<string>(),
      cachedObjects = new Set<string>();
    const full = await loadIntentState(root, f.load, (h) => fullObjects.add(h));
    const cached = await loadIntentState(
      root,
      f.load,
      (h) => cachedObjects.add(h),
      cache,
    );
    expect(cached).toEqual(full);
    expect(cachedObjects).toEqual(fullObjects);
  }
  original.changes.invalid = "not-a-hash";
  const malformed = storeIntentState(original, f.put);
  await expect(
    loadIntentState(malformed, f.load, undefined, cache),
  ).rejects.toThrow();
  await expect(loadIntentState(malformed, f.load)).rejects.toThrow();
});

test("cached validation retains history node-identity checks", async () => {
  const { StateMapValidationCache } = await import(
    "../../packages/canopyd-merge/src/state-map.ts"
  );
  const f = store(),
    original = state(1),
    cache = new StateMapValidationCache();
  const valid = storeIntentState(original, f.put);
  await loadIntentState(valid, f.load, undefined, cache);
  original.outputs.bad = {
    node: "root",
    view: {
      root: "root",
      nodes: { root: { ...original.nodes.root!, id: "another" } },
    },
  };
  const malformed = storeIntentState(original, f.put);
  await expect(
    loadIntentState(malformed, f.load, undefined, cache),
  ).rejects.toThrow("Invalid retained node identity");
  await expect(loadIntentState(malformed, f.load)).rejects.toThrow(
    "Invalid retained node identity",
  );
});

test("growing history shares piece pages instead of storing quadratic copies", async () => {
  const sizes: number[] = [];
  for (const count of [128, 256]) {
    const f = store(),
      original = state(0),
      object = hashObject(bytes("x"));
    const pieces = Array.from({ length: count + 1 }, (_, i) => ({
      origin: `origin-${i}`,
      start: 0,
      object,
      offset: 0,
      length: 1,
    }));
    const node = (length: number) => ({
      id: "file",
      parent: "root",
      name: "a",
      kind: "file" as const,
      object,
      active: true,
      pieces: pieces.slice(0, length),
    });
    for (let i = 1; i <= count; i++)
      original.effects[`edit-${i}`] = {
        authored: { operation: object, basis: object },
        change: `change-${i}`,
        operation: "edit",
        kind: "editSource",
        undone: false,
        before: { file: node(i) },
        after: { file: node(i + 1) },
      };
    const root = storeIntentState(original, f.put);
    sizes.push(
      [...f.objects.values()].reduce((sum, value) => sum + value.length, 0),
    );
    expect(await loadIntentState(root, f.load)).toEqual(original);
    const chunks = [...f.objects].filter(
      ([, value]) =>
        JSON.parse(new TextDecoder().decode(value)).format ===
        "arbor-merge-value-v1",
    );
    // Shared pages belong to retention just as record and map roots do.
    const retained = new Set<string>();
    await loadIntentState(root, f.load, (hash) => retained.add(hash));
    expect(chunks.every(([hash]) => retained.has(hash))).toBe(true);
    const page = chunks.find(
      ([, value]) =>
        JSON.parse(new TextDecoder().decode(value)).kind === "array",
    )!;
    f.objects.delete(page[0]);
    await expect(loadIntentState(root, f.load)).rejects.toThrow(
      "Missing chunk",
    );
  }
  expect(sizes[1]! / sizes[0]!).toBeLessThan(2.5);
});
