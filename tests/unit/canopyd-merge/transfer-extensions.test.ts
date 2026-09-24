import { expect, test } from "bun:test";
import type { SourceOperation } from "@overstory/protocol";
import {
  evaluateSourceTransfer,
  evaluateTransfer,
  type TransferContext,
} from "../../../packages/canopyd-merge/src/format-rules.ts";
import { mergeIntent } from "../../../packages/canopyd-merge/src/intent-engine.ts";
import { Fixture } from "./fixture.ts";

// Transfers beyond plain paragraphs (Markdown list items, table rows and
// contextual links; same-anchor ordering; keyed JSON/YAML members and hoisted
// TS/JS declarations). Every engine case runs in both arrival orders and
// requires the same answer from each.

type Files = Record<string, string>;
const bytes = (s: string) => new TextEncoder().encode(s);
const size = (s: string) => Buffer.byteLength(s);
/** The byte offset of `marker` in `text` (plus `offset` bytes). */
const at = (text: string, marker: string, offset = 0) => {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`No ${JSON.stringify(marker)} in ${JSON.stringify(text)}`);
  return size(text.slice(0, index)) + offset;
};
const cut = (text: string, start: number, end: number, insert = "") =>
  Buffer.concat([Buffer.from(text).subarray(0, start), Buffer.from(insert), Buffer.from(text).subarray(end)]).toString();

interface Change {
  files: Files;
  operations: (f: Fixture, base: Files) => SourceOperation[];
}
/** Move or copy `[start, end)` of `from` to byte `offset` of `to`. */
function transfer(
  files: Files,
  kind: "moveSource" | "copySource",
  from: string,
  [start, end]: [number, number],
  to: string,
  offset: number,
  side: "before" | "after" = "before",
): Change {
  const material = Buffer.from(files[from]!).subarray(start, end).toString();
  const next = { ...files };
  if (from === to) {
    const inserted = cut(files[to]!, offset, offset, material);
    next[to] =
      kind === "copySource"
        ? inserted
        : offset <= start
          ? cut(inserted, start + size(material), end + size(material))
          : cut(inserted, start, end);
  } else {
    next[to] = cut(files[to]!, offset, offset, material);
    if (kind === "moveSource") next[from] = cut(files[from]!, start, end);
  }
  return {
    files: next,
    operations: (f, base) => [
      {
        key: "transfer",
        kind,
        source: f.ref(`/${from}`, base[from]!, [start, end]),
        at: f.ref(`/${to}`, base[to]!, [offset, offset]),
        side,
      },
    ],
  };
}
function edit(files: Files, path: string, [start, end]: [number, number], text: string, key = "edit"): Change {
  return {
    files: { ...files, [path]: cut(files[path]!, start, end, text) },
    operations: (f, base) => [
      { key, kind: "editSource", source: f.ref(`/${path}`, base[path]!, [start, end]), text },
    ],
  };
}

/** Accept `a` and `b` concurrently on `files`, in both orders. */
async function bothOrders(files: Files, a: Change, b: Change) {
  const answers = [];
  for (const reverse of [false, true]) {
    const f = new Fixture(), base = f.tree(files);
    const request = (c: Change, change: string) =>
      f.request(base, f.tree(c.files), c.operations(f, files), change);
    const first = reverse ? request(b, "b") : request(a, "a"),
      second = reverse ? request(a, "a") : request(b, "b");
    second.current = (await f.run(first)).result;
    // The incremental answer equals the eager reference, which re-projects
    // every state and enforces all history.
    const objects = {
      read: async (hash: string) => f.objects.get(hash)!,
      states: f.states,
      store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => {
        for (const value of values) f.objects.set(value.hash, value.bytes);
      },
    };
    const eager = await mergeIntent(second, objects, { incremental: false, eager: true });
    const result = await f.run(second);
    if (eager.outcome !== "evaluated") throw new Error(JSON.stringify(eager));
    expect([result.result, result.decisions]).toEqual([eager.result, eager.decisions]);
    const contents = Object.fromEntries(
      Object.keys({ ...files, ...a.files, ...b.files }).map((name) => [name, f.content(result.result.object, name)]),
    );
    answers.push({ f, result, contents });
  }
  return answers;
}
/** Both orders merge without review, to `expected`, with resolved transfer evidence. */
async function merges(files: Files, a: Change, b: Change, expected: Files, evidence = "-source-transfer") {
  const answers = await bothOrders(files, a, b);
  for (const { f, result, contents } of answers) {
    expect(result.decisions).toEqual([]);
    expect(contents).toEqual({ ...contents, ...expected });
    expect(result.evidence.formats.some((e) => e.id.endsWith(evidence) && e.outcome === "resolved")).toBe(true);
    // The retained result loads in a later request.
    const name = Object.keys(expected)[0]!;
    const continued = await f.run(
      f.request(result.result, result.result.object, [
        { key: "again", kind: "editSource", source: f.ref(`/${name}`, expected[name]!, [0, 0]), text: "" },
      ], "continued"),
    );
    expect(continued.result.object).toBe(result.result.object);
  }
  expect(answers[0]!.result.result.object).toBe(answers[1]!.result.result.object);
}
/** Both orders keep review. */
async function reviews(files: Files, a: Change, b: Change) {
  for (const { result } of await bothOrders(files, a, b))
    expect(result.decisions.length).toBeGreaterThan(0);
}

