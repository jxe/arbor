import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMarkdown, placeDirectoryChildren, reorderChildLinks, serializeMarkdown, type DirectoryPlacementChild, type PlacementDirectory } from "@overstory/protocol";

describe("bounded directory child placement", () => {
  test("matches the language-neutral placement fixtures", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../docs/overstory-spec/conformance/directory-documents.json"), "utf8")) as {
      cases: Array<{
        directory: PlacementDirectory;
        source: string;
        children: DirectoryPlacementChild[];
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
      body: "sibling" as const,
    })).reverse();
    const result = placeDirectoryChildren({ path: "/dir", body: "index" }, parseMarkdown(source), children);
    expect(result.generatedChildren).toHaveLength(125);
    expect(result.generatedChildren[0]).toBe("/dir/child-000");
    expect(result.generatedChildren.at(-1)).toBe("/dir/child-124");
    expect(serializeMarkdown(result.document, result.document.blocks)).toBe(source);
  });

  test("moving a generated child makes it an authored placement", () => {
    const source = "# Directory\n\n<!-- arbor:children -->\n";
    const placed = placeDirectoryChildren({ path: "/dir", body: "index" }, parseMarkdown(source), [{ name: "child", path: "/dir/child", body: "sibling" }]);
    const moved = reorderChildLinks(placed.document.blocks, {
      sourceDirectory: "/dir",
      removePaths: ["/dir/child"],
      insertMoves: [{ oldPath: "/dir/child", newPath: "/dir/child", newBody: "sibling" }],
      beforeBlockId: placed.document.blocks[0]!.id,
    });
    expect(moved.anchor).toBe("found");
    expect(serializeMarkdown(placed.document, moved.blocks)).toStartWith("[child](child.md)\n\n# Directory");
  });
});
