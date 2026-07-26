import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isSyntheticRowBlockID,
  projectDirectoryDocument,
  syntheticRowBlockID,
  type ProjectionInput,
} from "@arbor/core";

const fixturesDir = join(import.meta.dir, "../fixtures/protocol/projection");

interface ProjectionFixture {
  name: string;
  input: ProjectionInput;
  expected: {
    bodyState: "stored" | "implicit";
    visibleBlocks: unknown[];
    managedChildren: unknown[];
  };
}

const fixtureNames = (await readdir(fixturesDir)).filter((name) => name.endsWith(".json")).sort();

describe("shared directory projection fixtures", () => {
  test("the fixture set is present", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(9);
  });

  for (const fixtureName of fixtureNames) {
    test(fixtureName, async () => {
      const fixture = JSON.parse(await readFile(join(fixturesDir, fixtureName), "utf8")) as ProjectionFixture;
      const projected = projectDirectoryDocument(fixture.input);
      expect(projected.bodyState).toBe(fixture.expected.bodyState);
      expect(projected.visibleBlocks).toEqual(fixture.expected.visibleBlocks as never);
      expect(projected.managedChildren).toEqual(fixture.expected.managedChildren as never);
    });
  }
});

describe("projection invariants", () => {
  test("the source document is never mutated and never contains synthetic rows", () => {
    const input: ProjectionInput = {
      path: "/notes",
      document: {
        frontmatter: {},
        frontmatterSource: null,
        bodySource: "Prose.\n",
        blocks: [{ id: "b-1", type: "paragraph", content: "Prose.", children: [] }],
      },
      children: [{ name: "alpha", path: "/notes/alpha", kind: "markdown", materialization: "available" }],
    };
    const before = JSON.stringify(input.document);
    const projected = projectDirectoryDocument(input);
    expect(JSON.stringify(input.document)).toBe(before);
    expect(projected.source.blocks.some((block) => isSyntheticRowBlockID(block.id))).toBe(false);
    expect(projected.visibleBlocks.filter((block) => isSyntheticRowBlockID(block.id))).toHaveLength(1);
  });

  test("synthetic block IDs derive from identity, not listing position", () => {
    expect(syntheticRowBlockID({ pageID: "abc123", path: "/x/y" })).toBe("managed:id:abc123");
    expect(syntheticRowBlockID({ path: "/x/y" })).toBe("managed:path:/x/y");
    expect(isSyntheticRowBlockID("managed:id:abc123")).toBe(true);
    expect(isSyntheticRowBlockID("b-ordinary")).toBe(false);
  });
});
