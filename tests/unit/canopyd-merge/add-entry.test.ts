import { expect, test } from "bun:test";
import type { SourceOperation } from "@overstory/protocol";
import { engineDiagnostics } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import { Fixture } from "./fixture.ts";

const add = (f: Fixture, root: string, name: string, value: { file: string } | { directory: string }, key = "add"): SourceOperation =>
  ({ key, kind: "addEntry", destination: { parent: f.root(root), name }, value });

test("addEntry creates a file, and a later edit of it has lineage", async () => {
  const f = new Fixture(), base = f.tree({ "a.md": "A" });
  const created = await f.run(f.request(base, f.tree({ "a.md": "A", "b.md": "hello" }),
    [add(f, base, "b.md", { file: f.put("hello") })], "create"));
  const next = f.tree({ "a.md": "A", "b.md": "hello, world" });
  const edited = await f.run(f.request(created.result, next,
    [{ key: "edit", kind: "editSource", source: f.ref("/b.md", "hello", [5, 5]), text: ", world" }], "edit"));
  expect(edited.result.object).toBe(next);
});

test("addEntry on an editable state takes the fast-forward path", async () => {
  const f = new Fixture(), base = f.tree({ "a.md": "A" });
  const first = await f.run(f.request(base, f.tree({ "a.md": "AB" }),
    [{ key: "edit", kind: "editSource", source: f.ref("/a.md", "A", [1, 1]), text: "B" }], "first"));
  const candidate = f.tree({ "a.md": "AB", "c.md": "new" });
  const created = await f.run(f.request(first.result, candidate,
    [add(f, f.tree({ "a.md": "AB" }), "c.md", { file: f.put("new") })], "create"));
  expect(engineDiagnostics.path).toBe(1);
  expect(created.result.object).toBe(candidate);
});

test("addEntry imports a directory value with its children", async () => {
  const f = new Fixture(), base = f.tree({ "a.md": "A" });
  const child = f.tree({ "_index.md": "Body", "note.md": "Note" });
  const candidate = f.dir([{ name: "a.md", file: f.put("A") }, { name: "dir", directory: child }]);
  const created = await f.run(f.request(base, candidate, [add(f, base, "dir", { directory: child })], "create"));
  expect(created.result.object).toBe(candidate);
  const next = f.dir([{ name: "a.md", file: f.put("A") }, { name: "dir", directory: f.tree({ "_index.md": "Body", "note.md": "Note!" }) }]);
  const edited = await f.run(f.request(created.result, next,
    [{ key: "edit", kind: "editSource", source: f.ref("/dir/note.md", "Note", [4, 4]), text: "!" }], "edit"));
  expect(edited.result.object).toBe(next);
});

test("addEntry refuses a name that already exists", async () => {
  const f = new Fixture(), base = f.tree({ "a.md": "A" });
  const response = await f.evaluate(f.request(base, f.tree({ "a.md": "B" }), [add(f, base, "a.md", { file: f.put("B") })], "clash"));
  expect(response.outcome).not.toBe("evaluated");
});

test("concurrent additions of one name leave an explicit choice", async () => {
  const f = new Fixture(), base = f.tree({ "a.md": "A" });
  const start = await f.run(f.request(base, base, [{ key: "noop", kind: "editSource", source: f.ref("/a.md", "A", [0, 0]), text: "" }], "start"));
  const mine = f.tree({ "a.md": "A", "n.md": "mine" }), theirs = f.tree({ "a.md": "A", "n.md": "theirs" });
  const remote = await f.run(f.request(start.result, theirs, [add(f, base, "n.md", { file: f.put("theirs") })], "theirs"));
  const merged = await f.run(f.request(start.result, mine, [add(f, base, "n.md", { file: f.put("mine") })], "mine", remote.result));
  expect(merged.decisions.length).toBeGreaterThan(0);
});

test("an entry operation's result keeps only its subtree, and later operations read through it", async () => {
  const f = new Fixture(), base = f.tree({ "a.md": "A", "b.md": "B" });
  const child = f.tree({ "_index.md": "Body", "note.md": "Note" });
  const copied = f.dir([
    { name: "a.md", file: f.put("A") }, { name: "b.md", file: f.put("B") },
    { name: "copy.md", file: f.put("Note") }, { name: "dir", directory: child },
  ]);
  const created = await f.run(f.request(base, copied, [
    add(f, base, "dir", { directory: child }),
    { key: "copy", kind: "copyEntry", source: { ...f.op("create", "add"), within: ["note.md"] },
      destination: { parent: f.root(base), name: "copy.md" } },
  ], "create"));
  expect(created.result.object).toBe(copied);
  const state = f.state(created.result);
  const output = Object.values(state.outputs).find((material) => material.view && state.nodes[material.node]?.name === "dir")!;
  const names = Object.values(output.view!.nodes).map((node) => node.name).sort();
  expect(output.view!.root).toBe(output.node);
  expect(names).toEqual(["_index.md", "dir", "note.md"]);
});
