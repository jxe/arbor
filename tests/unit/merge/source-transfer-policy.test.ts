import { expect, test } from "bun:test";
import { evaluateSourceTransfer } from "../../../packages/merge/src/format-rules.ts";
import { Fixture } from "./fixture.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const policy = (a: string, b: string, path = "note.md") =>
  evaluateSourceTransfer(path, [a, b, b, b].map(bytes));

test("Markdown transfer allows plain paragraph changes beside unchanged protected syntax", () => {
  for (const newline of ["\n", "\r\n"]) {
    const before = [
      "# Title",
      "",
      "café",
      "",
      "```json",
      '{"a": 1}',
      "```",
      "",
      "Tail",
      "",
    ].join(newline);
    expect(policy(before, before + newline + "café" + newline).outcome).toBe(
      "resolved"
    );
    expect(policy(before, before.replace("café", "peer")).outcome).toBe(
      "resolved"
    );
  }
});

test.each([
  ["# Title\n\nText\n", "# Changed\n\nText\n"],
  ["Text\n\n", "Text\n\n- List\n"],
  ["- List\n\n", "- List\n\n  continuation\n"],
  ["Text\n\n", "Text\n\n[link](url)\n"],
  ["Title\n---\n\nText\n", "Title\n\n---\n\nText\n"],
  ["```json\n{}\n```\n", '```json\n{"a":1}\n```\n'],
  ["---\nid: one\n---\n\nText\n", "---\nid: two\n---\n\nText\n"],
  ["<div>\n\nText\n\n</div>\n", "<div>\n\nText\n\nCopy\n\n</div>\n"],
  ["```\nText\n", "```\nText\nCopy\n"],
  ["    code\n\nText\n", "    changed\n\nText\n"],
  ["| a | b |\n|---|---|\n", "| a | b |\n|---|---|\n| x | y |\n"],
])("Markdown transfer reviews protected structure: %s", (a, b) => {
  expect(policy(a, b).outcome).toBe("unresolved");
});

test("transfer dispatch respects format overrides, binary, UTF-8 and budget", () => {
  for (const path of ["note.json", "note.yaml", "note.ts", "note.bin"])
    expect(policy("abc", "abcabc", path).outcome).toBe("unresolved");
  expect(
    evaluateSourceTransfer(
      "note.md",
      ["abc", "abcabc", "abcabc", "abcabc"].map(bytes),
      { format: "json" }
    ).id
  ).toBe("json-source-transfer");
  expect(
    evaluateSourceTransfer("note.txt", [new Uint8Array([0xff])]).outcome
  ).toBe("unresolved");
  expect(policy("a", "a".repeat(256 * 1024 + 1)).outcome).toBe("unresolved");
});

for (const kind of ["copySource", "moveSource"] as const)
  for (const reverse of [false, true])
    for (const newline of ["\n", "\r\n"])
      for (const selectedText of [
        "Alpha",
        "**Alpha** and `code` and [link](https://example.org)",
      ]) {
        test(`${kind} across Markdown documents with an independent peer edit (${reverse}, ${JSON.stringify(
          newline
        )}, ${selectedText})`, async () => {
          const f = new Fixture();
          const source = ["# Source", "", selectedText, "", "Tail", ""].join(
            newline
          );
          const target = ["# Target", "", "Other", "", ""].join(newline);
          const selected = selectedText + newline + newline;
          const start = Buffer.byteLength(
            source.slice(0, source.indexOf(selectedText))
          );
          const end = start + Buffer.byteLength(selected);
          const moved =
            kind === "copySource" ? source : source.replace(selected, "");
          const base = f.tree({ "source.md": source, "target.md": target });
          const transfer = f.request(
            base,
            f.tree({ "source.md": moved, "target.md": target + selected }),
            [
              {
                key: "transfer",
                kind,
                source: f.ref("/source.md", source, [start, end]),
                at: f.ref("/target.md", target, [
                  Buffer.byteLength(target),
                  Buffer.byteLength(target),
                ]),
                side: "before",
              },
            ],
            "transfer"
          );
          const tail = Buffer.byteLength(
            source.slice(0, source.indexOf("Tail"))
          );
          const peer = f.request(
            base,
            f.tree({
              "source.md": source.replace("Tail", "Peer"),
              "target.md": target,
            }),
            [
              {
                key: "peer",
                kind: "editSource",
                source: f.ref("/source.md", source, [tail, tail + 4]),
                text: "Peer",
              },
            ],
            "peer"
          );
          const first = await f.run(reverse ? transfer : peer);
          const second = reverse ? peer : transfer;
          second.current = first.result;
          const result = await f.run(second);
          expect(result.decisions).toEqual([]);
          expect(f.content(result.result.object, "source.md")).toBe(
            moved.replace("Tail", "Peer")
          );
          expect(f.content(result.result.object, "target.md")).toBe(
            target + selected
          );
          expect(
            result.evidence.formats.some(
              (e) =>
                e.id === "markdown-source-transfer" && e.outcome === "resolved"
            )
          ).toBe(true);
          // Load the retained result in a later request, not just the immediate projection.
          const continued = await f.run(
            f.request(
              result.result,
              result.result.object,
              [
                {
                  key: "read-again",
                  kind: "editSource",
                  source: f.ref(
                    "/source.md",
                    moved.replace("Tail", "Peer"),
                    [0, 0]
                  ),
                  text: "",
                },
              ],
              "continued"
            )
          );
          expect(continued.result.object).toBe(result.result.object);
        });
      }

test("formatted transfers localize opaque uncertainty", () => {
  for (const opaque of ["<div>opaque</div>\n\n", "```js\nx()\n```\n\n"]) {
    const before = opaque + "Hello\n\n";
    expect(
      policy(
        before,
        before + "**Strong** and `code` and [link](https://example.org)\n"
      ).outcome
    ).toBe("resolved");
  }
  expect(
    policy("Hello\n\n<div>\nunknown", "Hello **world**\n\n<div>\nunknown")
      .outcome
  ).toBe("resolved");
  for (const span of [
    "**partial",
    "[relative](./page)",
    "[reference][id]",
    "`unclosed",
  ]) {
    expect(policy("Hello\n\n", "Hello\n\n" + span).outcome).toBe("unresolved");
  }
});
