import { expect, test } from "bun:test";
import type { SourceOperation } from "@overstory/protocol";
import { Fixture } from "./fixture.ts";

// One side inserts a new ATX heading block between blocks; the other edits
// elsewhere. A complete heading closed by a blank line parses alone, so it
// merges unless the other side changed the context it relies on (the blank
// line before it) or what follows it would change its parse (an indented line).
// Before this, any new heading was protected structure (live update 8670).

const base = "# Notes\n\n- one\n\n- two\n\nPara 1\n";
const at = base.indexOf("- two"), para = base.indexOf("1\n", base.indexOf("Para"));

async function merge(text: string, other: { text: string; range: [number, number]; with: string }, source = base, offset = at) {
  const f = new Fixture(), tree = f.tree({ "n.md": source });
  const peer: SourceOperation = { key: "peer", kind: "editSource", source: f.ref("/n.md", source, other.range), text: other.with };
  const current = await f.run(f.request(tree, f.tree({ "n.md": other.text }), [peer], "peer"));
  const heading: SourceOperation = { key: "heading", kind: "editSource", source: f.ref("/n.md", source, [offset, offset]), text };
  const inserted = source.slice(0, offset) + text + source.slice(offset);
  const result = await f.run(f.request(tree, f.tree({ "n.md": inserted }), [heading], "heading", current.result));
  return { decisions: result.decisions, content: f.content(result.result.object, "n.md") };
}

const distant = { text: base.replace("Para 1", "Para 2"), range: [para, para + 1] as [number, number], with: "2" };

test("a new heading between blocks merges with a distant edit", async () => {
  const { decisions, content } = await merge("# New\n\n", distant);
  expect(decisions).toEqual([]);
  expect(content).toBe("# Notes\n\n- one\n\n# New\n\n- two\n\nPara 2\n");
});

test("a new heading needs review when the other side removes the blank line before it", async () => {
  const joined = { text: base.slice(0, at - 1) + base.slice(at), range: [at - 1, at] as [number, number], with: "" };
  expect((await merge("# New\n\n", joined)).decisions.length).toBeGreaterThan(0);
});

test("a new heading before an indented line needs review", async () => {
  const source = "- one\n\n  more\n\nPara 1\n", offset = source.indexOf("  more"), one = source.indexOf("1\n");
  const other = { text: source.replace("Para 1", "Para 2"), range: [one, one + 1] as [number, number], with: "2" };
  expect((await merge("# New\n\n", other, source, offset)).decisions.length).toBeGreaterThan(0);
});

test("a new heading not closed by a blank line needs review", async () => {
  expect((await merge("# New\n", distant)).decisions.length).toBeGreaterThan(0);
});
