import { test, expect } from "bun:test";
import { StateMapValidationCache } from "../../packages/merge/src/state-map.ts";
import { encodeWireDirectory, hashObject } from "@arbor/wire";
import {
  RetentionCache,
  retentionAudit,
  verifyIntentRetention,
} from "../../packages/merge/src/retention.ts";
import {
  loadIntentState,
  storeIntentState,
} from "../../packages/merge/src/state-storage.ts";

function fixture() {
  const objects = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => {
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  const file = put(new TextEncoder().encode("retained hidden bytes"));
  const directory = put(
    encodeWireDirectory({
      type: "directory",
      entries: [{ name: "note", file }],
    }),
  );
  const state = put(
    new TextEncoder().encode(
      JSON.stringify({
        format: "arbor-merge-intent-state",
        tree: "tr_test",
        root: "root",
        nodes: {
          root: {
            id: "root",
            parent: null,
            name: "",
            kind: "directory",
            object: directory,
            active: true,
          },
        },
        outputs: {},
        alternatives: {},
        origins: {},
        effects: {},
        changes: {},
        decisions: [],
      }),
    ),
  );
  let reads = 0;
  const load = async (hash: string) => {
    reads++;
    const bytes = objects.get(hash);
    if (!bytes) throw Error("Missing object");
    return bytes;
  };
  return { objects, file, state, load, reads: () => reads };
}

test("warm typed dependency validation reads no old bytes and returns the exact closure", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  const cold = await verifyIntentRetention([f.state], f.load);
  const warmup = await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: () => true,
  });
  const reads = f.reads();
  const warm = await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: () => true,
  });
  expect([...warm].sort()).toEqual([...cold].sort());
  expect(warm).toEqual(warmup);
  expect(f.reads()).toBe(reads);
});

test("discarded proposal bytes cannot seed a future durable verification", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: (hash) => hash !== f.file,
  });
  f.objects.delete(f.file);
  await expect(
    verifyIntentRetention([f.state], f.load, { cache, durable: () => true }),
  ).rejects.toThrow("Missing object");
});

test("a staged closure rechecks only proposed bytes, then proves their durable presence once", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  const staged = new Set([f.state, f.file]);
  const expected = await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: (hash) => !staged.has(hash),
  });
  let reads = f.reads();
  expect(
    await verifyIntentRetention([f.state], f.load, {
      cache,
      durable: (hash) => !staged.has(hash),
    }),
  ).toEqual(expected);
  expect(f.reads() - reads).toBe(staged.size);
  reads = f.reads();
  expect(
    await verifyIntentRetention([f.state], f.load, {
      cache,
      durable: () => true,
    }),
  ).toEqual(expected);
  expect(f.reads() - reads).toBe(staged.size);
  reads = f.reads();
  await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: () => true,
  });
  expect(f.reads()).toBe(reads);
});

test("a retained staged root cannot conceal a missing staged descendant", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: () => false,
  });
  f.objects.delete(f.file);
  await expect(
    verifyIntentRetention([f.state], f.load, {
      cache,
      durable: (hash) => hash !== f.state,
    }),
  ).rejects.toThrow("Missing object");
  await expect(
    verifyIntentRetention([f.state], f.load, { cache, durable: () => true }),
  ).rejects.toThrow("Missing object");
});

test("a corrupt staging override is rejected even when the closure was validated", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: () => false,
  });
  f.objects.set(f.file, new TextEncoder().encode("corrupt proposal"));
  await expect(
    verifyIntentRetention([f.state], f.load, { cache, durable: () => false }),
  ).rejects.toThrow("Invalid retained object hash");
});

test("a proposal cannot hide behind a previously verified durable hash", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: () => true,
  });
  f.objects.set(f.file, new TextEncoder().encode("wrong bytes"));
  await expect(
    verifyIntentRetention([f.state], f.load, {
      cache,
      durable: (hash) => hash !== f.file,
    }),
  ).rejects.toThrow("Invalid retained object hash");
  await expect(verifyIntentRetention([f.state], f.load)).rejects.toThrow(
    "Invalid retained object hash",
  );
});

test("eviction only loses work, never dependency validation", async () => {
  const f = fixture(),
    cache = new RetentionCache(1, 1);
  const cold = await verifyIntentRetention([f.state], f.load);
  for (let i = 0; i < 3; i++) {
    expect(
      await verifyIntentRetention([f.state], f.load, {
        cache,
        durable: () => true,
      }),
    ).toEqual(cold);
  }
  f.objects.delete(f.file);
  await expect(
    verifyIntentRetention([f.state], f.load, { cache, durable: () => true }),
  ).rejects.toThrow();
});