// --- Markdown structure: the policy -------------------------------------

const policy = (a: string, b: string, context?: TransferContext) =>
  evaluateSourceTransfer("note.md", [a, b, b, b].map(bytes), {}, context);
const local: TransferContext = { directories: ["", "", "", ""], crossDocument: "none", transfers: [] };

test.each([
  ["item reorder", "- a\n- b\n- c\n", "- c\n- a\n- b\n"],
  ["item into another list of that bullet", "- a\n- b\n\nText\n\n- c\n", "- a\n\nText\n\n- b\n- c\n"],
  ["task item", "- [ ] a\n- [x] b\n", "- [x] b\n- [ ] a\n"],
  ["formatted item", "* a\n* **b** and `c`\n", "* **b** and `c`\n* a\n"],
  ["table row", "| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n", "| a | b |\n|:--|--:|\n| 3 | 4 |\n| 1 | 2 |\n"],
  ["row into an empty body", "| a |\n|---|\n| 1 |\n\n| b |\n|---|\n", "| a |\n|---|\n\n| b |\n|---|\n| 1 |\n"],
])("Markdown transfer admits list and table hosts: %s", (_name, a, b) => {
  expect(policy(a, b).outcome).toBe("resolved");
});

test.each([
  ["bullet change", "- a\n- b\n", "* a\n* b\n"],
  ["mixed bullets", "- a\n- b\n", "- a\n+ b\n"],
  ["emptied list", "- a\n\nText\n\n- b\n", "Text\n\n- b\n- a\n"],
  ["new list", "Text\n", "Text\n\n- a\n"],
  ["ordered list", "1. a\n2. b\n", "1. b\n2. a\n"],
  ["nested item", "- a\n- b\n", "- a\n  - b\n"],
  ["two spaces", "- a\n- b\n", "- a\n-  b\n"],
  ["item begins a block", "- a\n- b\n", "- a\n- # b\n"],
  ["thematic break", "- a\n- b\n", "- a\n- - -\n"],
  ["continuation", "- a\n- b\n", "- a\nb\n"],
  ["unmodelled link", "- a\n", "- [a](ftp://x)\n"],
  ["row width", "| a | b |\n|---|---|\n| 1 | 2 |\n", "| a | b |\n|---|---|\n| 1 |\n"],
  ["header change", "| a |\n|---|\n| 1 |\n", "| A |\n|---|\n| 1 |\n"],
  ["alignment change", "| a |\n|---|\n| 1 |\n", "| a |\n|:-:|\n| 1 |\n"],
  ["escaped pipe", "| a |\n|---|\n| 1 |\n", "| a |\n|---|\n| \\| |\n"],
  ["table after paragraph", "Text\n\n| a |\n|---|\n", "Text\n| a |\n|---|\n"],
  ["lazy continuation into HTML", "- a\n- b\n<span>x</span>\n", "- b\n- a\n<span>x</span>\n"],
  ["row continuing into HTML", "| a |\n|---|\n| 1 |\n| 2 |\n<span>x</span>\n", "| a |\n|---|\n| 2 |\n| 1 |\n<span>x</span>\n"],
])("Markdown transfer keeps review for host changes: %s", (_name, a, b) => {
  expect(policy(a, b, local).outcome).toBe("unresolved");
});

