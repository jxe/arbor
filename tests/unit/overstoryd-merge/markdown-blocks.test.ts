import { expect, test } from "bun:test";
import { markdownBlockMerge, markdownBlocks } from "../../../packages/overstoryd-merge/src/markdown-blocks.ts";
import type { Piece } from "../../../packages/overstoryd-merge/src/intent-model.ts";

const piece = (origin: string, start: number, length: number): Piece => ({ origin, object: origin, start, offset: start, length });
/** A version as pieces: base spans by offset, new text by its own origin. */
const version = (...parts: Array<[number, number] | string>) => {
  let text = "";
  const pieces: Piece[] = [];
  for (const part of parts) {
    if (typeof part === "string") { pieces.push(piece(`new:${part}`, 0, Buffer.byteLength(part))); text += part; }
    else { pieces.push(piece("base", part[0], part[1] - part[0])); text += BASE.slice(part[0], part[1]); }
  }
  return { text, pieces };
};
let BASE = "";
function verdict(base: string, ...versions: Array<ReturnType<typeof version>>) {
  return markdownBlockMerge([base, ...versions.map(v => v.text)], [[piece("base", 0, Buffer.byteLength(base))], ...versions.map(v => v.pieces)])!;
}

test("blocks: kinds, containers and attributes", () => {
  const source = "---\nid: x\n---\n\n# Head\n\n- [x] Done\n  - nested\n\n1. First\n\n> quote\n\n```js\nrun()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nPara\ncontinued\n";
  const blocks = markdownBlocks(source)!;
  expect(blocks.map(b => b.kind)).toEqual(["front", "heading", "item", "paragraph", "item", "paragraph", "item", "paragraph", "quote", "paragraph", "fence", "table", "paragraph"]);
  expect(blocks[2]!.attributes).toBe(JSON.stringify(["-", null, "done"]));
  expect(blocks[4]!.parent).toBe(2);
  expect(blocks[6]!.attributes).toBe(JSON.stringify([".", 1, ""]));
  expect(blocks[10]!.language).toBe("js");
  expect(markdownBlocks("```\nopen fence\n")).toBeNull();
});

test("a list marker change on one side and a text edit on the other merge", () => {
  BASE = "- one\n\n- two\n";
  const renumbered = version("1. ", [2, 7], "2. ", [9, 13]);
  const edited = version([0, 2], "ONE", [5, 13]);
  const proposed = version("1. ", "ONE", [5, 7], "2. ", [9, 13]);
  expect(verdict(BASE, renumbered, edited, proposed).conflicts).toEqual([]);
});

test("both sides changing one block's attribute differently is a conflict about that block", () => {
  BASE = "# One\n\nTwo\n";
  const two = version("## ", [2, 11]), three = version("### ", [2, 11]), proposed = version("### ", [2, 11]);
  expect(verdict(BASE, two, three, proposed).conflicts).toEqual([[0, 6]]);
});

test("a join one side made must survive, and a split must not appear from nowhere", () => {
  BASE = "Intro\n\nTail\n";
  const joined = version([0, 6], [7, 12]);
  const heading = version([0, 7], "# New\n\n", [7, 12]);
  const proposed = version([0, 6], "# New\n\n", [7, 12]);
  expect(verdict(BASE, joined, heading, proposed).conflicts.length).toBeGreaterThan(0);
  // Without the heading the join simply merges.
  expect(verdict(BASE, joined, version([0, 12]), joined).conflicts).toEqual([]);
});
