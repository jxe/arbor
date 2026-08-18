import { describe, expect, test } from "bun:test";
import {
  blockFingerprint,
  documentIcon,
  parseMarkdown,
  serializeMarkdown,
  sourceSettingDocumentIcon,
} from "@arbor/editor";

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

describe("portable document icons", () => {
  test("reads and replaces the leading emoji of the first H1 only", () => {
    const source = "---\ntitle: Kept # comment\n---\n# 🌳 Atlas\n\nBody with  two spaces.\n";
    const document = parseMarkdown(source);
    expect(documentIcon(document)).toBe("🌳");
    expect(sourceSettingDocumentIcon(document, "📚", "ignored", () => "new-heading")).toBe(
      "---\ntitle: Kept # comment\n---\n# 📚 Atlas\n\nBody with  two spaces.\n",
    );
  });

  test("prepends an H1 when setting an icon on an implicit body", () => {
    const document = parseMarkdown("[child](child)\n");
    expect(sourceSettingDocumentIcon(document, "🪴", "Garden", () => "new-heading")).toBe(
      "# 🪴 Garden\n\n[child](child)\n",
    );
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

describe("footnotes and LaTeX", () => {
  test("round-trips inline references, inline math, and display math", () => {
    const source = "Mass is $E = mc^2$.[^einstein]\n\n$$\n\\int_0^1 x^2\\,dx\n$$\n\n[^einstein]: A compact relation.\n";
    const document = parseMarkdown(source);

    expect(document.blocks[0]?.type).toBe("paragraph");
    expect(document.blocks[1]?.type).toBe("mathBlock");
    expect(document.blocks[1]?.content).toBe("\\int_0^1 x^2\\,dx");
    expect(document.blocks[2]?.type).toBe("footnoteDefinition");
    expect(document.blocks[2]?.props?.label).toBe("einstein");
    expect(serializeMarkdown(document, document.blocks)).toBe(source);
  });

  test("parses indented footnote children and canonicalizes edited definitions", () => {
    const source = "[^long]: First paragraph\n\n    Second paragraph with $x$.\nAfter\n";
    const document = parseMarkdown(source);
    const footnote = document.blocks[0]!;

    expect(footnote.type).toBe("footnoteDefinition");
    expect(footnote.children.find((block) => block.type === "paragraph")?.content).toContain("Second paragraph");
    footnote.content = "Changed";

    expect(serializeMarkdown(document, document.blocks)).toContain(
      "[^long]: Changed\n\n    Second paragraph with $x$.\nAfter\n",
    );
  });

  test("canonicalizes edited display math without changing surrounding blocks", () => {
    const source = "Before\n\n$$ E = mc^2 $$\n\nAfter\n";
    const document = parseMarkdown(source);
    const equation = document.blocks.find((block) => block.type === "mathBlock")!;
    equation.content = "E = h\\nu";

    expect(serializeMarkdown(document, document.blocks)).toBe(
      "Before\n\n$$\nE = h\\nu\n$$\n\nAfter\n",
    );
  });

  test("keeps separator blanks out of adjacent footnote children", () => {
    const source = "[^one]: First.\n\n[^two]: Second.\n";
    const document = parseMarkdown(source);

    expect(document.blocks.map((block) => block.type)).toEqual(["footnoteDefinition", "footnoteDefinition"]);
    expect(document.blocks[0]?.children).toHaveLength(0);
    document.blocks[0]!.content = "Changed.";
    expect(serializeMarkdown(document, document.blocks)).toBe("[^one]: Changed.\n\n[^two]: Second.\n");
  });
});
