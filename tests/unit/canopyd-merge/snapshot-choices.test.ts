import { expect, test } from "bun:test";
import { checkpointIntent } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import { loadIntentState } from "../../../packages/canopyd-merge/src/state-storage.ts";
import { Fixture } from "./fixture.ts";

type State = { object: string; state: string };

/** A state reference with its retained decisions, readable like an evaluation. */
async function read(f: Fixture, ref: State) {
  const state = await loadIntentState(ref.state, async (hash) => f.objects.get(hash)!);
  return { ...ref, result: ref, decisions: state.decisions };
}

/** A snapshot (no trace) as canopyd checkpoints it onto the current state. */
async function snapshot(f: Fixture, current: State, files: Record<string, string>, change: string,
  decisions: Parameters<typeof checkpointIntent>[0]["decisions"] = []) {
  const response = await checkpointIntent(
    { kind: "checkpoint", tree: "tree", current, projection: f.tree(files), candidate: f.tree(files),
      continueSelected: true, conflictProjection: "current", change, decisions },
    {
      read: async (hash) => f.objects.get(hash)!,
      store: async (values) => { for (const value of values) f.objects.set(value.hash, value.bytes); },
    },
  );
  if (!("result" in response)) throw new Error(JSON.stringify(response));
  return read(f, response.result);
}

async function deleteVersusEdit(f: Fixture) {
  const base = f.tree({ "a.txt": "old", "b.txt": "bee" });
  const remote = await f.run(f.request(base, f.tree({ "a.txt": "new", "b.txt": "bee" }),
    [{ key: "edit", kind: "editSource", source: f.ref("/a.txt", "old"), text: "new" }], "remote"));
  return f.run(f.request(base, f.tree({ "b.txt": "bee" }),
    [{ key: "delete", kind: "removeEntry", source: f.ref("/a.txt", "old") }], "local", remote.result));
}

test("an unrelated snapshot neither encloses nor withholds an open file choice", async () => {
  const f = new Fixture(), open = await deleteVersusEdit(f);
  const next = await snapshot(f, open.result, { "b.txt": "BEE" }, "snapshot");
  expect(next.decisions.map((d) => [d.kind, d.key])).toEqual([["existence", open.decisions[0]!.key]]);
  expect(next.decisions[0]!.context).toBeUndefined();
  expect(next.object).toBe(f.tree({ "b.txt": "BEE" }));
});

test("a snapshot that edits the kept file continues that alternative", async () => {
  const f = new Fixture(), base = f.tree({ "a.txt": "old", "b.txt": "bee" });
  const deleted = await f.run(f.request(base, f.tree({ "b.txt": "bee" }),
    [{ key: "delete", kind: "removeEntry", source: f.ref("/a.txt", "old") }], "remote"));
  // The kept (edited) file is what shows; the deletion is the other alternative.
  const open = await f.run(f.request(base, f.tree({ "a.txt": "new", "b.txt": "bee" }),
    [{ key: "edit", kind: "editSource", source: f.ref("/a.txt", "old"), text: "new" }], "local", deleted.result));
  const decision = open.decisions[0]!;
  expect(decision.alternatives[decision.selected]!.node).toBeDefined();
  const next = await snapshot(f, open.result, { "a.txt": "newer", "b.txt": "bee" }, "snapshot");
  expect(next.decisions.map((d) => d.key)).toEqual([decision.key]);
  const continued = next.decisions[0]!;
  expect(continued.alternatives[continued.selected]!.object).toBe(f.put("newer"));
  expect(next.object).toBe(f.tree({ "a.txt": "newer", "b.txt": "bee" }));
});

test("a whole-tree choice continues its displayed tree through a snapshot", async () => {
  const f = new Fixture(), base = f.tree({ "a.txt": "old" });
  const remote = await f.run(f.request(base, f.tree({ "a.txt": "new" }),
    [{ key: "edit", kind: "editSource", source: f.ref("/a.txt", "old"), text: "new" }], "remote"));
  const open = await snapshot(f, remote.result, { "a.txt": "new" }, "legacy", [{
    key: "whole", selected: 0,
    alternatives: [{ object: remote.result.object, contributions: [] }, { object: base, contributions: [] }],
  }]);
  expect(open.decisions.map((d) => d.kind)).toEqual(["directory"]);
  const next = await snapshot(f, open.result, { "a.txt": "new", "b.txt": "added" }, "snapshot");
  expect(next.decisions.map((d) => d.key)).toEqual(["whole"]);
  expect(next.object).toBe(f.tree({ "a.txt": "new", "b.txt": "added" }));
  const whole = next.decisions[0]!;
  expect(whole.alternatives[whole.selected]!.object).toBe(next.object);
});

test("a legacy delete-versus-edit becomes a choice about the file", async () => {
  const f = new Fixture(), base = f.tree({ "a.txt": "old", "b.txt": "bee" });
  const start = await f.run(f.request(base, f.tree({ "a.txt": "new", "b.txt": "bee" }),
    [{ key: "edit", kind: "editSource", source: f.ref("/a.txt", "old"), text: "new" }], "start"));
  const initial = start.result;
  const kept = f.tree({ "a.txt": "new", "b.txt": "bee" }), removed = f.tree({ "b.txt": "bee" });
  const next = await snapshot(f, initial, { "a.txt": "new", "b.txt": "bee" }, "legacy", [{
    key: "legacy-a", path: ["a.txt"], selected: 0,
    alternatives: [{ object: kept, contributions: [] }, { object: removed, contributions: [] }],
  }]);
  expect(next.decisions.map((d) => [d.kind, d.key])).toEqual([["existence", "legacy-a"]]);
  const decision = next.decisions[0]!;
  expect(decision.alternatives.map((a) => a.node !== undefined)).toEqual([true, false]);
  const later = await snapshot(f, next.result, { "a.txt": "new", "b.txt": "BEE" }, "unrelated");
  expect(later.decisions.map((d) => [d.kind, d.key])).toEqual([["existence", "legacy-a"]]);
});
