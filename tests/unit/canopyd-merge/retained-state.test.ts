import { expect, test } from "bun:test";
import type { IntentState } from "../../../packages/canopyd-merge/src/intent-model.ts";
import { loadState, retainState, viewState, type RetainedState } from "../../../packages/canopyd-merge/src/retained-state.ts";

const piece = (origin: string) => ({ origin, start: 0, object: `sha256:${"a".repeat(64)}`, offset: 0, length: 3 });
function state(order: number[]): IntentState {
  const value: IntentState = {
    format: "arbor-merge-intent-state", tree: "tree", root: "root",
    nodes: { root: { id: "root", parent: null, name: "", kind: "directory", object: `sha256:${"b".repeat(64)}`, active: true } },
    outputs: {}, alternatives: {}, origins: {}, effects: {}, changes: {}, decisions: [],
  };
  for (const i of order) {
    value.origins[`origin-${i}`] = [piece(`from-${i}`)];
    value.changes[`change-${i}`] = `sha256:${String(i).padStart(64, "0")}`;
  }
  return value;
}
const view = (states: Map<string, RetainedState>, id: string) => viewState(states.get(id)!);

test("equal content recorded in any order is one state, with one key order", () => {
  const states = new Map<string, RetainedState>();
  const forward = Array.from({ length: 40 }, (_, i) => i);
  const a = retainState(states, state(forward), "object", true);
  const b = retainState(states, state([...forward].reverse()), "object", true);
  expect(b.id).toBe(a.id);
  expect(b.bytes).toBe(0);
  expect(states.size).toBe(1);
  // More than sixteen history keys are in bucket order, not insertion or key order.
  const keys = Object.keys(view(states, a.id).origins);
  expect(keys).not.toEqual(Object.keys(state(forward).origins));
  expect(keys).not.toEqual(Object.keys(state(forward).origins).sort());
  const fresh = new Map<string, RetainedState>();
  const c = retainState(fresh, state([...forward].reverse()), "object", true);
  expect(Object.keys(view(fresh, c.id).origins)).toEqual(keys);
});

test("a recorded state is frozen, and editability is part of its identity", () => {
  const states = new Map<string, RetainedState>();
  const editable = retainState(states, state([1, 2]), "object", true);
  const scanned = retainState(states, state([1, 2]), "object", false);
  expect(scanned.id).not.toBe(editable.id);
  const recorded = view(states, editable.id);
  expect(Object.isFrozen(recorded.origins["origin-1"]![0])).toBe(true);
  expect(() => { (recorded.nodes.root as { active: boolean }).active = false; }).toThrow();
  // A loaded copy can be edited.
  const copy = loadState(states.get(editable.id)!);
  copy.nodes.root!.active = false;
  expect(recorded.nodes.root!.active).toBe(true);
});

test("recording an edited copy shares what it did not change", () => {
  const states = new Map<string, RetainedState>();
  const history = Array.from({ length: 200 }, (_, i) => i);
  const first = retainState(states, state(history), "object", true);
  const copy = loadState(states.get(first.id)!);
  copy.origins["origin-new"] = [piece("from-new")];
  const second = retainState(states, copy, "object", true);
  const [before, after] = [states.get(first.id)!, states.get(second.id)!];
  expect(second.id).not.toBe(first.id);
  expect(after.nodes).toBe(before.nodes);
  expect(after.history.changes).toBe(before.history.changes);
  expect(after.history.origins).not.toBe(before.history.origins);
  expect(view(states, second.id).origins["origin-1"]).toBe(view(states, first.id).origins["origin-1"]);
  // One new record and the buckets on its path, not a copy of the history.
  expect(second.bytes).toBeLessThan(first.bytes / 10);
  // Equal values recorded separately are one object.
  const again = retainState(new Map(), state(history), "object", false);
  expect(again.bytes).toBeLessThan(first.bytes);
});

test("equal values share one frozen object, but a loaded copy shares nothing", () => {
  const states = new Map<string, RetainedState>();
  const value = state([1]);
  value.decisions.push({ key: "choice", kind: "directory", affected: ["root"], selected: 0, dependencies: [], reason: "test",
    alternatives: [{ state: `sha256:${"c".repeat(64)}`, object: `sha256:${"d".repeat(64)}`, contributions: [] },
      { state: `sha256:${"c".repeat(64)}`, object: `sha256:${"e".repeat(64)}`, contributions: [] }] });
  const { id } = retainState(states, value, "object", true);
  const recorded = states.get(id)!.decisions[0]!;
  expect(recorded.dependencies as unknown).toBe(recorded.alternatives[0]!.contributions);
  const loaded = loadState(states.get(id)!).decisions[0]!;
  loaded.alternatives[0]!.contributions.push({ change: "c", operation: null });
  expect(loaded.dependencies).toEqual([]);
  expect(loaded.alternatives[1]!.contributions).toEqual([]);
});

