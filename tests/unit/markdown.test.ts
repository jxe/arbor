import { describe, expect, test } from "bun:test";
import { blockFingerprint, parseMarkdown, serializeMarkdown } from "@arbor/editor";

describe("Markdown source preservation", () => {
  test("a no-op round trip is byte-identical", () => {
    const source = "---\r\ntitle: 'Kept' # comment\r\n---\r\n# Hello\r\n\r\nA  paragraph.\r\n";
    const document = parseMarkdown(source);
    expect(serializeMarkdown(document, document.blocks)).toBe(source);
  });

  test("frontmatter edits retain comments and ordering", () => {
    const source = "---\ntitle: Kept # comment\nstatus: draft\n---\nBody\n";
    const document = parseMarkdown(source);
    const output = serializeMarkdown(document, document.blocks, { status: "published" });
    expect(output).toContain("title: Kept # comment");
    expect(output).toContain("status: published");
  });
});

describe("toggle lists", () => {
  test("parses nested toggles and arbitrary children", () => {
    const source = "▸ Research\n  - First\n  ▸ Nested\n    More detail\nAfter\n";
    const document = parseMarkdown(source);
    expect(document.blocks[0]?.type).toBe("toggle");
    expect(document.blocks[0]?.children[0]?.type).toBe("bulletListItem");
    expect(document.blocks[0]?.children[1]?.type).toBe("toggle");
    expect(document.blocks[1]?.content).toBe("After");
    expect(serializeMarkdown(document, document.blocks)).toBe(source);
  });

  test("fenced code does not terminate a toggle", () => {
    const source = "▸ Code\n  ```md\n▸ not a toggle\n  ```\nAfter\n";
    const document = parseMarkdown(source);
    expect(document.blocks[0]?.type).toBe("toggle");
    expect(document.blocks[0]?.children[0]?.type).toBe("codeBlock");
    expect(serializeMarkdown(document, document.blocks)).toBe(source);
  });

  test("editing a title canonicalizes only the toggle region", () => {
    const source = "Before\n\n▸ Old\n  Child\nAfter\n";
    const document = parseMarkdown(source);
    const toggle = document.blocks.find((block) => block.type === "toggle")!;
    toggle.content = "New";
    expect(toggle.sourceHash).not.toBe(blockFingerprint(toggle));
    const output = serializeMarkdown(document, document.blocks);
    expect(output).toContain("Before\n\n▸ New\n  Child\nAfter\n");
  });

  test("details HTML remains raw", () => {
    const source = "<details>\n<summary>Portable</summary>\ntext\n</details>\n";
    const document = parseMarkdown(source);
    expect(document.blocks[0]?.type).toBe("rawMarkdown");
    expect(serializeMarkdown(document, document.blocks)).toBe(source);
  });
});
