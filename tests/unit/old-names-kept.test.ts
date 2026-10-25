// Old names that are kept (docs/architecture/old-names.md, "Kept"): a device's
// state directory and temporaries from builds before the Overstory rename are
// never tree content.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { discoverWorkspace, isTransactionTemporaryName, loadIgnorePolicy, WORKSPACE_WATCHER_IGNORE_GLOBS } from "@ovst/fs";

interface Kept {
  ignorePolicy: Array<{ name: string; files: Record<string, string>; path: string; isDirectory: boolean; decision: string; source?: string }>;
}

const kept = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/old-names/kept.json"), "utf8")) as Kept;
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("old temporaries and state directory", () => {
  for (const item of kept.ignorePolicy) {
    test(item.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "story-old-names-"));
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

  test("both temporaries are excluded", () => {
    for (const name of [".a.md.arbor-write-1", ".a.md.arbor-txn-1", ".a.md.overstory-write-1", ".a.md.overstory-txn-1"]) {
      expect(isTransactionTemporaryName(name), name).toBe(true);
    }
    expect(WORKSPACE_WATCHER_IGNORE_GLOBS).toEqual(expect.arrayContaining(["**/.arbor/**", "**/*.arbor-txn-*", "**/*.arbor-write-*", "**/.overstory/**"]));
  });

  test("discovery leaves old strays out of the tree, and .arborignore is now content", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-old-names-discovery-"));
    temporaryPaths.push(root);
    await mkdir(join(root, ".arbor"), { recursive: true });
    await writeFile(join(root, ".arbor", "state.json"), "{}\n");
    await writeFile(join(root, ".arborignore"), "draft.md\n");
    await writeFile(join(root, "draft.md"), "# Draft\n");
    await writeFile(join(root, ".kept.md.arbor-write-1"), "partial");
    await writeFile(join(root, ".kept.md.arbor-txn-1"), "partial");
    const discovery = await discoverWorkspace(root);
    expect(discovery.files.map((file) => file.treePath).sort()).toEqual(["/.arborignore", "/draft.md"]);
  });
});
