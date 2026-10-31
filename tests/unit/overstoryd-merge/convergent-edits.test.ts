import { expect, test } from "bun:test";
import { Fixture } from "./fixture.ts";

// A device that slept through another's edits and then repeats one of them,
// beside structural edits the other device made elsewhere in the page.
const head = "# Before 7pm\n\n";
const pills = "- Take pills\n\n", girls = "- Respond to those girls\n\n";
const pete = "▸ Problems with Pete\n  - does not have his shit together\n\n  - doesn't prioritize very well.\n\n";
const middle = Array.from({ length: 40 }, (_, i) => `- Untouched task ${i}\n\n`).join("");
const tail = "# Hmm\n\nA long dictated note.\n";
const source = head + pills + girls + pete + middle + tail;
const first = "- Untouched task 0\n\n";
const at = (text: string) => Buffer.byteLength(source.slice(0, source.indexOf(text)));

async function phoneEdits(f: Fixture, base: string) {
  const petePos = at("  - does not"), tailPos = at("A long");
  const numbered = pete.replaceAll("  - ", "  1. ");
  // The phone also moves a later task up above the Pete notes.
  const text = head + girls + first + numbered + middle.slice(first.length) + "# Hmm\n\nAn added paragraph.\n\nA long dictated note.\n";
  return f.run(f.request(base, f.tree({ "note.md": text }), [
    { key: "pills", kind: "editSource", source: f.ref("/note.md", source, [at(pills), at(girls)]), text: "" },
    { key: "n1", kind: "editSource", source: f.ref("/note.md", source, [petePos + 2, petePos + 3]), text: "1." },
    { key: "n2", kind: "editSource", source: f.ref("/note.md", source, [at("  - doesn't") + 2, at("  - doesn't") + 3]), text: "1." },
    { key: "move", kind: "moveSource", source: f.ref("/note.md", source, [at(first), at(first) + first.length]), at: f.ref("/note.md", source, [at(pete), at(pete)]), side: "before" },
    { key: "add", kind: "editSource", source: f.ref("/note.md", source, [tailPos, tailPos]), text: "An added paragraph.\n\n" },
  ], "phone"));
}

test("repeating a deletion the other side already made is not a conflict", async () => {
  const f = new Fixture(), base = f.tree({ "note.md": source });
  const current = await phoneEdits(f, base);
  // The stale side removes the same item, its range shifted by the list marker.
  const start = at(pills) + 2, end = at(girls) + 2;
  const result = await f.run(f.request(base, f.tree({ "note.md": source.slice(0, start) + source.slice(end) }), [
    { key: "again", kind: "editSource", source: f.ref("/note.md", source, [start, end]), text: "" },
  ], "mac", current.result));
  expect(result.decisions).toEqual([]);
  expect(f.content(result.result.object, "note.md")).toBe(f.content(current.result.object, "note.md"));
});

test("a refused overlap is a choice about its own blocks, not every edit in the page", async () => {
  const f = new Fixture(), base = f.tree({ "note.md": source });
  const current = await phoneEdits(f, base);
  // The stale side rewrites the item the other side deleted.
  const result = await f.run(f.request(base, f.tree({ "note.md": source.replace("Take pills", "Take vitamins") }), [
    { key: "rewrite", kind: "editSource", source: f.ref("/note.md", source, [at("Take pills") + 5, at("Take pills") + 10]), text: "vitamins" },
  ], "mac", current.result));
  expect(result.decisions).toHaveLength(1);
  // The choice holds the stale edit and the phone's edits it meets, as whole
  // blocks; the untouched tasks after them and the distant paragraph stay out.
  const [start, end] = result.decisions[0]!.subject!.range!;
  expect(start).toBe(at(pills));
  expect(end).toBeLessThanOrEqual(at("- Untouched task 1\n"));
  expect(f.content(result.result.object, "note.md")).toContain("An added paragraph.");
});
