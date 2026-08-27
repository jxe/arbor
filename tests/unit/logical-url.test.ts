import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCanonicalLink,
  buildNetworkLocator,
  canonicalStableKey,
  decodeStableKey,
  encodeStableKey,
  relativeLogicalReference,
  rewriteLocalLinkPath,
  resolveLogicalURL,
  type ResolvedLink,
} from "@arbor/core";

interface UrlCase {
  base: string;
  href: string;
  expected: ResolvedLink;
  rewritePath?: string;
  expectedRewritten?: string;
}

const conformance = join(import.meta.dir, "../../conformance");

describe("logical URL resolution", () => {
  test("resolves every shared fixture case identically", async () => {
    const cases = JSON.parse(await readFile(join(conformance, "url-resolution.json"), "utf8")) as UrlCase[];
    expect(cases.length).toBeGreaterThan(20);
    for (const { base, href, expected, rewritePath, expectedRewritten } of cases) {
      expect(resolveLogicalURL(base, href), `${base} + ${JSON.stringify(href)}`).toEqual(expected);
      if (rewritePath) {
        expect(expectedRewritten, `${href} rewrite fixture`).toBeDefined();
        expect(rewriteLocalLinkPath(base, href, rewritePath), `${href} -> ${rewritePath}`).toBe(expectedRewritten!);
      }
    }
  });

  test("the base is directory-like regardless of body representation", () => {
    const expected = {
      kind: "local",
      path: "/projects/atlas/notes",
      stableKey: null,
      revision: null,
      applicationQuery: null,
      contentFragment: null,
      legacyStableKeyCandidate: null,
    } as const;
    for (const base of ["/projects/atlas", "/projects/atlas.md", "/projects/atlas/_index.md"]) {
      expect(resolveLogicalURL(base, "notes")).toEqual(expected);
      expect(resolveLogicalURL(base, "../roadmap")).toEqual({ ...expected, path: "/projects/roadmap" });
    }
  });

  test("relative references invert resolution", () => {
    expect(relativeLogicalReference("/projects/atlas", "/projects/atlas/notes")).toBe("notes");
    expect(relativeLogicalReference("/projects/atlas", "/projects/roadmap")).toBe("../roadmap");
    expect(relativeLogicalReference("/", "/notes")).toBe("notes");
    for (const [from, to] of [["/projects/atlas", "/projects/atlas/notes"], ["/a/b/c", "/a/x/y"]] as const) {
      const spelled = relativeLogicalReference(from, to);
      expect(resolveLogicalURL(from, spelled)).toMatchObject({ kind: "local", path: to });
    }
  });

  test("canonical keys and both locator spellings round-trip", () => {
    const stableKey = canonicalStableKey([["id", "x7f3q2"]]);
    const encoded = encodeStableKey(stableKey);
    expect(encoded).toBe("W1siaWQiLCJ4N2YzcTIiXV0");
    expect(decodeStableKey(encoded)).toBe(stableKey);
    expect(decodeStableKey(`${encoded}=`)).toBeNull();
    expect(decodeStableKey("W1sgImlkIiwgIng3ZjNxMiIgXV0")).toBeNull();
    expect(buildCanonicalLink("/projects/atlas", {
      path: "/projects/roadmap",
      stableKey,
      applicationQuery: "view=board&edit",
    })).toBe(`../roadmap?view=board&edit#arbor-key=${encoded}`);
    expect(buildNetworkLocator("../roadmap", {
      stableKey,
      applicationQuery: "view=board&edit",
      contentFragment: "implementation",
    })).toBe(`../roadmap;arbor-key=${encoded}?view=board&edit#implementation`);
    expect(rewriteLocalLinkPath(
      "/projects/atlas",
      `../old?view=board&edit#arbor-key=${encoded}`,
      "/projects/roadmap",
    )).toBe(`../roadmap?view=board&edit#arbor-key=${encoded}`);
    expect(rewriteLocalLinkPath(
      "/projects/atlas",
      "../old?view=board#implementation",
      "/projects/roadmap",
    )).toBe("../roadmap?view=board#implementation");
  });
});