/** Every state `f` recorded, plus one with bucketed history records and
 * integer-like keys, encoded as the sidecar saves them. */
async function recorded() {
  const { Fixture } = await import("./fixture.ts");
  const f = new Fixture();
  const base = f.tree({ "a.md": "hello world" });
  const mine = await f.run(f.request(base, f.tree({ "a.md": "HELLO world" }), [
    { kind: "editSource", key: "mine", source: f.ref("/a.md", "hello world", [0, 5]), text: "HELLO" },
  ], "mine"));
  // A concurrent edit of the same range: a retained decision naming other states.
  const theirs = await f.run(f.request(base, f.tree({ "a.md": "Howdy world" }), [
    { kind: "editSource", key: "theirs", source: f.ref("/a.md", "hello world", [0, 5]), text: "Howdy" },
  ], "theirs", mine.result));
  expect(f.state(theirs.result).decisions.length).toBeGreaterThan(0);
  const wide = state(Array.from({ length: 40 }, (_, i) => i));
  const node = (i: number) => ({ id: `n${i}`, parent: "root", name: `file-${i}.md`, kind: "file" as const, object: `sha256:${"c".repeat(64)}`, active: true });
  const before = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`n${i}`, node(i)]));
  wide.effects.large = { authored: { operation: "op", basis: "b" }, change: "c", operation: "op", kind: "removeEntry",
    before, after: {}, edits: {}, undone: false };
  wide.changes["10"] = "ten";
  wide.changes["9"] = "nine";
  retainState(f.states, wide, "object", false);
  return f.states;
}

test("a saved state decodes to the same identity, values and key order", async () => {
  const { encodeRetainedState, decodeRetainedState } = await import("../../../packages/canopyd-merge/src/retained-state.ts");
  const states = await recorded();
  const saved = [...states].map(([id, retained]) => ({ id, text: JSON.stringify(encodeRetainedState(retained)), view: JSON.stringify(viewState(retained)) }));
  // In this process, where the values are interned, and in a fresh one, where nothing is.
  for (const { id, text, view } of saved) {
    const decoded = decodeRetainedState(JSON.parse(text));
    expect(decoded.id).toBe(id);
    expect(JSON.stringify(viewState(decoded.state))).toBe(view);
    expect(decoded.state.editable).toBe(states.get(id)!.editable);
  }
  const module = new URL("../../../packages/canopyd-merge/src/retained-state.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    import { decodeRetainedState, viewState } from ${JSON.stringify(module)};
    const saved = JSON.parse(await Bun.stdin.text());
    console.log(JSON.stringify(saved.map(({ text }) => { const d = decodeRetainedState(JSON.parse(text)); return { id: d.id, view: JSON.stringify(viewState(d.state)) }; })));
  `], { stdin: new Blob([JSON.stringify(saved)]), stdout: "pipe", stderr: "inherit" });
  const fresh = JSON.parse(await new Response(child.stdout).text()) as Array<{ id: string; view: string }>;
  expect(await child.exited).toBe(0);
  expect(fresh).toEqual(saved.map(({ id, view }) => ({ id, view })));
  // The large record is bucketed: its keys are in neither insertion nor key order.
  const large = Object.keys(JSON.parse(saved.find(({ view }) => JSON.parse(view).effects.large)!.view).effects.large.before);
  expect(large).not.toEqual([...large].sort());
  expect(large).not.toEqual(Array.from({ length: 40 }, (_, i) => `n${i}`));
});

test("a saved state whose content changed decodes to another identity", async () => {
  const { encodeRetainedState, decodeRetainedState } = await import("../../../packages/canopyd-merge/src/retained-state.ts");
  const states = new Map<string, RetainedState>();
  const { id } = retainState(states, state([1, 2]), "object", true);
  const saved = JSON.parse(JSON.stringify(encodeRetainedState(states.get(id)!)));
  saved.root = "elsewhere";
  expect(decodeRetainedState(saved).id).not.toBe(id);
  expect(() => decodeRetainedState({ ...saved, nodes: { entries: "no" } })).toThrow("Invalid saved bucket");
});
