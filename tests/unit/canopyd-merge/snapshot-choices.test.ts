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

/** A checkpoint of an arbitrary root, for trees with folders. */
async function checkpoint(f: Fixture, current: { object: string; state?: string }, projection: string, change: string,
  decisions: Parameters<typeof checkpointIntent>[0]["decisions"] = []) {
  const response = await checkpointIntent(
    { kind: "checkpoint", tree: "tree", current, projection, candidate: projection,
      continueSelected: true, conflictProjection: "current", change, decisions },
    {
      read: async (hash) => f.objects.get(hash)!,
      store: async (values) => { for (const value of values) f.objects.set(value.hash, value.bytes); },
    },
  );
  return read(f, response.result);
}

async function folderChoice(f: Fixture) {
  const folder = (text: string) => f.dir([{ name: "x.txt", file: f.put(text) }]);
  const root = (docs: string, other = "bee") => f.dir([{ name: "docs", directory: docs }, { name: "b.txt", file: f.put(other) }]);
  const initial = await checkpoint(f, { object: root(folder("old")) }, root(folder("old")), "initial");
  const shown = root(folder("mine")), incoming = root(folder("theirs"));
  const open = await checkpoint(f, initial.result, shown, "conflict", [{
    key: "folder", path: ["docs"], selected: 0,
    alternatives: [{ object: shown, contributions: [] }, { object: incoming, contributions: [{ change: "conflict", operation: null }] }],
  }]);
  return { folder, root, open };
}

test("a folder choice keeps the folder's versions and its displayed folder", async () => {
  const f = new Fixture(), { folder, open } = await folderChoice(f);
  expect(open.decisions).toHaveLength(1);
  const decision = open.decisions[0]!;
  expect(decision.kind).toBe("directory");
  expect(decision.subject?.material).toMatchObject({ kind: "basis", path: "/docs", object: folder("mine") });
  expect(decision.alternatives.map((a) => a.object)).toEqual([folder("mine"), folder("theirs")]);
  expect(decision.alternatives.map((a) => a.node !== undefined)).toEqual([true, false]);
  expect(decision.affected).toEqual([decision.alternatives[0]!.node!]);
});

test("a folder choice is untouched by edits elsewhere and continues edits inside its folder", async () => {
  const f = new Fixture(), { folder, root, open } = await folderChoice(f);
  const elsewhere = await checkpoint(f, open.result, root(folder("mine"), "BEE"), "elsewhere");
  expect(elsewhere.decisions.map((d) => [d.key, d.context])).toEqual([["folder", undefined]]);
  expect(elsewhere.object).toBe(root(folder("mine"), "BEE"));
  const inside = await checkpoint(f, elsewhere.result, root(folder("mine, edited"), "BEE"), "inside");
  const continued = inside.decisions[0]!;
  expect(inside.decisions.map((d) => [d.key, d.context])).toEqual([["folder", undefined]]);
  expect(inside.object).toBe(root(folder("mine, edited"), "BEE"));
  expect(continued.alternatives.map((a) => a.object)).toEqual([folder("mine, edited"), folder("theirs")]);
  expect(continued.alternatives[0]!.contributions).toContainEqual({ change: "inside", operation: null });
  // A traced edit inside the folder continues the displayed alternative too.
  const traced = await f.run(f.request(inside.result, root(folder("traced"), "BEE"),
    [{ key: "edit", kind: "editSource", source: f.ref("/docs/x.txt", "mine, edited"), text: "traced" }], "traced"));
  const after = traced.decisions.find((d) => d.key === "folder")!;
  expect(after.context).toBeUndefined();
  expect(after.alternatives.map((a) => a.object)).toEqual([folder("traced"), folder("theirs")]);
});

test("a snapshot removing a folder with an open folder choice is withheld behind a choice", async () => {
  const f = new Fixture(), { open } = await folderChoice(f);
  const removed = f.dir([{ name: "b.txt", file: f.put("bee") }]);
  const next = await checkpoint(f, open.result, removed, "remove");
  // The folder choice stays as it was; the removal is the enclosing choice's alternative.
  expect(next.object).toBe(open.object);
  expect(next.decisions.map((d) => [d.key, d.dependencies])).toEqual([["folder", []], ["snapshot:remove", ["folder"]]]);
  expect(next.decisions[1]!.alternatives.map((a) => a.object)).toContain(removed);
});

test("a traced removal of a folder with an open folder choice encloses the choice", async () => {
  const f = new Fixture(), { folder, open } = await folderChoice(f);
  const removed = f.dir([{ name: "b.txt", file: f.put("bee") }]);
  const next = await f.run(f.request(open.result, removed,
    [{ key: "remove", kind: "removeEntry", source: { material: { kind: "basis", path: "/docs", object: folder("mine") } } }], "remove"));
  expect(next.decisions.find((d) => d.key === "folder")!.context).toBeDefined();
  expect(next.decisions.some((d) => d.dependencies.includes("folder"))).toBe(true);
});
