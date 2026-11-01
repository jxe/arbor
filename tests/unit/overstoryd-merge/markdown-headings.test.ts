import { expect, test } from "bun:test";
import type { SourceOperation } from "@ovst/protocol";
import { Fixture } from "./fixture.ts";

// One side inserts a new ATX heading block; the other edits elsewhere. Merged
// as blocks (overstoryd 017), each side's blocks keep what it gave them, so a
// heading merges even where it ends a list or closes the other side's tight
// list: the result reads as the heading's author wrote it. Before 017 these
// went to review (live update 8670 first allowed headings between blocks).

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

test("a new heading merges where the other side removed the blank line before it", async () => {
  const joined = { text: base.slice(0, at - 1) + base.slice(at), range: [at - 1, at] as [number, number], with: "" };
  const { decisions, content } = await merge("# New\n\n", joined);
  expect(decisions).toEqual([]);
  expect(content).toBe("# Notes\n\n- one\n# New\n\n- two\n\nPara 1\n");
});

test("a new heading before an indented line merges as its author wrote it", async () => {
  const source = "- one\n\n  more\n\nPara 1\n", offset = source.indexOf("  more"), one = source.indexOf("1\n");
  const other = { text: source.replace("Para 1", "Para 2"), range: [one, one + 1] as [number, number], with: "2" };
  const { decisions, content } = await merge("# New\n\n", other, source, offset);
  expect(decisions).toEqual([]);
  expect(content).toBe("- one\n\n# New\n\n  more\n\nPara 2\n");
});

test("a new heading not closed by a blank line merges", async () => {
  const { decisions, content } = await merge("# New\n", distant);
  expect(decisions).toEqual([]);
  expect(content).toBe("# Notes\n\n- one\n\n# New\n- two\n\nPara 2\n");
});

test("a heading between paragraphs the other side joined needs review", async () => {
  // The peer joins Tail onto Intro's paragraph; a heading between them would
  // split that paragraph again, so the join is not what the merge shows.
  const source = "Intro\n\nTail\n", offset = source.indexOf("Tail");
  const joined = { text: "Intro\nTail\n", range: [6, 7] as [number, number], with: "" };
  const { decisions } = await merge("# New\n\n", joined, source, offset);
  expect(decisions.length).toBeGreaterThan(0);
});
