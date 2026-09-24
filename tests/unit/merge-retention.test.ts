import { test, expect } from "bun:test";
import { encodeWireDirectory, hashObject } from "@overstory/protocol";
import {
  RetentionCache,
  retentionAudit,
  verifyIntentRetention,
} from "../../packages/canopyd-merge/src/retention.ts";
import {
  loadIntentState,
  storeIntentState,
} from "../../packages/canopyd-merge/src/state-storage.ts";
import type { IntentState } from "../../packages/canopyd-merge/src/intent-model.ts";

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
  const state = storeIntentState(
    {
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
    } as IntentState,
    put,
  );
  let reads = 0;
  const load = async (hash: string) => {
    reads++;
    const bytes = objects.get(hash);
    if (!bytes) throw Error("Missing object");
    return bytes;
  };
  return { objects, file, state, load, put, reads: () => reads, directoryOf: () => directory };
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
  const invalid = await loadIntentState(f.state, f.load);
  invalid.nodes.root!.object = f.file;
  const root = storeIntentState(invalid, f.put);
  await expect(
    verifyIntentRetention([root], f.load, { cache, durable: () => true }),
  ).rejects.toThrow();
  await expect(
    verifyIntentRetention([f.file], f.load, { cache, durable: () => true }),
  ).rejects.toThrow();
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
    root = storeIntentState(state, f.put);
    const reads = f.reads();
    // As the host walks: durable change records were walked by the job that
    // published them, so only the new envelope leads back to the prior state.
    await verifyIntentRetention([root], f.load, {
      cache,
      durable: (hash) => hash !== root && hash !== envelope,
      trusted: (ref) => ref.kind === "change",
    });
    // The root, its active part, the changed map path and one rewritten
    // leaf's records (17 when a leaf splits); never the rest of history.
    expect(f.reads() - reads).toBeLessThan(32);
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
    roots.push(storeIntentState(state, f.put));
  }
  const expected = await verifyIntentRetention([roots.at(-1)!], f.load);
  const audit = retentionAudit(f.load);
  const before = f.reads();
  for (const root of roots) await audit([root]);
  // Per root: its own parts plus one rewritten map leaf, not every earlier change.
  expect(f.reads()-before).toBeLessThan(roots.length*16);
  expect(await audit(roots,true)).toEqual(expected);
  const unionAudit=retentionAudit(f.load);
  expect(await unionAudit(roots,true)).toEqual(expected);
  // A union never becomes an incorrectly broad certificate for its first root.
  expect(await unionAudit([f.state])).toEqual(await verifyIntentRetention([f.state],f.load));
  f.objects.delete(f.file);
  await expect(retentionAudit(f.load)(roots,true)).rejects.toThrow("Missing object");
});

test("a trusted accepted input state stops the history walk; a requested root is never trusted", async () => {
  // Accepted state A owns a hidden file; a change record links new state B to A.
  const f = fixture();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); f.objects.set(hash, bytes); return hash; };
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const change = put(encode({ base: { state: f.state, object: f.directoryOf() }, incoming: { object: f.directoryOf() } }));
  const later = storeIntentState({ ...await loadIntentState(f.state, f.load), changes: { edit: change } }, put);
  const walked = await verifyIntentRetention([later], f.load, { cache: new RetentionCache(), durable: () => true });
  expect(walked.has(f.state)).toBe(true);
  expect(walked.has(f.file)).toBe(true);
  const loaded: string[] = [];
  const trusted = await verifyIntentRetention([later], async (hash) => { loaded.push(hash); return f.load(hash); }, {
    cache: new RetentionCache(), durable: () => true, trusted: (ref) => ref.kind === "state" && ref.hash === f.state,
  });
  expect(loaded).not.toContain(f.state);
  expect(loaded).toContain(change);
  expect(trusted.has(f.file)).toBe(true); // reachable through B's own root directory
  expect(loaded).toContain(later);
  // A durable change record is a leaf (its bytes may still be read for
  // availability, but its base state is not); a staged one is still opened
  // so its base state is reached.
  loaded.length = 0;
  await verifyIntentRetention([later], async (hash) => { loaded.push(hash); return f.load(hash); }, {
    cache: new RetentionCache(), durable: () => true, trusted: (ref) => ref.kind === "change",
  });
  expect(loaded).not.toContain(f.state);
  loaded.length = 0;
  await verifyIntentRetention([later], async (hash) => { loaded.push(hash); return f.load(hash); }, {
    cache: new RetentionCache(), durable: (hash) => hash !== change, trusted: (ref) => ref.kind === "change",
  });
  expect(loaded).toContain(change);
  expect(loaded).toContain(f.state);
  // Trusting the requested root itself changes nothing: it is still verified.
  f.objects.delete(f.file);
  await expect(verifyIntentRetention([later], f.load, { cache: new RetentionCache(), durable: () => true, trusted: () => true })).rejects.toThrow("Missing object");
});

async function indexedHistory() {
  const { Fixture } = await import("./canopyd-merge/fixture.ts");
  const f = new Fixture();
  let text = "one two three\n";
  let current: string | { object: string; state: string } = f.tree({ "a.md": text });
  for (let i = 0; i < 6; i++) {
    const next = text.replace(/\n$/, ` w${i}\n`);
    current = (await f.run(f.request(current, f.tree({ "a.md": next }), [
      { kind: "editSource", key: "edit", source: f.ref("/a.md", text, [text.length - 1, text.length - 1]), text: ` w${i}` },
    ], `change-${i}`))).result;
    text = next;
  }
  const head = current as { object: string; state: string };
  const load = async (hash: string) => {
    const bytes = f.objects.get(hash);
    if (!bytes) throw Error("Missing object");
    return bytes;
  };
  const put = (bytes: Uint8Array) => f.put(bytes);
  return { f, head, load, put };
}