test("a cached file does not certify the same bytes as a directory or state", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  await verifyIntentRetention([f.state], f.load, {
    cache,
    durable: () => true,
  });
  const invalid = JSON.parse(new TextDecoder().decode(f.objects.get(f.state)!));
  invalid.nodes.root.object = f.file;
  const bytes = new TextEncoder().encode(JSON.stringify(invalid)),
    root = hashObject(bytes);
  f.objects.set(root, bytes);
  await expect(
    verifyIntentRetention([root], f.load, { cache, durable: () => true }),
  ).rejects.toThrow();
  await expect(
    verifyIntentRetention([f.file], f.load, { cache, durable: () => true }),
  ).rejects.toThrow();
});

test("reusing a decoded state preserves the exact closure and still requires its chunks", async () => {
  const f = fixture();
  const original = await loadIntentState(f.state, f.load);
  const root = storeIntentState(original, (bytes) => {
    const hash = hashObject(bytes);
    f.objects.set(hash, bytes);
    return hash;
  });
  const dependencies = new Set<string>();
  const historyCache = new StateMapValidationCache();
  await loadIntentState(root, f.load, undefined, historyCache);
  const value = await loadIntentState(
    root,
    f.load,
    (hash) => dependencies.add(hash),
    historyCache,
  );
  const expected = await verifyIntentRetention([root], f.load);
  const options = {
    cache: new RetentionCache(),
    durable: () => false,
    state: (hash: string) =>
      hash === root ? { value, dependencies } : undefined,
  };
  expect(await verifyIntentRetention([root], f.load, options)).toEqual(
    expected,
  );
  const manifest = JSON.parse(new TextDecoder().decode(f.objects.get(root)!));
  f.objects.delete(manifest.maps.changes);
  // Test both a cached closure and a fresh walk using the semantic proof.
  await expect(verifyIntentRetention([root], f.load, options)).rejects.toThrow(
    "Missing object",
  );
  await expect(
    verifyIntentRetention([root], f.load, {
      ...options,
      cache: new RetentionCache(),
    }),
  ).rejects.toThrow("Missing object");
});

test("successive states reach the prior frontier without rereading their history", async () => {
  const f = fixture(),
    cache = new RetentionCache();
  let root = f.state;
  const state = await loadIntentState(root, f.load);
  const put = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)),
      hash = hashObject(bytes);
    f.objects.set(hash, bytes);
    return hash;
  };
  await verifyIntentRetention([root], f.load, { cache, durable: () => true });
  for (let i = 0; i < 64; i++) {
    const envelope = put({
      base: { object: state.nodes.root!.object, state: root },
      incoming: { object: state.nodes.root!.object, change: `edit-${i}` },
    });
    state.changes[`edit-${i}`] = envelope;
    root = put(state);
    const reads = f.reads();
    await verifyIntentRetention([root], f.load, {
      cache,
      durable: (hash) => hash !== root && hash !== envelope,
    });
    expect(f.reads() - reads).toBeLessThan(10);
    const retained = await verifyIntentRetention([root], f.load, {
      cache,
      durable: () => true,
    });
    expect(retained.has(envelope)).toBe(true);
  }
});


test("fresh audit shares history across records and union traversal without trusting earlier audits", async () => {
  const f = fixture();
  const state = await loadIntentState(f.state, f.load);
  const roots = [f.state];
  const put = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = hashObject(bytes); f.objects.set(hash, bytes); return hash;
  };
  for (let i=0;i<32;i++) {
    const change=put({base:{object:state.nodes.root!.object,state:roots.at(-1)},incoming:{object:state.nodes.root!.object}});
    state.changes[`change-${i}`]=change;
    roots.push(put(state));
  }
  const expected = await verifyIntentRetention([roots.at(-1)!], f.load);
  const audit = retentionAudit(f.load);
  const before = f.reads();
  for (const root of roots) await audit([root]);
  expect(f.reads()-before).toBeLessThan(roots.length*4);
  expect(await audit(roots,true)).toEqual(expected);
  const unionAudit=retentionAudit(f.load);
  expect(await unionAudit(roots,true)).toEqual(expected);
  // A union never becomes an incorrectly broad certificate for its first root.
  expect(await unionAudit([f.state])).toEqual(await verifyIntentRetention([f.state],f.load));
  f.objects.delete(f.file);
  await expect(retentionAudit(f.load)(roots,true)).rejects.toThrow("Missing object");
});
