import { expect, test } from "bun:test";
import { Fixture } from "./fixture.ts";
import type { FormatConfig } from "../../../packages/overstoryd-merge/src/format-rules.ts";

// Data files merge as elements (overstoryd 017 step 7): keyed members by key
// path, array items and table rows by an identifying field or by identity.

type Edit = { find: string; replace: string; occurrence?: "last" };
/** Two changes to one file from one base, merged in both orders. */
async function merge(name: string, source: string, a: Edit, b: Edit, config?: FormatConfig) {
  const results = [];
  for (const reverse of [false, true]) {
    const f = new Fixture(), base = f.tree({ [name]: source });
    const request = (edit: Edit, change: string) => {
      const index = edit.occurrence === "last" ? source.lastIndexOf(edit.find) : source.indexOf(edit.find);
      // A replacement that keeps the found text is an insertion after it.
      const keeps = edit.replace.startsWith(edit.find);
      const from = keeps ? index + edit.find.length : index;
      const range: [number, number] = [Buffer.byteLength(source.slice(0, from)), Buffer.byteLength(source.slice(0, index + edit.find.length))];
      const text = source.slice(0, index) + edit.replace + source.slice(index + edit.find.length);
      const r = f.request(base, f.tree({ [name]: text }), [{ key: "edit", kind: "editSource", source: f.ref("/" + name, source, range), text: keeps ? edit.replace.slice(edit.find.length) : edit.replace }], change);
      if (config) r.rules.config = { formats: { ["/" + name]: config } };
      return r;
    };
    const first = request(reverse ? b : a, reverse ? "b" : "a"), second = request(reverse ? a : b, reverse ? "a" : "b");
    second.current = (await f.run(first)).result;
    const result = await f.run(second);
    results.push({ decisions: result.decisions.length, content: f.content(result.result.object, name) });
  }
  expect(results[0]!.decisions).toBe(results[1]!.decisions);
  // A merge is one result in both orders; a choice shows the later change.
  if (!results[0]!.decisions) expect(results[0]!.content).toBe(results[1]!.content);
  return results[0]!;
}

test("JSON: two new dependencies at one place merge", async () => {
  const source = '{\n  "dependencies": {\n    "react": "18"\n  }\n}\n';
  const { decisions, content } = await merge("package.json", source,
    { find: '"18"', replace: '"18",\n    "lodash": "4"' },
    { find: '"18"', replace: '"18",\n    "zod": "3"' });
  expect(decisions).toBe(0);
  expect(JSON.parse(content).dependencies).toEqual({ react: "18", lodash: "4", zod: "3" });
});

test("JSON: the same new key with two values is a choice", async () => {
  const source = '{\n  "a": 1\n}\n';
  const { decisions } = await merge("data.json", source, { find: "1", replace: '1,\n  "b": 2' }, { find: "1", replace: '1,\n  "b": 3' });
  expect(decisions).toBeGreaterThan(0);
});

test("JSON: a new key and an edit to another key merge", async () => {
  const source = '{\n  "a": 1,\n  "b": 2\n}\n';
  const { decisions, content } = await merge("data.json", source, { find: "1", replace: '1,\n  "c": 5' }, { find: "2", replace: "20" });
  expect(decisions).toBe(0);
  expect(JSON.parse(content)).toEqual({ a: 1, c: 5, b: 20 });
});

test("JSON: two new array items merge, and keyed items keep their identity", async () => {
  const source = '{ "steps": [\n  { "id": "build" }\n] }\n';
  const { decisions, content } = await merge("ci.json", source,
    { find: '{ "id": "build" }', replace: '{ "id": "build" },\n  { "id": "test" }' },
    { find: '{ "id": "build" }', replace: '{ "id": "build" },\n  { "id": "lint" }' });
  expect(decisions).toBe(0);
  expect(JSON.parse(content).steps.map((s: { id: string }) => s.id).sort()).toEqual(["build", "lint", "test"]);
});

test("YAML: new keys in one mapping and items in one sequence merge", async () => {
  const source = "tags:\n  - one\nname: x\n";
  const { decisions, content } = await merge("data.yaml", source, { find: "  - one\n", replace: "  - one\n  - two\n" }, { find: "name: x\n", replace: "name: x\ntitle: y\n" });
  expect(decisions).toBe(0);
  expect(content).toBe("tags:\n  - one\n  - two\nname: x\ntitle: y\n");
});

test("TOML: different keys added to one table merge", async () => {
  const source = "[server]\nport = 80\n";
  const { decisions, content } = await merge("app.toml", source, { find: "port = 80\n", replace: "port = 80\nhost = \"a\"\n" }, { find: "port = 80\n", replace: "port = 80\nuser = \"b\"\n" });
  expect(decisions).toBe(0);
  expect(content.split("\n").sort()).toEqual(["", "[server]", 'host = "a"', "port = 80", 'user = "b"']);
});

test("CSV: rows appended on both sides merge; a new column beside a new row is a choice", async () => {
  const source = "id,value\na,1\n";
  const rows = await merge("data.csv", source, { find: "a,1\n", replace: "a,1\nb,2\n" }, { find: "a,1\n", replace: "a,1\nc,3\n" }, { recordKey: "id" });
  expect(rows.decisions).toBe(0);
  expect(rows.content.split("\n").sort()).toEqual(["", "a,1", "b,2", "c,3", "id,value"]);
  const column = await merge("data.csv", source, { find: "id,value\na,1\n", replace: "id,value,note\na,1,x\n" }, { find: "a,1\n", replace: "a,1\nb,2\n", occurrence: "last" }, { recordKey: "id" });
  expect(column.decisions).toBeGreaterThan(0);
});