test("an indexed state's history walk reaches everything a whole-state load reads", async () => {
  const { head, load } = await indexedHistory();
  const read = new Set<string>();
  const state = await loadIntentState(head.state, load, (hash) => read.add(hash));
  const walked = await verifyIntentRetention([head.state], load, { cache: new RetentionCache(), durable: () => true });
  for (const hash of read) expect(walked.has(hash)).toBe(true);
  // Every object a history record names is retained as well.
  for (const effect of Object.values(state.effects)) expect(walked.has(effect.authored.basis)).toBe(true);
  for (const change of Object.values(state.changes)) expect(walked.has(change)).toBe(true);
});

test("a missing history record chunk is found through the map walk", async () => {
  const { f, head, load } = await indexedHistory();
  const state = await loadIntentState(head.state, load);
  const change = Object.values(state.changes)[0]!;
  f.objects.delete(change);
  await expect(verifyIntentRetention([head.state], load, { cache: new RetentionCache(), durable: () => true })).rejects.toThrow("Missing object");
});

test("verified durable map nodes stop later walks; staged ones never seed that trust", async () => {
  const { f, head, load, put } = await indexedHistory();
  const state = await loadIntentState(head.state, load);
  // A new state sharing all history: only its root and active part differ.
  const sibling = storeIntentState({ ...state, decisions: [] }, put, false);
  const cache = new RetentionCache();
  await verifyIntentRetention([head.state], load, { cache, durable: () => true });
  const loaded: string[] = [];
  await verifyIntentRetention([sibling], async (hash) => { loaded.push(hash); return load(hash); }, { cache, durable: () => true });
  // Shared history was verified with the head; its change records are not reread.
  expect(loaded).not.toContain(Object.values(state.changes)[0]!);
  // A walk whose closure is not all durable leaves no trusted map nodes behind.
  const staged = new RetentionCache();
  const change = Object.values(state.changes)[1]!;
  await verifyIntentRetention([head.state], load, { cache: staged, durable: (hash) => hash !== change });
  f.objects.delete(change);
  await expect(verifyIntentRetention([sibling], load, { cache: staged, durable: () => true })).rejects.toThrow("Missing object");
});

test("validated indexed retention visits changed branches, not flattened history", async () => {
  for (const count of [100, 10_000]) {
    const f = fixture(), cache = new RetentionCache();
    const put = (bytes: Uint8Array) => { const h = hashObject(bytes); f.objects.set(h, bytes); return h; };
    const state = await loadIntentState(f.state, f.load);
    const envelope = put(new TextEncoder().encode(JSON.stringify({base: {object: f.directoryOf()}, incoming: {object: f.directoryOf()}})));
    state.changes = Object.fromEntries(Array.from({length: count}, (_, i) => [`edit-${i}`, envelope]));
    const root = storeIntentState(state, put);
    const staged = new Map<string, Uint8Array>();
    let visits = 0;
    const options = { cache, durable: (h: string) => !staged.has(h), staged, frontierOnly: true,
      onCount: (name: string, n: number) => { if (name === "retention-visits") visits = n; },
    };
    await verifyIntentRetention([root], f.load, options);
    const old = new Set(f.objects.keys());
    state.changes.next = envelope;
    const next = storeIntentState(state, put);
    for (const [h, bytes] of f.objects) if (!old.has(h)) staged.set(h, bytes);
    await verifyIntentRetention([next], f.load, options);
    expect(visits).toBeLessThan(80);
    // A cached closure still requires staged bytes after an abandoned proposal.
    const missing = [...staged.keys()].find(h => h !== next)!;
    f.objects.delete(missing);
    staged.clear();
    await expect(verifyIntentRetention([next], f.load, options)).rejects.toThrow("Missing object");
  }
});

test("typed map certificates reject role changes and corrupt staged overrides", async () => {
  const { f, head, load, put } = await indexedHistory();
  const cache = new RetentionCache();
  const options = { cache, durable: () => true, staged: new Map<string, Uint8Array>(), frontierOnly: true };
  await verifyIntentRetention([head.state], load, options);
  const state = await loadIntentState(head.state, load);
  const manifest = JSON.parse(new TextDecoder().decode(f.objects.get(head.state)!));
  manifest.maps.effects = manifest.maps.changes;
  const wrongRole = put(new TextEncoder().encode(JSON.stringify(manifest)));
  await expect(verifyIntentRetention([wrongRole], load, options)).rejects.toThrow();
  options.staged.set(Object.values(state.changes)[0]!, new TextEncoder().encode("corrupt override"));
  await expect(verifyIntentRetention([head.state], load, options)).rejects.toThrow("Invalid retained object hash");
});

test("repeated staged closure reuse cannot certify unpublished history", async () => {
  const { f, head, load, put } = await indexedHistory();
  const state = await loadIntentState(head.state, load);
  const change = Object.values(state.changes)[0]!;
  const cache = new RetentionCache();
  const staged = new Map([[change, f.objects.get(change)!]]);
  const options = {cache, staged, durable: (h: string) => !staged.has(h)};
  await verifyIntentRetention([head.state], load, options);
  await verifyIntentRetention([head.state], load, options);
  f.objects.delete(change);
  staged.clear();
  const sibling = storeIntentState(state, put, false);
  await expect(verifyIntentRetention([sibling], load, options)).rejects.toThrow("Missing object");
});
