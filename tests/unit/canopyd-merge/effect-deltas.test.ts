import { test, expect } from "bun:test";
import type { SourceOperation } from "@overstory/protocol";
import { mergeIntent } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import { type Effect, type IntentState } from "../../../packages/canopyd-merge/src/intent-model.ts";
import { pieceEdits, pieceSlice } from "../../../packages/canopyd-merge/src/pieces.ts";
import { Fixture } from "./fixture.ts";

type State = { object: string; state: string };

function objects(f: Fixture) {
  return {
    read: async (hash: string) => f.objects.get(hash)!,
    states: f.states,
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
      for (const value of values) f.objects.set(value.hash, value.bytes);
    },
  };
}

async function load(f: Fixture, state: State): Promise<IntentState> {
  return f.state(state);
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
      // The delta is exactly the piece edits between the file's whole pieces
      // before and after, which the record no longer copies.
      const recomputed: Effect["edits"] = {};
      for (const id of Object.keys(effect.before)) {
        const before = previous.nodes[id]!.pieces!, after = state.nodes[id]!.pieces!;
        const edits = pieceEdits(before, after).map((edit) => ({ range: edit.range, removed: pieceSlice(before, ...edit.range), inserted: edit.pieces }));
        if (edits.length) recomputed[id] = edits;
      }
      expect(recomputed).toEqual(effect.edits);
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