test("contextual links are admitted only with a proven binding", () => {
  const before = "# Top\n\n[top]: https://example.org\n\nText\n";
  const after = (link: string) => before + "\n" + link + "\n";
  const same = (crossDocument: TransferContext["crossDocument"]): TransferContext =>
    ({ directories: ["/d", "/d", "/d", "/d"], crossDocument, transfers: [] });
  for (const link of ["[a](./x.md)", "![a](img/a.png)", "[a](../b.md#c)"]) {
    expect(policy(before, after(link)).outcome).toBe("unresolved");
    expect(policy(before, after(link), same("none")).outcome).toBe("resolved");
    expect(policy(before, after(link), same("same-directory")).outcome).toBe("resolved");
    expect(policy(before, after(link), same("other")).outcome).toBe("unresolved");
    // A document that changes directory rebinds the link.
    expect(policy(before, after(link), { ...same("none"), directories: ["/d", "/e", "/d", "/e"] }).outcome).toBe("unresolved");
  }
  for (const link of ["[a](#top)", "[a][top]", "[top][]", "[top]"]) {
    expect(policy(before, after(link), same("none")).outcome).toBe("resolved");
    expect(policy(before, after(link), same("same-directory")).outcome).toBe("unresolved");
  }
  // Escapes, entities, other schemes and non-ASCII labels are not modelled.
  for (const link of ["[a](\\#top)", "[a](&#35;top)", "[a](ftp://x)", "[a][é]", "[a](<x>)"])
    expect(policy(before, after(link), same("none")).outcome).toBe("unresolved");
  // Definitions and headings stay protected, so changing either needs review.
  expect(policy(before + "\n[a][top]\n", before.replace("https://example.org", "https://x.org") + "\n[a][top]\n", same("none")).outcome).toBe("unresolved");
  expect(policy(before + "\n[a](#top)\n", before.replace("# Top", "# Other") + "\n[a](#top)\n", same("none")).outcome).toBe("unresolved");
});

// --- Markdown structure: both arrival orders ----------------------------

test("a list item move merges with an edit to another item", async () => {
  const note = "# T\n\n- a\n- b\n- c\n\nPara\n";
  const files = { "n.md": note };
  const b = [at(note, "- b"), at(note, "- c")] as [number, number];
  await merges(
    files,
    transfer(files, "moveSource", "n.md", b, "n.md", at(note, "\nPara") ),
    edit(files, "n.md", [at(note, "a\n"), at(note, "a\n") + 1], "A"),
    { "n.md": "# T\n\n- A\n- c\n- b\n\nPara\n" },
  );
});

test("a list item moved to another document carries a concurrent edit to it", async () => {
  const source = "# S\n\n- a\n- b\n", target = "# T\n\n- x\n";
  const files = { "s.md": source, "t.md": target };
  await merges(
    files,
    transfer(files, "moveSource", "s.md", [at(source, "- b"), size(source)], "t.md", size(target)),
    edit(files, "s.md", [at(source, "b\n"), at(source, "b\n") + 1], "B"),
    { "s.md": "# S\n\n- a\n", "t.md": "# T\n\n- x\n- B\n" },
  );
});

test("a copied table row merges with a cell edit in another row", async () => {
  const note = "| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n";
  const files = { "n.md": note };
  await merges(
    files,
    transfer(files, "copySource", "n.md", [at(note, "| a"), at(note, "| b")], "n.md", size(note)),
    edit(files, "n.md", [at(note, "2 |"), at(note, "2 |") + 1], "3"),
    { "n.md": "| k | v |\n|---|---|\n| a | 1 |\n| b | 3 |\n| a | 1 |\n" },
  );
});

test("a list item move keeps review when the other side changes the list's bullet", async () => {
  const note = "- a\n- b\n\nText\n\n- c\n";
  const files = { "n.md": note };
  const bullet = "- a\n- b\n\nText\n\n* c\n";
  await reviews(
    files,
    transfer(files, "moveSource", "n.md", [0, at(note, "- b")], "n.md", size(note)),
    edit(files, "n.md", [at(note, "- c"), at(note, "- c") + 1], "*"),
  );
  void bullet;
});

