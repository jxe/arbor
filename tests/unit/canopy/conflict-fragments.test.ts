import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FragmentStore, type Choice } from "../../../packages/canopy/src/experimental/conflict-fragments/store.ts";
import { partitionSourceRegions } from "../../../packages/canopy/src/updates/source-regions.ts";
import { hashObject } from "@arbor/wire";

let dir: string, filename: string, store: FragmentStore;
const owner = "owner", tree = "tree", decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/arbor-fragments-`); filename = `${dir}/experiment.sqlite3`;
  store = new FragmentStore(filename); store.create(tree, owner);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const reopen = () => { store.close(); store = new FragmentStore(filename); };
function choice(id: string, left: string, right: string): Choice {
  return { kind: "choice", id, selected: `${id}-a`, alternatives: [
    { id: `${id}-a`, revision: `${id}-ra`, node: left, contributions: [{ change: "a", operation: id }] },
    { id: `${id}-b`, revision: `${id}-rb`, node: right, contributions: [{ change: "b", operation: id }] },
  ] };
}
function fixture() {
  const source = new TextEncoder().encode("\ufeffone / two\r\n"), object = store.object(source);
  const contributions = [
    { change: "a", operation: "first", range: [3,6] as [number,number], text: "ONE" },
    { change: "b", operation: "first", range: [3,6] as [number,number], text: "Uno" },
    { change: "a", operation: "second", range: [9,12] as [number,number], text: "TWO" },
    { change: "b", operation: "second", range: [9,12] as [number,number], text: "Dos" },
  ].map(e => ({ change: e.change, edit: { operation: e.operation, path: "/nested/note.md", source: { object, range: e.range }, text: e.text, lineage: [] } }));
  const layout = partitionSourceRegions("/nested/note.md", object, source, contributions);
  const children: string[] = []; let cursor = 0;
  layout.regions.forEach((region, index) => {
    children.push(store.put({ kind: "slice", object, range: [cursor, region.range[0]] }));
    const id = `d${index}`;
    children.push(store.put({ kind: "choice", id, selected: `${id}-a`, alternatives: region.alternatives.map(a => ({
      id: `${id}-${a.change}`, revision: `${id}-r${a.change}`, node: store.text(a.text),
      contributions: a.operations.map(operation => ({ change: a.change, operation })),
    })) })); cursor = region.range[1];
  });
  children.push(store.put({ kind: "slice", object, range: [cursor, source.length] }));
  const file = store.put({ kind: "sequence", children });
  const nested = store.put({ kind: "directory", entries: [{ name: "note.md", node: file }] });
  const graph = store.put({ kind: "directory", entries: [{ name: "nested", node: nested }] });
  return { graph, nested, object, state: store.commit(tree, owner, null, "initial", graph) };
}
function guard(id: string) { return { conflict: id, alternatives: [`${id}-a`, `${id}-b`] }; }

test("two regional choices persist and resolve independently after a length-changing hidden edit", () => {
  const { state } = fixture();
  expect(decode(store.file(tree, owner, ["nested", "note.md"]))).toBe("\ufeffONE / TWO\r\n");
  const hidden = store.editAlternative(state.graph, "d0", "d0-b", "d0-rb", store.text("Much longer é"), { change: "c", operation: "edit-hidden" });
  const edited = store.commit(tree, owner, state.id, "hidden", hidden);
  expect(edited.root).toBe(state.root); expect(edited.id).not.toBe(state.id);
  reopen();
  const inspection = store.inspect(tree, owner);
  expect(inspection.choices).toHaveLength(2);
  expect(inspection.choices[0]!.choice.alternatives[1]!.contributions.at(-1)).toEqual({ change: "c", operation: "edit-hidden" });
  expect(decode(store.alternative(tree, owner, edited.id, "d0", "d0-b"))).toBe("Much longer é");
  expect(decode(store.alternative(tree, owner, state.id, "d0", "d0-b"))).toBe("Uno");
  const resolved = store.resolve(edited.graph, "d0", "d0-b");
  const partial = store.commit(tree, owner, edited.id, "partial", resolved, [guard("d0")]);
  expect(decode(store.file(tree, owner, ["nested", "note.md"]))).toBe("\ufeffMuch longer é / TWO\r\n");
  expect(store.inspect(tree, owner).choices.map(c => c.choice.id)).toEqual(["d1"]);
  expect(partial.conflicted).toBe(true);
  // Exact retry returns its original accepted identity even after another commit.
  const completeGraph = store.resolve(partial.graph, "d1", "d1-b");
  const complete = store.commit(tree, owner, partial.id, "complete", completeGraph, [guard("d1")]);
  expect(complete.conflicted).toBe(false);
  expect(decode(store.file(tree, owner, ["nested", "note.md"]))).toBe("\ufeffMuch longer é / Dos\r\n");
  expect(store.commit(tree, owner, edited.id, "partial", resolved, [guard("d0")])).toEqual(partial);
  reopen();
  expect(store.inspect(tree, owner, state.id).choices).toHaveLength(2);
  expect(decode(store.file(tree, owner, ["nested", "note.md"], state.id))).toBe("\ufeffONE / TWO\r\n");
});

test("a selected fragment can change length without changing the other decision", () => {
  const { state } = fixture();
  const before = store.inspect(tree, owner).choices[1]!;
  const db = new Database(filename);
  const count = () => (db.query("SELECT COUNT(*) AS n FROM fragment_nodes").get() as { n: number }).n;
  const nodes = count();
  const graph = store.editAlternative(state.graph, "d0", "d0-a", "d0-ra", store.text("X"), { change: "c", operation: "shorten" });
  // New text, choice, sequence and two directory ancestors; siblings are shared.
  expect(count() - nodes).toBe(5); db.close();
  store.commit(tree, owner, state.id, "edit", graph);
  expect(store.inspect(tree, owner).choices[1]).toEqual(before);
  expect(decode(store.file(tree, owner, ["nested", "note.md"]))).toBe("\ufeffX / TWO\r\n");
  expect(() => store.editAlternative(graph, "d0", "d0-a", "d0-ra", store.text("lost"), { change: "d", operation: "stale" })).toThrow("Stale alternative");
});

test("ancestor deletion retains nested decisions and guards their explicit dismissal", () => {
  const { state, nested } = fixture();
  const ancestor = choice("parent", nested, store.put({ kind: "absent" }));
  ancestor.selected = "parent-b";
  const graph = store.put({ kind: "directory", entries: [{ name: "nested", node: store.put(ancestor) }] });
  const deleted = store.commit(tree, owner, state.id, "delete", graph);
  expect(deleted.conflicted).toBe(true);
  expect(store.inspect(tree, owner).choices.find(c => c.choice.id === "d0")!.ancestors)
    .toEqual([{ conflict: "parent", alternative: "parent-a" }]);
  expect(() => store.file(tree, owner, ["nested", "note.md"])).toThrow();
  reopen();
  const editedGraph = store.editAlternative(graph, "d1", "d1-b", "d1-rb", store.text("Hidden descendant"), { change: "d", operation: "edit" });
  const edited = store.commit(tree, owner, deleted.id, "hidden-descendant", editedGraph);
  expect(edited.root).toBe(deleted.root);
  expect(store.inspect(tree, owner).choices[0]!.choice.alternatives[0]!.revision).not.toBe("parent-ra");
  const discarded = store.resolve(editedGraph, "parent", "parent-b");
  expect(() => store.commit(tree, owner, edited.id, "bad-resolution", discarded, [guard("parent")])).toThrow("decision would be lost");
  const done = store.commit(tree, owner, edited.id, "discard", discarded, [guard("parent"), guard("d0"), guard("d1")]);
  expect(done.conflicted).toBe(false); expect(done.root).toBe(deleted.root);
  expect(store.inspect(tree, owner, edited.id).choices).toHaveLength(3);
});

test("keeping an ancestor preserves its nested choices", () => {
  const { state, nested } = fixture();
  const graph = store.put({ kind: "directory", entries: [{ name: "nested", node: store.put(choice("parent", nested, store.put({ kind: "absent" }))) }] });
  const coupled = store.commit(tree, owner, state.id, "coupled", graph);
  const kept = store.commit(tree, owner, coupled.id, "keep", store.resolve(graph, "parent", "parent-a"), [guard("parent")]);
  expect(kept.conflicted).toBe(true);
  expect(store.inspect(tree, owner).choices.map(c => c.choice.id)).toEqual(["d0", "d1"]);
});

test("equal bytes retain identities, hidden roots, and complete resolution guards", () => {
  const equal = store.text("same");
  const graph = store.put({ kind: "directory", entries: [{ name: "note.md", node: store.put(choice("same", equal, equal)) }] });
  const state = store.commit(tree, owner, null, "initial", graph);
  expect(state.conflicted).toBe(true);
  const next = store.resolve(graph, "same", "same-a");
  expect(() => store.commit(tree, owner, state.id, "bad", next, [{ conflict: "same", alternatives: ["same-a"] }])).toThrow("Incomplete");
  const done = store.commit(tree, owner, state.id, "resolve", next, [guard("same")]);
  expect(done.root).toBe(state.root); expect(done.id).not.toBe(state.id);
  expect(() => store.commit(tree, owner, state.id, "stale", next, [guard("same")])).toThrow("Stale accepted");
  expect(() => store.commit(tree, owner, state.id, "resolve", graph, [guard("same")])).toThrow("Request identity reused");
  expect(() => store.commit(tree, "intruder", done.id, "intrusion", next)).toThrow("access denied");
  store.create("other", owner);
  expect(() => store.state("other", owner, state.id)).toThrow("not retained");
});

test("failed authority transaction cannot publish a head or receipt", () => {
  const { state } = fixture();
  const graph = store.resolve(state.graph, "d0", "d0-a");
  const db = new Database(filename);
  db.run("CREATE TRIGGER fail_receipt BEFORE INSERT ON fragment_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(() => store.commit(tree, owner, state.id, "retry", graph, [guard("d0")])).toThrow("injected");
  expect(store.state(tree, owner)).toEqual(state);
  expect(db.query("SELECT COUNT(*) AS n FROM fragment_states").get()).toEqual({ n: 1 });
  db.run("DROP TRIGGER fail_receipt"); db.close(); reopen();
  const accepted = store.commit(tree, owner, state.id, "retry", graph, [guard("d0")]);
  expect(accepted.previous).toBe(state.id);
});

test("validates hidden objects, scalar boundaries and occurrence identities", () => {
  const invalid = store.put({ kind: "slice", object: hashObject(new Uint8Array()), range: [0,0] });
  const graph = store.put({ kind: "directory", entries: [{ name: "note", node: store.put(choice("d", store.text("okay"), invalid)) }] });
  expect(() => store.commit(tree, owner, null, "bad", graph)).toThrow("Missing or corrupt");
  const bytes = new TextEncoder().encode("é"), object = store.object(bytes);
  const split = store.put({ kind: "slice", object, range: [1,2] });
  const bad = store.put({ kind: "directory", entries: [{ name: "note", node: split }] });
  expect(() => store.commit(tree, owner, null, "bad", bad)).toThrow("Invalid source slice");
  const sameChoice = store.put(choice("repeated", store.text("a"), store.text("b")));
  const repeated = store.put({ kind: "directory", entries: [{ name: "first", node: sameChoice }, { name: "second", node: sameChoice }] });
  expect(() => store.commit(tree, owner, null, "bad", repeated)).toThrow("Invalid choice identity");
});

test("refuses a database belonging to Canopy", () => {
  const file = `${dir}/canopy.sqlite3`, db = new Database(file);
  db.run("CREATE TABLE accepted_updates (id TEXT)"); db.close();
  expect(() => new FragmentStore(file)).toThrow("separate database");
});

test("an opaque replacement can wrap the old graph without enumerating its combinations", () => {
  const { state, nested } = fixture();
  const old = store.node(nested);
  if (old.kind !== "directory") throw new Error("fixture");
  const opaque = choice("snapshot", old.entries[0]!.node, store.text("Opaque new contents\r\n"));
  opaque.selected = "snapshot-b";
  const directory = store.put({ kind: "directory", entries: [{ name: "note.md", node: store.put(opaque) }] });
  const graph = store.put({ kind: "directory", entries: [{ name: "nested", node: directory }] });
  const accepted = store.commit(tree, owner, state.id, "snapshot", graph);
  expect(store.inspect(tree, owner).choices).toHaveLength(3);
  expect(decode(store.file(tree, owner, ["nested", "note.md"]))).toBe("Opaque new contents\r\n");
  reopen();
  expect(decode(store.alternative(tree, owner, accepted.id, "d0", "d0-b"))).toBe("Uno");
  // Keeping the previous compound alternative restores both independent choices.
  store.commit(tree, owner, accepted.id, "restore", store.resolve(graph, "snapshot", "snapshot-a"), [guard("snapshot")]);
  expect(store.inspect(tree, owner).choices.map(c => c.choice.id)).toEqual(["d0", "d1"]);
  expect(decode(store.file(tree, owner, ["nested", "note.md"]))).toBe("\ufeffONE / TWO\r\n");
});
