import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverWorkspace, WorkspaceFS } from "@arbor/fs";

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
