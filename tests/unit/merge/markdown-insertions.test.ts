import { expect, test } from "bun:test";
import { Fixture } from "./fixture.ts";
import type { FormatConfig } from "../../../packages/merge/src/format-rules.ts";

const cases = [
  {
    name: "formatted list items",
    source: "- Existing\n",
    at: 11,
    a: "- **First** and `code`\n",
    b: "- [Second](https://example.org)\n",
    safe: true,
  },
  {
    name: "nested list items",
    source: "- Parent\n  - Existing\n",
    at: 22,
    a: "  - **First**\n",
    b: "  - Second\n",
    safe: true,
  },
  {
    name: "ordered items",
    source: "1. Existing\n",
    at: 12,
    a: "2. **First**\n",
    b: "2. Second\n",
    safe: true,
  },
  {
    name: "complete inline spans",
    source: "Hello ",
    at: 6,
    a: "**Alice**",
    b: "[Bob](https://example.org)",
    safe: true,
  },
  {
    name: "prose after HTML",
    source: "<div>opaque</div>\n\nHello",
    at: 24,
    a: " Alice",
    b: " Bob",
    safe: true,
  },
  {
    name: "prose before unclosed HTML",
    source: "Hello\n\n<div>\nunknown",
    at: 5,
    a: " Alice",
    b: " Bob",
    safe: true,
  },
  {
    name: "unclosed HTML at EOF",
    source: "<div>\nHello",
    at: 11,
    a: " Alice",
    b: " Bob",
    safe: false,
  },
  {
    name: "HTML without closing separator",
    source: "<div>opaque</div>\nHello",
    at: 22,
    a: " Alice",
    b: " Bob",
    safe: false,
  },
  {
    name: "nested HTML scope",
    source: "<div>\n<div>inner</div>\nHello\n</div>\n",
    at: 27,
    a: " Alice",
    b: " Bob",
    safe: false,
  },
  {
    name: "reference spans",
    source: "Hello ",
    at: 6,
    a: "[Alice][ref]",
    b: "[Bob][ref]",
    safe: false,
  },
  {
    name: "partial emphasis",
    source: "Hello ",
    at: 6,
    a: "**Alice",
    b: "Bob**",
    safe: false,
  },
  {
    name: "inline prose",
    source: "Hello",
    at: 5,
    a: " Alice",
    b: " Bob",
    safe: true,
  },
  {
    name: "new paragraphs",
    source: "Intro\n",
    at: 6,
    a: "\nFirst paragraph.\n",
    b: "\nSecond paragraph.\n",
    safe: true,
  },
  {
    name: "paragraphs without final newline",
    source: "Intro",
    at: 5,
    a: "\n\nFirst paragraph.",
    b: "\n\nSecond paragraph.",
    safe: true,
  },
  {
    name: "list items",
    source: "- Existing\n",
    at: 11,
    a: "- First\n",
    b: "- Second\n",
    safe: true,
  },
  {
    name: "task items",
    source: "# Tasks\n",
    at: 8,
    a: "- [ ] First\n",
    b: "- [x] Second\n",
    safe: true,
  },
  {
    name: "Unicode and CRLF",
    source: "α\r\n",
    at: 4,
    a: "\r\nFirst\r\n",
    b: "\r\nSecond\r\n",
    safe: true,
  },
  {
    name: "empty document",
    source: "",
    at: 0,
    a: "First\n",
    b: "Second\n",
    safe: true,
  },
  {
    name: "frontmatter",
    source: "---\ntitle: Hi\n---\nBody\n",
    at: 13,
    a: " A",
    b: " B",
    safe: false,
  },
  {
    name: "code fence",
    source: "```ts\nconst x = 1;\n```\n",
    at: 17,
    a: "2",
    b: "3",
    safe: false,
  },
  {
    name: "unlabelled fence",
    source: "```\nhello\n```\n",
    at: 9,
    a: " A",
    b: " B",
    safe: false,
  },
  {
    name: "link destination",
    source: "[Label](https://example.com)",
    at: 26,
    a: "/a",
    b: "/b",
    safe: false,
  },
  {
    name: "table",
    source: "| A | B |\n",
    at: 3,
    a: " X",
    b: " Y",
    safe: false,
  },
  {
    name: "inline code",
    source: "Use `value` here",
    at: 10,
    a: "a",
    b: "b",
    safe: false,
  },
  {
    name: "indented code",
    source: "    value",
    at: 9,
    a: "a",
    b: "b",
    safe: false,
  },
  {
    name: "raw HTML block",
    source: "<div>\nhello\n</div>\n",
    at: 11,
    a: "a",
    b: "b",
    safe: false,
  },
  {
    name: "new fences",
    source: "Intro\n",
    at: 6,
    a: "```ts\nx\n```\n",
    b: "```ts\ny\n```\n",
    safe: false,
  },
  {
    name: "new reference definitions",
    source: "Intro\n",
    at: 6,
    a: "[x]: /a\n",
    b: "[x]: /b\n",
    safe: false,
  },
  {
    name: "task checkbox",
    source: "- [ ] Task\n",
    at: 3,
    a: "x",
    b: "X",
    safe: false,
  },
];

for (const c of cases)
  test(`Markdown default: ${c.name}`, async () => {
    for (const reverse of [false, true]) {
      const f = new Fixture(),
        base = f.tree({ "note.md": c.source });
      const apply = (text: string) =>
        Buffer.concat([
          Buffer.from(c.source).subarray(0, c.at),
          Buffer.from(text),
          Buffer.from(c.source).subarray(c.at),
        ]).toString("utf8");
      const request = (change: string, text: string) =>
        f.request(
          base,
          f.tree({ "note.md": apply(text) }),
          [
            {
              key: "insert",
              kind: "editSource",
              source: f.ref("/note.md", c.source, [c.at, c.at]),
              text,
            },
          ],
          change
        );
      const a = request("a", c.a),
        b = request("b", c.b),
        first = await f.run(reverse ? b : a),
        second = reverse ? a : b;
      second.current = first.result;
      const result = await f.run(second);
      if (c.safe) {
        expect(result.decisions).toEqual([]);
        expect(result.result.object).toBe(
          f.tree({ "note.md": apply(c.a + c.b) })
        );
        expect(
          result.evidence.formats.some(
            (e) =>
              e.id === "markdown-insertions" &&
              e.config.proseInsertions === "preserve-both"
          )
        ).toBe(true);
      } else expect(result.decisions.length).toBeGreaterThan(0);
    }
  });

for (const [path, config, safe] of [
  ["note.md", { proseInsertions: "review" }, false],
  ["note.txt", {}, false],
  ["note.txt", { proseInsertions: "preserve-both" }, true],
  ["note.data", { format: "markdown" }, true],
  ["note.md", { format: "json", proseInsertions: "preserve-both" }, false],
] as Array<[string, FormatConfig, boolean]>)
  test(`insertion policy respects ${path} ${JSON.stringify(
    config
  )}`, async () => {
    const f = new Fixture(),
      base = f.tree({ [path]: "hello" });
    const request = (change: string, text: string) => {
      const r = f.request(
        base,
        f.tree({ [path]: "hello" + text }),
        [
          {
            key: "insert",
            kind: "editSource",
            source: f.ref("/" + path, "hello", [5, 5]),
            text,
          },
        ],
        change
      );
      r.rules.config = { formats: { ["/" + path]: config } };
      return r;
    };
    const first = await f.run(request("a", " A")),
      second = request("b", " B");
    second.current = first.result;
    const result = await f.run(second);
    expect(result.decisions.length === 0).toBe(safe);
  });