test("a relative link moves between documents of one directory, but not across directories", async () => {
  const source = "# S\n\nSee [x](./x.md).\n\nTail\n", target = "# T\n\n";
  const tail = [at(source, "Tail"), at(source, "Tail") + 4] as [number, number];
  const selected = [at(source, "See"), at(source, "Tail")] as [number, number];
  const files = { "s.md": source, "t.md": target };
  await merges(
    files,
    transfer(files, "moveSource", "s.md", selected, "t.md", size(target)),
    edit(files, "s.md", tail, "Peer"),
    { "s.md": "# S\n\nPeer\n", "t.md": "# T\n\nSee [x](./x.md).\n\n" },
  );
  // The same move into a document in another directory rebinds `./x.md`.
  const f = new Fixture();
  const nested = f.dir([
    { name: "s.md", file: f.put(source) },
    { name: "sub", directory: f.tree({ "t.md": target }) },
  ]);
  const moved = f.dir([
    { name: "s.md", file: f.put("# S\n\nTail\n") },
    { name: "sub", directory: f.tree({ "t.md": target + "See [x](./x.md).\n\n" }) },
  ]);
  const peer = f.dir([
    { name: "s.md", file: f.put("# S\n\nSee [x](./x.md).\n\nPeer\n") },
    { name: "sub", directory: f.tree({ "t.md": target }) },
  ]);
  const move = f.request(nested, moved, [{
    key: "transfer", kind: "moveSource",
    source: f.ref("/s.md", source, selected),
    at: f.ref("/sub/t.md", target, [size(target), size(target)]), side: "before",
  }], "a");
  const change = f.request(nested, peer, [{
    key: "edit", kind: "editSource", source: f.ref("/s.md", source, tail), text: "Peer",
  }], "b");
  for (const [first, second] of [[move, change], [change, move]]) {
    const g = new Fixture();
    g.objects = new Map(f.objects);
    const one = structuredClone(first!), two = structuredClone(second!);
    two.current = (await g.run(one)).result;
    expect((await g.run(two)).decisions.length).toBeGreaterThan(0);
  }
});

test("a reference link moves within its document, and its definition stays protected", async () => {
  const note = "Intro [docs][d].\n\nTail\n\n[d]: https://example.org\n";
  const files = { "n.md": note };
  const paragraph = [0, at(note, "Tail")] as [number, number];
  await merges(
    files,
    transfer(files, "moveSource", "n.md", paragraph, "n.md", at(note, "[d]:")),
    edit(files, "n.md", [at(note, "Tail"), at(note, "Tail") + 4], "Peer"),
    { "n.md": "Peer\n\nIntro [docs][d].\n\n[d]: https://example.org\n" },
  );
  // A concurrent change to the definition rebinds the moved reference.
  await reviews(
    files,
    transfer(files, "moveSource", "n.md", paragraph, "n.md", at(note, "[d]:")),
    edit(files, "n.md", [at(note, "example"), at(note, "example") + 7], "other"),
  );
});

// --- Same-anchor ordering ----------------------------------------------

test("a paragraph move and a paragraph insertion at one anchor are ordered by contribution", async () => {
  const note = "Alpha\n\nBeta\n\n";
  const files = { "n.md": note };
  // Change "a" moves Alpha to the end; change "b" appends Gamma there. The
  // pair is kept in contribution-key order in both arrival orders.
  await merges(
    files,
    transfer(files, "moveSource", "n.md", [0, at(note, "Beta")], "n.md", size(note)),
    edit(files, "n.md", [size(note), size(note)], "Gamma\n\n"),
    { "n.md": "Beta\n\nAlpha\n\nGamma\n\n" },
  );
});

test("two copies to one anchor are ordered by contribution", async () => {
  const note = "# T\n\nAlpha\n\nBeta\n\n";
  const files = { "n.md": note };
  const alpha = [at(note, "Alpha"), at(note, "Beta")] as [number, number];
  const beta = [at(note, "Beta"), size(note)] as [number, number];
  const b = transfer(files, "copySource", "n.md", beta, "n.md", at(note, "Alpha"));
  await merges(
    files,
    transfer(files, "copySource", "n.md", alpha, "n.md", at(note, "Alpha")),
    b,
    { "n.md": "# T\n\nAlpha\n\nBeta\n\nAlpha\n\nBeta\n\n" },
  );
});

test("a destination range's chosen side is its anchor", async () => {
  const note = "Alpha\n\nBeta\n\n";
  const files = { "n.md": note };
  const move: Change = {
    ...transfer(files, "moveSource", "n.md", [0, at(note, "Beta")], "n.md", size(note)),
    operations: (f, base) => [{
      key: "transfer", kind: "moveSource",
      source: f.ref("/n.md", base["n.md"]!, [0, at(note, "Beta")]),
      at: f.ref("/n.md", base["n.md"]!, [at(note, "Beta"), size(note)]), side: "after",
    }],
  };
  await merges(files, move, edit(files, "n.md", [size(note), size(note)], "Gamma\n\n"),
    { "n.md": "Beta\n\nAlpha\n\nGamma\n\n" });
});

