import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TreeChild } from "@arbor/core/internal";
import { completeDirectoryDocument } from "@arbor/editor";

const child = (name: string, path: string, pageID?: string): TreeChild => ({
  tree: "local",
  name,
  path,
  kind: "markdown",
  materialization: "available",
  ...(pageID ? { pageID } : {}),
});

describe("complete directory Markdown", () => {
  test("matches the language-neutral completion fixtures", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../conformance/directory-documents.json"), "utf8")) as {
      cases: Array<{
        directory: string;
        source: string;
        children: Array<{ name: string; path: string; pageID?: string }>;
        expectedSource: string;
        expectedAddedChildren: string[];
      }>;
    };
    for (const item of fixture.cases) {
      const result = completeDirectoryDocument(
        item.directory,
        item.source,
        item.children.map(({ name, path, pageID }) => child(name, path, pageID)),
      );
      expect(result.source).toBe(item.expectedSource);
      expect(result.addedChildren).toEqual(item.expectedAddedChildren);
    }
  });

  test("preserves authored source and appends only unmatched children", () => {
    const source = "Intro with [inline](alpha).\r\n\r\n[Beta label](beta)\r\n\r\n";
    const result = completeDirectoryDocument("/notes", source, [
      child("alpha", "/notes/alpha"),
      child("beta", "/notes/beta"),
    ]);
    expect(result.source).toBe(`${source}[alpha](alpha)\r\n`);
    expect(result.addedChildren).toEqual(["/notes/alpha"]);
    expect(result.document.source).toBe(result.source);
  });

  test("the first standalone link owns placement and later duplicates remain ordinary", () => {
    const source = "[First](child)\n\nText\n\n[Second](child)\n";
    expect(completeDirectoryDocument("/dir", source, [child("child", "/dir/child")]).source).toBe(source);
  });

  test("durable identity matches despite a stale path", () => {
    const source = "[Moved](old#page-opaque)\n";
    const result = completeDirectoryDocument("/dir", source, [child("Moved", "/dir/new", "page-opaque")]);
    expect(result.source).toBe(source);
  });

  test("unmatched children use unsigned UTF-8 path order", () => {
    const result = completeDirectoryDocument("/dir", "", [
      child("z", "/dir/z"),
      child("ä", "/dir/ä"),
      child("A", "/dir/A"),
    ]);
    expect(result.addedChildren).toEqual(["/dir/A", "/dir/z", "/dir/ä"]);
    expect(result.source).not.toContain("managed:");
  });

  test("completes more than one protocol page of children in one provider snapshot", () => {
    const children = Array.from({ length: 125 }, (_, index) =>
      child(`child-${String(index).padStart(3, "0")}`, `/dir/child-${String(index).padStart(3, "0")}`)
    ).reverse();
    const result = completeDirectoryDocument("/dir", "", children);
    expect(result.addedChildren).toHaveLength(125);
    expect(result.addedChildren[0]).toBe("/dir/child-000");
    expect(result.addedChildren.at(-1)).toBe("/dir/child-124");
  });
});
