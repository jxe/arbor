// Rename 002: the spellings from before the Overstory rename are read and
// never written. These tests and tests/fixtures/legacy-names go with the aliases.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMarkdownLink,
  buildNetworkLocator,
  buildOverstoryLocator,
  encodeProtocolDirectory,
  hashObject,
  normalizeLegacyLocator,
  parseMarkdown,
  parseProfileLocator,
  parseTreeReference,
  placeDirectoryChildren,
  ProtocolClient,
  resolveLogicalURL,
  rewriteLocalLinkPath,
  serializeMarkdown,
  type DirectoryPlacementChild,
  type MarkdownBodyOrigin,
  type PlacementDirectory,
} from "@ovst/protocol";
import { discoverWorkspace, isIgnoreFileName, isTransactionTemporaryName, loadIgnorePolicy, WORKSPACE_WATCHER_IGNORE_GLOBS } from "@ovst/fs";

interface Aliases {
  locators: Array<{ sourceDirectory: string; input: string; normalized: string; resolves: boolean }>;
  rewrites: Array<{ sourceDirectory: string; href: string; target: { path: string; body: MarkdownBodyOrigin | null }; expected: string }>;
  profileLocators: Array<{ input: string; locator: string; origin: string }>;
  treeReferences: Array<{ value: string; tree?: string; configuration?: boolean; invalid?: true }>;
  childrenMarker: Array<{
    name: string;
    directory: PlacementDirectory;
    source: string;
    children: DirectoryPlacementChild[];
    expectedGeneratedChildren: string[];
    expectedGeneratedAfterMarker: boolean;
    expectedDiagnosticCodes: string[];
  }>;
  ignorePolicy: Array<{ name: string; files: Record<string, string>; path: string; isDirectory: boolean; decision: string; source?: string }>;
}

const aliases = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/legacy-names/aliases.json"), "utf8")) as Aliases;
const OLD = /arbor/i;
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("locators in the old spelling", () => {
  test("normalize to the new spelling and resolve as it does", () => {
    for (const { sourceDirectory, input, normalized, resolves } of aliases.locators) {
      expect(normalizeLegacyLocator(input), input).toBe(normalized);
      expect(normalizeLegacyLocator(normalized), `${input} twice`).toBe(normalized);
      const resolved = resolveLogicalURL(sourceDirectory, input);
      expect(resolved, input).toEqual(resolveLogicalURL(sourceDirectory, normalized));
      expect(resolved !== null, input).toBe(resolves);
    }
  });

  test("a link built from a parsed old link has the new spelling", () => {
    const stableKey = '[["id","x7f3q2"]]';
    const revision = `sha256:${"0123456789abcdef".repeat(4)}`;
    const absolute = resolveLogicalURL("/", `arbor://tr_7k3m/essays/drift;arbor-key=id:x7f3q2;arbor-rev=${revision}`);
    if (absolute?.kind !== "overstory" || !("treeID" in absolute.authority)) throw new Error("expected an overstory locator");
    expect(absolute).toMatchObject({ path: "/essays/drift", stableKey, revision });
    expect(buildOverstoryLocator(absolute.authority.treeID, absolute.path, absolute.stableKey)).toBe("overstory://tr_7k3m/essays/drift;overstory-key=id:x7f3q2");
    expect(buildNetworkLocator("/essays/drift", absolute)).toBe(`/essays/drift;overstory-key=id:x7f3q2;overstory-rev=${revision}`);

    const relative = resolveLogicalURL("/projects/atlas", "../roadmap.md#arbor-key=id:x7f3q2");
    if (relative?.kind !== "local") throw new Error("expected a local link");
    expect(buildMarkdownLink("/projects/atlas", { ...relative, body: "sibling" })).toBe("../roadmap.md#overstory-key=id:x7f3q2");

    for (const { sourceDirectory, href, target, expected } of aliases.rewrites) {
      expect(rewriteLocalLinkPath(sourceDirectory, href, target), href).toBe(expected);
    }
  });

  test("a profile locator has the same canonical spelling", () => {
    for (const { input, locator, origin } of aliases.profileLocators) {
      expect(parseProfileLocator(input), input).toEqual({ locator, origin });
      expect(parseProfileLocator(input), input).toEqual(parseProfileLocator(input.replace("arbor://", "overstory://")));
    }
  });

  test("a tree reference names the configuration", () => {
    for (const vector of aliases.treeReferences) {
      if (vector.invalid) expect(() => parseTreeReference(vector.value)).toThrow();
      else expect(parseTreeReference(vector.value)).toEqual({ tree: vector.tree!, configuration: vector.configuration! });
    }
  });

  test("an update addressed to the old configuration reference is sent to the new one", async () => {
    const tree = "tr_owozr6aegt5z7x6qyllvzljl5u";
    const requested: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requested.push(new URL(request.url).pathname);
        return Response.json({ error: "permission-denied", message: "refused", retryable: false }, { status: 403 });
      },
    });
    try {
      const client = new ProtocolClient(server.url.toString().replace(/\/$/, ""));
      const directory = encodeProtocolDirectory({ type: "directory", entries: [] });
      const snapshot = { root: hashObject(directory), objects: new Map([[hashObject(directory), directory]]) };
      await expect(client.submitUpdate(`${tree};arbor-config`, null, snapshot)).rejects.toThrow();
    } finally {
      server.stop(true);
    }
    expect(requested).toEqual([`/.overstory/trees/${encodeURIComponent(`${tree};overstory-config`)}/updates`]);
  });
});

