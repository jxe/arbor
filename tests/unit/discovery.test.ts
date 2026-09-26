import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverWorkspace, WorkspaceFS } from "@overstory/fs";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace discovery", () => {
  test("keeps .claude content while excluding generated trees and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-discovery-root-"));
    const outside = await mkdtemp(join(tmpdir(), "arbor-discovery-outside-"));
    temporaryPaths.push(root, outside);

    await mkdir(join(root, ".claude", "worktrees"), { recursive: true });
    await mkdir(join(root, ".build", "artifacts"), { recursive: true });
    await mkdir(join(root, "DerivedData", "Products"), { recursive: true });
    await writeFile(join(root, ".claude", "worktrees", "kept.md"), "---\nid: abc123\n---\nKept\n");
    await writeFile(join(root, ".build", "artifacts", "ignored.txt"), "ignored");
    await writeFile(join(root, "DerivedData", "Products", "ignored.txt"), "ignored");
    await writeFile(join(outside, "secret.md"), "---\nid: def456\n---\nOutside\n");
    await symlink(outside, join(root, "external"));

    const discovery = await discoverWorkspace(root);
    expect(discovery.files.map((file) => file.treePath)).toContain("/.claude/worktrees/kept.md");
    expect(discovery.files.some((file) => file.treePath.includes(".build"))).toBe(false);
    expect(discovery.files.some((file) => file.treePath.includes("DerivedData"))).toBe(false);
    expect(discovery.files.some((file) => file.treePath.includes("external"))).toBe(false);
    expect(discovery.pagePathsByID.get("abc123")).toBe("/.claude/worktrees/kept");
    expect(discovery.pagePathsByID.has("def456")).toBe(false);
  });

  test("uses the discovery snapshot to initialize IDs and directory visibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-discovery-fs-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-discovery-state-"));
    const outside = await mkdtemp(join(tmpdir(), "arbor-discovery-fs-outside-"));
    temporaryPaths.push(root, state, outside);
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, ".build"), { recursive: true });
    await writeFile(join(root, ".claude", "kept.md"), "---\nid: abc123\n---\nKept\n");
    await writeFile(join(root, ".build", "ignored.md"), "---\nid: def456\n---\nIgnored\n");
    await writeFile(join(outside, "secret.md"), "Outside\n");
    await symlink(outside, join(root, "external"));

    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    try {
      expect(fs.startupDiscovery().pagePathsByID.get("abc123")).toBe("/.claude/kept");
      expect(fs.startupDiscovery().pagePathsByID.has("def456")).toBe(false);
      expect((await fs.list("/")).map((entry) => entry.name)).toContain(".claude");
      expect((await fs.list("/")).map((entry) => entry.name)).not.toContain(".build");
      expect((await fs.list("/")).map((entry) => entry.name)).not.toContain("external");
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  test("supports shallow startup discovery and skips unreadable descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-discovery-shallow-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-discovery-shallow-state-"));
    const nested = join(root, "nested");
    const protectedDirectory = join(root, "protected");
    temporaryPaths.push(root, state);
    await mkdir(nested);
    await mkdir(protectedDirectory);
    await writeFile(join(root, "root.md"), "# Root\n");
    await writeFile(join(nested, "deep.md"), "# Deep\n");
    await chmod(protectedDirectory, 0o000);
    try {
      const shallow = await WorkspaceFS.open(root, { stateDirectory: state, discovery: "shallow" });
      try {
        expect(shallow.startupDiscovery().files.map((file) => file.treePath)).toEqual(["/root.md"]);
        expect(shallow.startupDiscovery().directories.map((directory) => directory.treePath)).toEqual(["/"]);
        expect((await shallow.list("/")).map((entry) => entry.name)).toContain("nested");
        expect((await shallow.list("/nested")).map((entry) => entry.name)).toContain("deep");
      } finally {
        await shallow[Symbol.asyncDispose]();
      }

      const recursive = await discoverWorkspace(root);
      expect(recursive.files.map((file) => file.treePath)).toContain("/nested/deep.md");
      expect(recursive.directories.map((directory) => directory.treePath)).not.toContain("/protected");
    } finally {
      await chmod(protectedDirectory, 0o700);
    }
  });

  test("omits reader-local mounted roots from parent discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-composed-parent-"));
    temporaryPaths.push(root);
    const mounted = join(root, "friends");
    await mkdir(mounted, { recursive: true });
    await writeFile(join(root, "parent.md"), "# Parent\n");
    await writeFile(join(mounted, "child.md"), "# Child\n");

    const discovery = await discoverWorkspace(root, { excludedRoots: [mounted] });
    expect(discovery.files.map((file) => file.name)).toEqual(["parent.md"]);
    expect(discovery.directories[0]?.childNames.has("friends")).toBe(false);
  });
});

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the watcher");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("ignore rules in discovery, listing, and watching", () => {
  async function ignoredWorkspace() {
    const root = await mkdtemp(join(tmpdir(), "arbor-ignore-discovery-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-ignore-discovery-state-"));
    temporaryPaths.push(root, state);
    await mkdir(join(root, "build"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".env\nbuild/\n");
    await writeFile(join(root, "docs", ".arborignore"), "draft.md\n");
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await writeFile(join(root, "build", "out.md"), "---\nid: built1\n---\nBuilt\n");
    await writeFile(join(root, "docs", "draft.md"), "---\nid: draft1\n---\nDraft\n");
    await writeFile(join(root, "docs", "kept.md"), "---\nid: kept1\n---\nKept\n");
    return { root, state };
  }

  test("an ignored file, directory, and page are not discovered", async () => {
    const { root } = await ignoredWorkspace();
    const discovery = await discoverWorkspace(root);
    expect(discovery.files.map((file) => file.treePath).sort()).toEqual(["/.gitignore", "/docs/.arborignore", "/docs/kept.md"]);
    expect(discovery.directories.map((directory) => directory.treePath).sort()).toEqual(["/", "/docs"]);
    expect([...discovery.directories.find((directory) => directory.treePath === "/")!.childNames].sort()).toEqual([".gitignore", "docs"]);
    expect([...discovery.pagePathsByID.keys()]).toEqual(["kept1"]);
    expect(discovery.diagnostics).toEqual([]);
  });

  test("listing and direct resolution follow the same policy", async () => {
    const { root, state } = await ignoredWorkspace();
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    try {
      expect((await fs.list("/")).map((entry) => entry.name).sort()).toEqual([".gitignore", "docs"]);
      expect((await fs.list("/docs")).map((entry) => entry.name).sort()).toEqual([".arborignore", "kept"]);
      expect((await fs.resolve("/.env")).kind).toBe("missing");
      expect((await fs.resolve("/build")).kind).toBe("missing");
      expect((await fs.resolve("/docs/draft")).kind).toBe("missing");
      expect(fs.startupDiscovery().pagePathsByID.has("draft1")).toBe(false);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
    const browsing = await WorkspaceFS.open(root, { stateDirectory: state, discovery: "none" });
    try {
      // Without discovery a local path stays addressable, but listings still follow membership.
      expect((await browsing.resolve("/.env")).kind).toBe("file");
      expect((await browsing.list("/")).map((entry) => entry.name).sort()).toEqual([".gitignore", "docs"]);
    } finally {
      await browsing[Symbol.asyncDispose]();
    }
  });

  test("watcher events for ignored paths are not node events", async () => {
    const { root, state } = await ignoredWorkspace();
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    const events: string[] = [];
    const ignored: string[] = [];
    fs.subscribe((event) => events.push(`${event.type} ${event.path}`));
    fs.subscribeIgnored((path) => ignored.push(path));
    try {
      await writeFile(join(root, "build", "more.txt"), "generated\n");
      await writeFile(join(root, ".env"), "TOKEN=rotated\n");
      await writeFile(join(root, "docs", "new.md"), "# New\n");
      await until(() => events.includes("created /docs/new") && ignored.includes("/.env") && ignored.includes("/build/more.txt"));
      await rm(join(root, "build", "more.txt"));
      await until(() => ignored.filter((path) => path === "/build/more.txt").length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // FSEvents may also replay the fixture's own writes from just before the watch began.
      expect(events).toContain("created /docs/new");
      expect(events.filter((event) => event.includes("/build") || event.includes("/.env"))).toEqual([]);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  test("an ignore-file edit reloads the policy and rediscovers once", async () => {
    const { root, state } = await ignoredWorkspace();
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    const events: string[] = [];
    fs.subscribe((event) => events.push(`${event.type} ${event.path}`));
    try {
      const before = fs.ignorePolicy;
      await writeFile(join(root, ".gitignore"), ".env\n");
      await writeFile(join(root, "docs", ".arborignore"), "kept.md\n");
      await until(() => events.includes("updated /"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events.filter((event) => event === "updated /")).toHaveLength(1);
      expect(fs.ignorePolicy).not.toBe(before);
      expect((await fs.list("/")).map((entry) => entry.name).sort()).toEqual([".gitignore", "build", "docs"]);
      expect((await fs.list("/docs")).map((entry) => entry.name).sort()).toEqual([".arborignore", "draft"]);
      expect([...fs.startupDiscovery().pagePathsByID.keys()].sort()).toEqual(["built1", "draft1"]);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  test("an ignore file that is not UTF-8 is reported and does not stop discovery", async () => {
    const { root, state } = await ignoredWorkspace();
    await writeFile(join(root, "docs", ".arborignore"), Buffer.from([0xff, 0x0a]));
    const discovery = await discoverWorkspace(root);
    expect(discovery.files.map((file) => file.treePath)).toContain("/docs/draft.md");
    expect(discovery.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([["ignore-file-not-utf8", "/docs/.arborignore"]]);
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    const diagnostics: string[] = [];
    fs.subscribe((event) => { if (event.diagnostic) diagnostics.push(`${event.diagnostic.code} ${event.path}`); });
    try {
      await writeFile(join(root, ".gitignore"), ".env\nbuild/\n# edited\n");
      await until(() => diagnostics.length > 0);
      expect(diagnostics).toEqual(["ignore-file-not-utf8 /docs/.arborignore"]);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });
});
