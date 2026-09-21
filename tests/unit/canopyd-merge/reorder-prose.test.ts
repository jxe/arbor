import { expect, test } from "bun:test";
import type { SourceOperation } from "@overstory/protocol";
import type { Piece } from "../../../packages/canopyd-merge/src/intent-model.ts";
import { applyPieceEdits, pieceEdits } from "../../../packages/canopyd-merge/src/pieces.ts";
import { Fixture } from "./fixture.ts";

const pieces = (order: number[]): Piece[] => order.map(start => ({
  origin: "original", object: "object", start, offset: start, length: 1,
}));
const positions = (source: Piece[]) => source.flatMap(p =>
  Array.from({ length: p.length }, (_, i) => `${p.origin}:${p.start + i}`));

test("reorders retain stable boundaries and independent changes between moves", () => {
  const base = pieces([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const changed = pieces([0, 2, 1, 3, 4, 6, 5, 7, 8]);
  const edits = pieceEdits(base, changed);
  expect(edits.map(e => e.range)).toEqual([[1, 3], [5, 7]]);
  expect(positions(applyPieceEdits(base, edits))).toEqual(positions(changed));
  // Correspondence must not depend on storage-piece fragmentation.
  const compact = [{ ...base[0]!, length: 9 }];
  expect(pieceEdits(compact, changed).map(e => e.range)).toEqual([[1, 3], [5, 7]]);
  const equalBytesNewOrigin = changed.map(p => p.start === 4 ? { ...p, origin: "new" } : p);
  expect(pieceEdits(base, equalBytesNewOrigin).map(e => e.range)).toEqual([[1, 3], [4, 7]]);
});

test("identity correspondence reconstructs every ordering and deletion of five pieces", () => {
  const base = pieces([0, 1, 2, 3, 4]);
  const visit = (order: number[], remaining: number[]) => {
    const changed = pieces(order);
    expect(positions(applyPieceEdits(base, pieceEdits(base, changed)))).toEqual(positions(changed));
    for (const n of remaining) visit([...order, n], remaining.filter(i => i !== n));
  };
  visit([], [0, 1, 2, 3, 4]);
  const duplicate = pieces([0, 1, 1, 2, 4]);
  expect(positions(applyPieceEdits(base, pieceEdits(base, duplicate)))).toEqual(positions(duplicate));
});

function scenario(ending: string) {
  const f = new Fixture();
  const prefix = `---${ending}id: sample${ending}---${ending}# Console${ending}${ending}- α reflection${ending}${ending}`;
  const one = `First paragraph.${ending}${ending}`, two = `Second paragraph.${ending}${ending}`;
  const suffix = `# Reference${ending}${ending}[Link](relative)${ending}${ending}\`\`\`json${ending}{"value":1}${ending}\`\`\`${ending}`;
  const source = prefix + one + two + suffix;
  const range: [number, number] = [Buffer.byteLength(prefix), Buffer.byteLength(prefix + one + two)];
  const reorder: SourceOperation = {
    key: "reorder", kind: "editSource", source: f.ref("/note.md", source, range), text: two + one,
    lineage: [
      { range: [0, Buffer.byteLength(two)], source: f.ref("/note.md", source, [range[0] + Buffer.byteLength(one), range[1]]) },
      { range: [Buffer.byteLength(two), Buffer.byteLength(two + one)], source: f.ref("/note.md", source, [range[0], range[0] + Buffer.byteLength(one)]) },
    ],
  };
  const at = Buffer.byteLength(source.slice(0, source.indexOf("reflection")));
  const edit = (text: string): SourceOperation => ({ key: "reflection", kind: "editSource", source: f.ref("/note.md", source, [at, at + 10]), text });
  return { f, source, prefix, one, two, suffix, range, reorder, at, edit };
}

for (const ending of ["\n", "\r\n"])
  for (const reverse of [false, true])
    test(`paragraph reorder merges with a distant inline edit (${JSON.stringify(ending)}, reverse=${reverse})`, async () => {
      const { f, source, prefix, one, two, suffix, reorder, edit } = scenario(ending);
      const base = f.tree({ "note.md": source });
      const moved = prefix + two + one + suffix;
      const versions = [
        { text: moved, ops: [reorder], id: "mac" },
        { text: source.replace("reflection", "new reflection"), ops: [edit("new reflection")], id: "phone" },
      ];
      if (reverse) versions.reverse();
      const first = await f.run(f.request(base, f.tree({ "note.md": versions[0]!.text }), versions[0]!.ops, versions[0]!.id));
      const result = await f.run(f.request(base, f.tree({ "note.md": versions[1]!.text }), versions[1]!.ops, versions[1]!.id, first.result));
      expect(result.decisions).toEqual([]);
      expect(f.content(result.result.object, "note.md")).toBe(moved.replace("reflection", "new reflection"));
    });

test("paragraph removal and a distant inline insertion merge without restoring removed prose", async () => {
  const { f, source, prefix, one, two, suffix, edit } = scenario("\n");
  const base = f.tree({ "note.md": source });
  const current = await f.run(f.request(base, f.tree({ "note.md": prefix + two + suffix }), [{
    key: "remove", kind: "editSource", source: f.ref("/note.md", source, [Buffer.byteLength(prefix), Buffer.byteLength(prefix + one)]), text: "",
  }], "mac"));
  const result = await f.run(f.request(base, f.tree({ "note.md": source.replace("reflection", "new reflection") }), [edit("new reflection")], "phone", current.result));
  expect(result.decisions).toEqual([]);
  expect(f.content(result.result.object, "note.md")).toBe((prefix + two + suffix).replace("reflection", "new reflection"));
});

test("an overlapping prose edit remains a local choice beside an independent reorder", async () => {
  const { f, source, prefix, one, two, suffix, reorder, edit, at } = scenario("\n");
  const base = f.tree({ "note.md": source });
  const current = await f.run(f.request(base, f.tree({ "note.md": (prefix + two + one + suffix).replace("reflection", "first thought") }), [reorder, edit("first thought")], "mac"));
  const result = await f.run(f.request(base, f.tree({ "note.md": source.replace("reflection", "second thought") }), [edit("second thought")], "phone", current.result));
  expect(result.decisions).toHaveLength(1);
  expect(result.decisions[0]!.subject?.range).toEqual([at, at + 10]);
  expect(f.content(result.result.object, "note.md")).toBe((prefix + two + one + suffix).replace("reflection", "second thought"));
  expect(result.decisions[0]!.reason).toBe("Overlapping source contributions");
});

for (const protectedText of ["# Heading\n\n", "[Link](relative)\n\n", "```js\nrun()\n```\n\n", "<div>text</div>\n\n", "a | b\n--|--\n1 | 2\n\n"]) {
  test(`structural removal still requires review: ${protectedText.split("\n")[0]}`, async () => {
    const f = new Fixture(), prefix = "Intro 1\n\n", source = prefix + protectedText + "Tail\n";
    const base = f.tree({ "note.md": source });
    const current = await f.run(f.request(base, f.tree({ "note.md": prefix + "Tail\n" }), [{
      key: "remove", kind: "editSource", source: f.ref("/note.md", source, [prefix.length, prefix.length + protectedText.length]), text: "",
    }], "mac"));
    const result = await f.run(f.request(base, f.tree({ "note.md": source.replace("1", "2") }), [{
      key: "edit", kind: "editSource", source: f.ref("/note.md", source, [6, 7]), text: "2",
    }], "phone", current.result));
    expect(result.decisions.length).toBeGreaterThan(0);
  });
}

test("new list paragraphs survive a concurrent edit and paragraph reorder", async () => {
  const { f, source, prefix, one, two, suffix, reorder, edit } = scenario("\n");
  const base = f.tree({ "note.md": source });
  const moved = prefix + two + one + suffix;
  const first = await f.run(f.request(base, f.tree({ "note.md": moved }), [reorder], "mac"));
  const added = "- New thought\n\n- Another thought\n\n";
  const at = Buffer.byteLength(prefix.slice(0, prefix.indexOf("- α")));
  const withLists = (prefix + two + one + suffix).replace("- α", added + "- α");
  const current = await f.run(f.request(first.result, f.tree({ "note.md": withLists }), [{
    key: "add", kind: "editSource", source: f.ref("/note.md", moved, [at, at]), text: added,
  }], "later-phone"));
  const result = await f.run(f.request(base, f.tree({ "note.md": source.replace("reflection", "new reflection") }), [edit("new reflection")], "earlier-phone", current.result));
  expect(result.decisions).toEqual([]);
  expect(f.content(result.result.object, "note.md")).toBe(withLists.replace("reflection", "new reflection"));
});

for (const syntax of ["**bold**", "[link](relative)", "`code`", "<b>HTML</b>"]) {
  test(`new inline structure still requires review beside a reorder: ${syntax}`, async () => {
    const { f, source, prefix, one, two, suffix, reorder, edit } = scenario("\n");
    const base = f.tree({ "note.md": source });
    const current = await f.run(f.request(base, f.tree({ "note.md": prefix + two + one + suffix }), [reorder], "mac"));
    const result = await f.run(f.request(base, f.tree({ "note.md": source.replace("reflection", syntax) }), [edit(syntax)], "phone", current.result));
    expect(result.decisions.length).toBeGreaterThan(0);
  });
}


test("ordinary list removal merges with an independent paragraph edit", async () => {
  const f = new Fixture(), source = "Intro 1\n\n- list item\n\nTail\n", base = f.tree({"note.md":source});
  const current = await f.run(f.request(base, f.tree({"note.md":"Intro 1\n\nTail\n"}), [{key:"remove",kind:"editSource",source:f.ref("/note.md",source,[9,22]),text:""}],"mac"));
  const result = await f.run(f.request(base,f.tree({"note.md":source.replace("1","2")}),[{key:"edit",kind:"editSource",source:f.ref("/note.md",source,[6,7]),text:"2"}],"phone",current.result));
  expect(result.decisions).toEqual([]);
  expect(f.content(result.result.object,"note.md")).toBe("Intro 2\n\nTail\n");
});

test.each(["\n", "\r\n"])("splitting and editing a nested list merges with distant prose (%s)", async newline => {
  const f = new Fixture();
  const head = ["# Todos", "", "- Ask Person", "", "  - First topic", "", "    - Nested topic", "", ""].join(newline);
  const tail = ["# Later", "", "Unrelated paragraph", ""].join(newline);
  const source = head + tail, base = f.tree({"note.md":source});
  const changedHead = head.replace("Ask Person", "Ask Per").replace("    - Nested topic" + newline, "    - Nested topic" + newline + newline + "- " + newline + newline + "- son" + newline);
  const current = await f.run(f.request(base,f.tree({"note.md":source.replace("Unrelated", "Updated Unrelated")}), [{key:"peer",kind:"editSource",source:f.ref("/note.md",source,[Buffer.byteLength(head + "# Later" + newline + newline),Buffer.byteLength(head + "# Later" + newline + newline)]),text:"Updated "}],"peer"));
  const result = await f.run(f.request(base,f.tree({"note.md":changedHead+tail}),[{key:"split",kind:"editSource",source:f.ref("/note.md",source,[Buffer.byteLength("# Todos"+newline+newline),Buffer.byteLength(head)]),text:changedHead.slice(("# Todos"+newline+newline).length)}],"split",current.result));
  expect(result.decisions).toEqual([]);
  expect(f.content(result.result.object,"note.md")).toBe(changedHead+tail.replace("Unrelated","Updated Unrelated"));
});