describe("the old children marker", () => {
  for (const item of aliases.childrenMarker) {
    test(item.name, () => {
      const result = placeDirectoryChildren(item.directory, parseMarkdown(item.source), item.children);
      expect(result.generatedChildren).toEqual(item.expectedGeneratedChildren);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(item.expectedDiagnosticCodes);
      const marker = result.document.blocks.findIndex((block) => block.props?.storyChildrenMarker === true);
      if (item.expectedGeneratedAfterMarker) {
        expect(marker).toBeGreaterThanOrEqual(0);
        expect(result.document.blocks[marker + 1]?.props?.storyGenerated).toBe(true);
      }
      // Nothing rewrites an authored marker: it is serialized as written.
      expect(serializeMarkdown(result.document, result.document.blocks)).toBe(item.source);
    });
  }
});

describe("old ignore files, temporaries and state directory", () => {
  for (const item of aliases.ignorePolicy) {
    test(item.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "story-legacy-ignore-"));
      temporaryPaths.push(root);
      for (const [path, text] of Object.entries(item.files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const policy = await loadIgnorePolicy(root);
      const decision = await policy.decision(item.path, item.isDirectory);
      expect(decision.membership).toBe(item.decision as typeof decision.membership);
      if (item.source) expect(decision.source).toBe(item.source);
      expect(policy.diagnostics).toEqual([]);
    });
  }

  test("an unreadable .overstoryignore still shadows .arborignore", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-legacy-ignore-"));
    temporaryPaths.push(root);
    await writeFile(join(root, ".arborignore"), "*.md\n");
    await writeFile(join(root, ".overstoryignore"), Buffer.from([0xff, 0x0a]));
    const policy = await loadIgnorePolicy(root);
    expect((await policy.decision("/notes.md", false)).membership).toBe("included");
    expect(policy.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([["ignore-file-not-utf8", "/.overstoryignore"]]);
  });

  test("both names are ignore files, and both temporaries are excluded", () => {
    expect(isIgnoreFileName(".arborignore")).toBe(true);
    expect(isIgnoreFileName(".overstoryignore")).toBe(true);
    for (const name of [".a.md.arbor-write-1", ".a.md.arbor-txn-1", ".a.md.overstory-write-1", ".a.md.overstory-txn-1"]) {
      expect(isTransactionTemporaryName(name), name).toBe(true);
    }
    expect(WORKSPACE_WATCHER_IGNORE_GLOBS).toEqual(expect.arrayContaining(["**/.arbor/**", "**/*.arbor-txn-*", "**/*.arbor-write-*", "**/.overstory/**"]));
  });

  test("discovery reads .arborignore and leaves old strays out of the tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-legacy-discovery-"));
    temporaryPaths.push(root);
    await mkdir(join(root, ".arbor"), { recursive: true });
    await writeFile(join(root, ".arbor", "state.json"), "{}\n");
    await writeFile(join(root, ".arborignore"), "draft.md\n");
    await writeFile(join(root, "draft.md"), "# Draft\n");
    await writeFile(join(root, "kept.md"), "# Kept\n");
    await writeFile(join(root, ".kept.md.arbor-write-1"), "partial");
    await writeFile(join(root, ".kept.md.arbor-txn-1"), "partial");
    const discovery = await discoverWorkspace(root);
    expect(discovery.files.map((file) => file.treePath).sort()).toEqual(["/.arborignore", "/kept.md"]);
  });
});

describe("writers", () => {
  test("emit no old spelling", () => {
    const written = [
      buildOverstoryLocator("tr_7k3m", "/essays/drift", '[["id","x7f3q2"]]'),
      buildNetworkLocator("/essays/drift", { stableKey: '[["id","x7f3q2"]]', revision: `sha256:${"0".repeat(64)}`, contentFragment: "x" }),
      buildMarkdownLink("/", { path: "/essays/drift", body: "sibling", stableKey: '[["id","x7f3q2"]]' }),
    ];
    for (const text of written) expect(text).not.toMatch(OLD);
  });
});
