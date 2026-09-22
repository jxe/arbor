import { test, expect } from "bun:test";
import type { SourceOperation } from "@overstory/protocol";
import { effectEdits, mergeIntent } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import { intentDependencies, type Effect, type IntentState } from "../../../packages/canopyd-merge/src/intent-model.ts";
import { loadIntentState } from "../../../packages/canopyd-merge/src/state-storage.ts";
import { Fixture } from "./fixture.ts";

type State = { object: string; state: string };

function objects(f: Fixture) {
  return {
    read: async (hash: string) => f.objects.get(hash)!,
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
}

async function load(f: Fixture, state: State): Promise<IntentState> {
  return loadIntentState(state.state, async (hash) => f.objects.get(hash)!);
}

/** Edits that grow one file's piece count: inserts spread through the text,
 * with a deletion every third step. */
async function history(f: Fixture, count: number) {
  let text = "alpha beta gamma delta epsilon\n";
  const root = f.tree({ "a.md": text });
  const start: SourceOperation = { kind: "editSource", key: "edit", source: f.ref("/a.md", text, [0, 0]), text: "" };
  const first = await mergeIntent(f.request(root, root, [start], "start"), objects(f));
  if (first.outcome !== "evaluated") throw Error(JSON.stringify(first));
  const steps: Array<{ state: State; effect: string }> = [];
  let current = first.result;
  for (let i = 1; i <= count; i++) {
    const at = Math.floor((text.length * (i % 7)) / 7);
    const range: [number, number] = i % 3 === 0 ? [at, Math.min(at + 2, text.length - 1)] : [at, at];
    const inserted = i % 3 === 0 ? "" : `w${i} `;
    const op: SourceOperation = { kind: "editSource", key: "edit", source: f.ref("/a.md", text, range), text: inserted };
    text = text.slice(0, range[0]) + inserted + text.slice(range[1]);
    const response = await mergeIntent(f.request(current, f.tree({ "a.md": text }), [op], `step-${i}`), objects(f));
    if (response.outcome !== "evaluated") throw Error(JSON.stringify(response));
    current = response.result;
    steps.push({ state: current, effect: `step-${i}` });
  }
  return steps;
}

function effectFor(state: IntentState, change: string): Effect {
  const found = Object.values(state.effects).find((effect) => effect.change === change);
  if (!found) throw Error(`No effect for ${change}`);
  return found;
}

test("an editSource effect stores its piece delta and no whole piece copies", async () => {
  const f = new Fixture();
  const steps = await history(f, 12);
  let previous: IntentState | undefined;
  for (const step of steps) {
    const state = await load(f, step.state);
    const effect = effectFor(state, step.effect);
    for (const node of [...Object.values(effect.before), ...Object.values(effect.after)])
      expect(node.pieces).toBeUndefined();
    expect(effect.edits).toBeDefined();
    if (previous) {
      // The legacy shape carried the file's whole pieces before and after.
      // Recomputing from those must give exactly the stored delta.
      const legacy: Effect = { ...effect, edits: undefined, before: {}, after: {} };
      for (const id of Object.keys(effect.before)) legacy.before[id] = previous.nodes[id]!;
      for (const id of Object.keys(effect.after)) legacy.after[id] = state.nodes[id]!;
      const recomputed = Object.fromEntries(Object.entries(effectEdits(legacy)).filter(([, edits]) => edits.length));
      expect(recomputed).toEqual(effect.edits!);
    }
    previous = state;
  }
});

test("effect records stay flat as a file's piece count grows", async () => {
  const f = new Fixture();
  const steps = await history(f, 60);
  const size = async (index: number) => {
    const state = await load(f, steps[index]!.state);
    return JSON.stringify(effectFor(state, steps[index]!.effect)).length;
  };
  const early = await size(4), late = await size(58);
  const pieces = Object.values((await load(f, steps[58]!.state)).nodes).reduce((n, node) => n + (node.pieces?.length ?? 0), 0);
  expect(pieces).toBeGreaterThan(30);
  // Whole copies would grow with the piece count; the delta does not.
  expect(late).toBeLessThan(early * 2);
});

test("delta records retain the same objects as whole-copy records", async () => {
  const f = new Fixture();
  const steps = await history(f, 30);
  const states = await Promise.all(steps.map((step) => load(f, step.state)));
  const last = states.at(-1)!;
  const legacy: IntentState = { ...last, effects: { ...last.effects } };
  for (let i = 1; i < steps.length; i++) {
    const [key, effect] = Object.entries(last.effects).find(([, e]) => e.change === steps[i]!.effect)!;
    const rebuilt: Effect = { ...effect, edits: undefined, before: {}, after: {} };
    for (const id of Object.keys(effect.before)) rebuilt.before[id] = states[i - 1]!.nodes[id]!;
    for (const id of Object.keys(effect.after)) rebuilt.after[id] = states[i]!.nodes[id]!;
    delete rebuilt.edits;
    legacy.effects[key] = rebuilt;
  }
  expect(intentDependencies(last)).toEqual(intentDependencies(legacy));
});
