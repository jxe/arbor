import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildArborLocator,
  buildMarkdownLink,
  buildNetworkLocator,
  canonicalStableKey,
  decodeStableKey,
  encodeStableKey,
  healMarkdownLinks,
  markdownLinkDestinations,
  markdownLinkFile,
  markdownSourceDirectory,
  markdownStableKey,
  relativeFileReference,
  rewriteLocalLinkPath,
  resolveLogicalURL,
  resolveNodeTarget,
  type MarkdownBodyOrigin,
  type MarkdownLinkTarget,
  type ResolvedLink,
  type ResolvedNodeTarget,
} from "@overstory/protocol";

interface UrlCase {
  sourceDirectory: string;
  href: string;
  expected: ResolvedLink;
  rewriteTarget?: { path: string; body: MarkdownBodyOrigin | null };
  expectedRewritten?: string;
}

interface HealingNode { path: string; body: MarkdownBodyOrigin | null; stableKey?: string }

const conformance = join(import.meta.dir, "../../docs/overstory-spec/conformance");
const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(conformance, name), "utf8")) as T;

describe("logical URL resolution", () => {
  test("resolves every shared fixture case identically", async () => {
    const cases = await fixture<UrlCase[]>("url-resolution.json");
    expect(cases.length).toBeGreaterThan(20);
    for (const { sourceDirectory, href, expected, rewriteTarget, expectedRewritten } of cases) {
      expect(resolveLogicalURL(sourceDirectory, href), `${sourceDirectory} + ${JSON.stringify(href)}`).toEqual(expected);
      if (rewriteTarget) {
        expect(expectedRewritten, `${href} rewrite fixture`).toBeDefined();
        expect(rewriteLocalLinkPath(sourceDirectory, href, rewriteTarget), `${href} -> ${rewriteTarget.path}`).toBe(expectedRewritten!);
      }
    }
  });

  test("resolves every shared node-target fixture identically", async () => {
    const cases = await fixture<Array<{ sourceDirectory: string; href: string; expected: ResolvedNodeTarget | null }>>("node-targets.json");
    expect(cases.length).toBeGreaterThan(10);
    for (const { sourceDirectory, href, expected } of cases) {
      expect(resolveNodeTarget(sourceDirectory, href), `${sourceDirectory} + ${href}`).toEqual(expected);
    }
  });

  test("encodes and decodes every shared key token", async () => {
    const { valid, invalid } = await fixture<{ valid: Array<{ key: string; token: string }>; invalid: string[] }>("stable-key-tokens.json");
    for (const { key, token } of valid) {
      expect(encodeStableKey(key), key).toBe(token);
      expect(decodeStableKey(token), token).toBe(key);
    }
    for (const token of invalid) expect(decodeStableKey(token), token).toBeNull();
  });

  test("finds each body's source directory and link file", async () => {
    const cases = await fixture<Array<{ path: string; body: MarkdownBodyOrigin | null; sourceDirectory: string; linkFile: string }>>("markdown-source-directories.json");
    for (const { path, body, sourceDirectory, linkFile } of cases) {
      expect(markdownSourceDirectory(path, body), `${path} ${body}`).toBe(sourceDirectory);
      expect(markdownLinkFile(path, body), `${path} ${body}`).toBe(linkFile);
    }
  });

  test("writes every shared Markdown link, and each resolves back to its target", async () => {
    const cases = await fixture<Array<{ sourceDirectory: string; target: MarkdownLinkTarget; expected: string }>>("markdown-links.json");
    for (const { sourceDirectory, target, expected } of cases) {
      expect(buildMarkdownLink(sourceDirectory, target), JSON.stringify(target)).toBe(expected);
      expect(resolveLogicalURL(sourceDirectory, expected)).toMatchObject({
        kind: "local",
        path: target.path,
        stableKey: target.stableKey ?? null,
        revision: target.revision ?? null,
        applicationQuery: target.applicationQuery ?? null,
        contentFragment: target.contentFragment ?? null,
      });
    }
  });

  test("heals every shared Markdown source", async () => {
    const cases = await fixture<Array<{
      name: string; source: string; resolveFrom: string; writeFrom: string; tree: string; nodes: HealingNode[]; expected: string;
    }>>("markdown-link-healing.json");
    for (const { name, source, resolveFrom, writeFrom, tree, nodes, expected } of cases) {
      const healed = healMarkdownLinks(source, {
        resolveFrom,
        writeFrom,
        tree,
        target: ({ path, stableKey }) => {
          const node = stableKey ? nodes.find((candidate) => candidate.stableKey === stableKey) : nodes.find((candidate) => candidate.path === path);
          return node ? { path: node.path, body: node.body, stableKey: node.stableKey ?? null } : null;
        },
      });
      expect(healed, name).toBe(expected);
    }
  });

  test("finds every shared link destination", async () => {
    const cases = await fixture<Array<{ source: string; destinations: Array<{ href: string; image: boolean }> }>>("markdown-link-destinations.json");
    for (const { source, destinations } of cases) {
      const found = markdownLinkDestinations(source);
      expect(found.map(({ href, image }) => ({ href, image }))).toEqual(destinations);
      for (const { href, start, end } of found) expect(source.slice(start, end)).toBe(href);
    }
  });

  test("arbor locators round-trip through node-target resolution", () => {
    const key = markdownStableKey("x6baw0");
    const locator = buildArborLocator("tr_sample", "/notes/deep", key);
    expect(locator).toBe("arbor://tr_sample/notes/deep;arbor-key=id:x6baw0");
    expect(resolveNodeTarget("/", locator)).toEqual({ tree: "tr_sample", path: "/notes/deep", stableKey: key });
    expect(rewriteLocalLinkPath("/", locator, { path: "/new", body: "sibling" })).toBe("arbor://tr_sample/new;arbor-key=id:x6baw0");
    expect(rewriteLocalLinkPath("/", "arbor://example.com/old", { path: "/new", body: "sibling" })).toBeNull();
  });

  test("a bare fragment is only a content fragment", () => {
    expect(resolveLogicalURL("/", "#x7f3q2")).toEqual({ kind: "fragment", contentFragment: "x7f3q2" });
    expect(resolveLogicalURL("/", "Calendar.md#h31mlm")).toMatchObject({ path: "/Calendar", stableKey: null, contentFragment: "h31mlm" });
    expect(resolveNodeTarget("/", "#x7f3q2")).toBeNull();
  });

  test("relative file references invert resolution", () => {
    for (const [from, file, node] of [
      ["/projects/atlas", "/projects/atlas/notes.md", "/projects/atlas/notes"],
      ["/a/b/c", "/a/x/y/_index.md", "/a/x/y"],
      ["/", "/_index.md", "/"],
      ["/a", "/a", "/a"],
      ["/", "/a b/c;d.md", "/a b/c;d"],
    ] as const) {
      expect(resolveLogicalURL(from, relativeFileReference(from, file)), `${from} -> ${file}`).toMatchObject({ kind: "local", path: node });
    }
  });

  test("the key spellings carry the same token", () => {
    const stableKey = canonicalStableKey([["id", "x7f3q2"]]);
    expect(buildNetworkLocator("../roadmap.md", { stableKey, applicationQuery: "view=board&edit", contentFragment: "implementation" }))
      .toBe("../roadmap.md;arbor-key=id:x7f3q2?view=board&edit#implementation");
    expect(buildMarkdownLink("/projects/atlas", { path: "/projects/roadmap", body: "sibling", stableKey, applicationQuery: "view=board&edit" }))
      .toBe("../roadmap.md?view=board&edit#arbor-key=id:x7f3q2");
  });
});