test("same-anchor transfers keep review where the insertion policy does", async () => {
  const note = "Alpha\n\nBeta\n\n";
  const files = { "n.md": note };
  // A heading changes the scope of what follows it.
  await reviews(
    files,
    transfer(files, "moveSource", "n.md", [0, at(note, "Beta")], "n.md", size(note)),
    edit(files, "n.md", [size(note), size(note)], "# Gamma\n\n"),
  );
  // Plain text defaults to review for competing insertions.
  const text = { "n.txt": "one two" };
  await reviews(
    text,
    transfer(text, "moveSource", "n.txt", [0, 4], "n.txt", 7),
    edit(text, "n.txt", [7, 7], "!"),
  );
});

// --- Structured formats ----------------------------------------------------

test("a keyed JSON member moves between objects and carries a concurrent value edit", async () => {
  const doc = '{\n  "a": {\n    "x": 1,\n    "y": 2\n  },\n  "b": {\n    "z": 3\n  }\n}\n';
  const files = { "c.json": doc };
  // Move `"y": 2` (with its leading separator) to the end of "b".
  const member = [at(doc, ',\n    "y"'), at(doc, "\n  },")] as [number, number];
  const destination = at(doc, "\n  }\n}");
  const moved = '{\n  "a": {\n    "x": 1\n  },\n  "b": {\n    "z": 3,\n    "y": 20\n  }\n}\n';
  await merges(
    files,
    transfer(files, "moveSource", "c.json", member, "c.json", destination),
    edit(files, "c.json", [at(doc, "2\n"), at(doc, "2\n") + 1], "20"),
    { "c.json": moved },
  );
  // An edit to another member merges as well. (An edit to a byte beside the
  // destination anchor removes the anchor, which the engine never guesses.)
  await merges(
    files,
    transfer(files, "moveSource", "c.json", member, "c.json", destination),
    edit(files, "c.json", [at(doc, "1,"), at(doc, "1,") + 1], "5"),
    { "c.json": moved.replace("20", "2").replace("1\n", "5\n") },
  );
});

test("a keyed JSON move keeps review when the proof fails", async () => {
  const doc = '{\n  "a": {\n    "x": 1,\n    "y": 2\n  },\n  "b": {\n    "z": 3\n  }\n}\n';
  const files = { "c.json": doc };
  const member = [at(doc, ',\n    "y"'), at(doc, "\n  },")] as [number, number];
  const destination = at(doc, "\n  }\n}");
  const move = () => transfer(files, "moveSource", "c.json", member, "c.json", destination);
  // The other side creates the same key in the destination object.
  await reviews(files, move(), edit(files, "c.json", [at(doc, '"z"'), at(doc, '"z"')], '"y": 9,\n    '));
  // The other side renames the moved member.
  await reviews(files, move(), edit(files, "c.json", [at(doc, '"y"') + 1, at(doc, '"y"') + 2], "w"));
  // The other side renames the destination object.
  await reviews(files, move(), edit(files, "c.json", [at(doc, '"b"') + 1, at(doc, '"b"') + 2], "c"));
  // A range that is not one complete member (only the value).
  await reviews(files,
    transfer(files, "moveSource", "c.json", [at(doc, "2\n"), at(doc, "2\n") + 1], "c.json", at(doc, "3\n") + 1),
    edit(files, "c.json", [at(doc, "1,"), at(doc, "1,") + 1], "5"));
  // A move between files has no single-file proof.
  const other = { "c.json": doc, "d.json": '{\n  "q": 0\n}\n' };
  await reviews(other,
    transfer(other, "moveSource", "c.json", member, "d.json", at(other["d.json"], "\n}")),
    edit(other, "c.json", [at(doc, "1,"), at(doc, "1,") + 1], "5"));
});

test("a keyed YAML member moves between mappings beside an independent edit", async () => {
  const doc = "a:\n  x: 1\n  y: 2\nb:\n  z: 3\n";
  const files = { "c.yaml": doc };
  const member = [at(doc, "  y:"), at(doc, "b:")] as [number, number];
  await merges(
    files,
    transfer(files, "moveSource", "c.yaml", member, "c.yaml", size(doc)),
    edit(files, "c.yaml", [at(doc, "3\n"), at(doc, "3\n") + 1], "4"),
    { "c.yaml": "a:\n  x: 1\nb:\n  z: 4\n  y: 2\n" },
  );
  await merges(
    files,
    transfer(files, "moveSource", "c.yaml", member, "c.yaml", size(doc)),
    edit(files, "c.yaml", [at(doc, "2\n"), at(doc, "2\n") + 1], "5"),
    { "c.yaml": "a:\n  x: 1\nb:\n  z: 3\n  y: 5\n" },
  );
  // The other side renames the destination mapping.
  await reviews(files,
    transfer(files, "moveSource", "c.yaml", member, "c.yaml", size(doc)),
    edit(files, "c.yaml", [at(doc, "b:"), at(doc, "b:") + 1], "c"));
});

