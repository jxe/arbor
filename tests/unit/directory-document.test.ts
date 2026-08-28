import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMarkdown, placeDirectoryChildren, reorderChildLinks, serializeMarkdown } from "@arbor/editor";

describe("bounded directory child placement", () => {
  test("matches the language-neutral placement fixtures", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../conformance/directory-documents.json"), "utf8")) as {
      cases: Array<{
        directory: string;
        source: string;
        children: Array<{ name: string; path: string; stableKey?: string }>;
        expectedBlockPaths: string[];
        expectedGeneratedChildren: string[];
        expectedDiagnosticCodes: string[];
      }>;
    };
    for (const item of fixture.cases) {
      const authored = parseMarkdown(item.source);
      const result = placeDirectoryChildren(item.directory, authored, item.children);
      expect(result.document.blocks.filter((block) => block.type === "standaloneLink").map((block) => block.props?.path)).toEqual(item.expectedBlockPaths);
      expect(result.generatedChildren).toEqual(item.expectedGeneratedChildren);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(item.expectedDiagnosticCodes);
      expect(serializeMarkdown(result.document, result.document.blocks)).toBe(item.source);
    }
  });

  test("implicit placement remains bounded with more than one protocol page", () => {
    const source = "# Directory\n";
    const children = Array.from({ length: 125 }, (_, index) => ({
      name: `child-${String(index).padStart(3, "0")}`,
      path: `/dir/child-${String(index).padStart(3, "0")}`,
    })).reverse();
    const result = placeDirectoryChildren("/dir", parseMarkdown(source), children);
    expect(result.generatedChildren).toHaveLength(125);
    expect(result.generatedChildren[0]).toBe("/dir/child-000");
    expect(result.generatedChildren.at(-1)).toBe("/dir/child-124");
    expect(serializeMarkdown(result.document, result.document.blocks)).toBe(source);
  });

  test("moving a generated child makes it an authored placement", () => {
    const source = "# Directory\n\n<!-- arbor:children -->\n";
    const placed = placeDirectoryChildren("/dir", parseMarkdown(source), [{ name: "child", path: "/dir/child" }]);
    const moved = reorderChildLinks(placed.document.blocks, {
      directory: "/dir",
      removePaths: ["/dir/child"],
      insertMoves: [{ oldPath: "/dir/child", newPath: "/dir/child" }],
      beforeBlockId: placed.document.blocks[0]!.id,
    });
    expect(moved.anchor).toBe("found");
    expect(serializeMarkdown(placed.document, moved.blocks)).toStartWith("[child](child)\n\n# Directory");
  });
});
