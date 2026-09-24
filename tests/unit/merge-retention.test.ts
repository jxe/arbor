import { test, expect } from "bun:test";
import { encodeWireDirectory, hashObject } from "@overstory/protocol";
import { retentionAudit } from "../../packages/canopyd-merge/src/retention.ts";
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

/** A fresh audit of one or more roots, as the worker's audit request runs it. */
const audit = (load: (hash: string) => Promise<Uint8Array>, roots: string[]) => retentionAudit(load)(roots, true);

test("the audit returns a state's exact closure and rejects a missing or corrupt object", async () => {
  const f = fixture();
  const closure = await audit(f.load, [f.state]);
  expect(closure.has(f.state)).toBe(true);
  expect(closure.has(f.directoryOf())).toBe(true);
  expect(closure.has(f.file)).toBe(true);
  f.objects.set(f.file, new TextEncoder().encode("corrupt"));
  await expect(audit(f.load, [f.state])).rejects.toThrow("Invalid retained object hash");
  f.objects.delete(f.file);
  await expect(audit(f.load, [f.state])).rejects.toThrow("Missing object");
});

test("an audit shares history across records and union traversal without trusting earlier audits", async () => {
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
  const expected = await audit(f.load, [roots.at(-1)!]);
  const perRoot = retentionAudit(f.load);
  const before = f.reads();
  for (const root of roots) await perRoot([root]);
  // Per root: its own parts plus one rewritten map leaf, not every earlier change.
  expect(f.reads()-before).toBeLessThan(roots.length*16);
  expect(await perRoot(roots,true)).toEqual(expected);
  const unionAudit=retentionAudit(f.load);
  expect(await unionAudit(roots,true)).toEqual(expected);
  // A union never becomes an incorrectly broad closure for its first root.
  expect(await unionAudit([f.state])).toEqual(await audit(f.load, [f.state]));
  f.objects.delete(f.file);
  await expect(audit(f.load, roots)).rejects.toThrow("Missing object");
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
  const walked = await audit(load, [head.state]);
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
  await expect(audit(load, [head.state])).rejects.toThrow("Missing object");
});

test("history maps are typed by their field: a map in another role is rejected", async () => {
  const { f, head, load, put } = await indexedHistory();
  const manifest = JSON.parse(new TextDecoder().decode(f.objects.get(head.state)!));
  manifest.maps.effects = manifest.maps.changes;
  const wrongRole = put(new TextEncoder().encode(JSON.stringify(manifest)));
  await expect(audit(load, [wrongRole])).rejects.toThrow();
});