test("a keyed copy adds its member beside an edit to the original", async () => {
  const doc = '{"a": {"x": 1}, "b": {}}\n';
  const files = { "c.json": doc };
  const copy = transfer(files, "copySource", "c.json", [at(doc, '"x"'), at(doc, "1}") + 1], "c.json", at(doc, "}}"));
  await merges(files, copy, edit(files, "c.json", [at(doc, "1}"), at(doc, "1}") + 1], "2"),
    { "c.json": '{"a": {"x": 2}, "b": {"x": 1}}\n' });
});

test("a top-level function declaration moves beside a literal edit to it", async () => {
  const source = 'const limit = 3;\n\nfunction a() {\n  return "a";\n}\n\nfunction b() {\n  return 1;\n}\n';
  const files = { "m.ts": source };
  const declaration = [at(source, "function b"), size(source)] as [number, number];
  await merges(
    files,
    transfer(files, "moveSource", "m.ts", declaration, "m.ts", at(source, "function a")),
    edit(files, "m.ts", [at(source, "1;"), at(source, "1;") + 1], "2"),
    { "m.ts": 'const limit = 3;\n\nfunction b() {\n  return 2;\n}\nfunction a() {\n  return "a";\n}\n\n' },
  );
  await merges(
    files,
    transfer(files, "moveSource", "m.ts", declaration, "m.ts", at(source, "function a")),
    edit(files, "m.ts", [at(source, "3;"), at(source, "3;") + 1], "4"),
    { "m.ts": 'const limit = 4;\n\nfunction b() {\n  return 1;\n}\nfunction a() {\n  return "a";\n}\n\n' },
  );
});

test("a declaration move keeps review when the proof fails", async () => {
  const source = 'function a() {\n  return "a";\n}\n\nfunction b() {\n  return 1;\n}\n\nconst k = 1;\n';
  const files = { "m.ts": source };
  const declaration = [at(source, "function b"), at(source, "const k")] as [number, number];
  const move = () => transfer(files, "moveSource", "m.ts", declaration, "m.ts", 0);
  // A binding change, not a literal edit.
  await reviews(files, move(), edit(files, "m.ts", [at(source, "1;"), at(source, "1;") + 1], "a()"));
  // A comment that directs a tool about the next line.
  await reviews(files, move(), edit(files, "m.ts", [at(source, "const k"), at(source, "const k")], "// @ts-ignore\n"));
  // A new top-level statement is not a literal edit.
  await reviews(files, move(), edit(files, "m.ts", [size(source), size(source)], "k2();\n"));
  // A class is not hoisted with its value.
  const classes = { "m.ts": "class A {}\n\nclass B {}\n\nconst k = 1;\n" };
  await reviews(classes,
    transfer(classes, "moveSource", "m.ts", [at(classes["m.ts"], "class B"), at(classes["m.ts"], "const k")], "m.ts", 0),
    edit(classes, "m.ts", [at(classes["m.ts"], "1;"), at(classes["m.ts"], "1;") + 1], "2"));
  // Python definitions run in order.
  const python = { "m.py": "def a():\n    return 1\n\ndef b():\n    return 2\n" };
  await reviews(python,
    transfer(python, "moveSource", "m.py", [at(python["m.py"], "def b"), size(python["m.py"])], "m.py", 0),
    edit(python, "m.py", [at(python["m.py"], "1\n"), at(python["m.py"], "1\n") + 1], "3"));
});

test("structured transfer evidence requires located material", async () => {
  const doc = '{"a": 1, "b": 2}';
  const result = await evaluateTransfer("c.json", [doc, doc, '{"b": 2, "a": 1}', '{"b": 2, "a": 1}'].map(bytes), {},
    { directories: ["", "", "", ""], crossDocument: "none", transfers: null });
  expect(result.outcome).toBe("unresolved");
  expect(result.id).toBe("json-source-transfer");
});
