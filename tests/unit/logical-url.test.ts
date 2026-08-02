import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { relativeLogicalReference, resolveLogicalURL, type ResolvedLink } from "@arbor/core";

interface UrlCase {
  base: string;
  href: string;
  expected: ResolvedLink;
}

const fixtures = join(import.meta.dir, "../../spec/fixtures");

describe("logical URL resolution", () => {
  test("resolves every shared fixture case identically", async () => {
    const cases = JSON.parse(await readFile(join(fixtures, "url-resolution.json"), "utf8")) as UrlCase[];
    expect(cases.length).toBeGreaterThan(20);
    for (const { base, href, expected } of cases) {
      expect(resolveLogicalURL(base, href), `${base} + ${JSON.stringify(href)}`).toEqual(expected);
    }
  });

  test("the base is directory-like regardless of body representation", () => {
    for (const base of ["/projects/atlas", "/projects/atlas.md", "/projects/atlas/_index.md"]) {
      expect(resolveLogicalURL(base, "notes")).toEqual({ kind: "local", path: "/projects/atlas/notes" });
      expect(resolveLogicalURL(base, "../roadmap")).toEqual({ kind: "local", path: "/projects/roadmap" });
    }
  });

  test("relative references invert resolution", () => {
    expect(relativeLogicalReference("/projects/atlas", "/projects/atlas/notes")).toBe("notes");
    expect(relativeLogicalReference("/projects/atlas", "/projects/roadmap")).toBe("../roadmap");
    expect(relativeLogicalReference("/", "/notes")).toBe("notes");
    for (const [from, to] of [["/projects/atlas", "/projects/atlas/notes"], ["/a/b/c", "/a/x/y"]] as const) {
      const spelled = relativeLogicalReference(from, to);
      expect(resolveLogicalURL(from, spelled)).toEqual({ kind: "local", path: to });
    }
  });
});
