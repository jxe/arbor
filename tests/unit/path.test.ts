import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalNodePath, directoryIndexTreePath, ensureContainedPath, siblingMarkdownTreePath, normalizeTreePath, nodePathFromPhysical, resolveTreePath } from "@arbor/core";

const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("workspace paths", () => {
  test("normalizes workspace paths", () => expect(normalizeTreePath("notes/today.md")).toBe("/notes/today.md"));
  test("canonicalizes leaf and directory-page representations to one node", () => {
    expect(canonicalNodePath("/notes/today.md")).toBe("/notes/today");
    expect(canonicalNodePath("/notes/today/_index.md")).toBe("/notes/today");
    expect(nodePathFromPhysical("/_index.md")).toBe("/");
    expect(siblingMarkdownTreePath("/notes/today")).toBe("/notes/today.md");
    expect(directoryIndexTreePath("/notes/today")).toBe("/notes/today/_index.md");
    expect(directoryIndexTreePath("/")).toBe("/_index.md");
  });
  test("rejects traversal", () => {
    expect(() => normalizeTreePath("../secret")).toThrow();
    expect(() => normalizeTreePath("%2e%2e/secret")).toThrow();
    expect(() => resolveTreePath("/tmp/root", "/../secret")).toThrow();
  });

  test("rejects a file reached through an external directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-path-root-")); temporaryPaths.push(root);
    const outside = await mkdtemp(join(tmpdir(), "arbor-path-outside-")); temporaryPaths.push(outside);
    await writeFile(join(outside, "secret.md"), "outside");
    await mkdir(join(root, "safe"));
    await symlink(outside, join(root, "safe", "external"));
    await expect(ensureContainedPath(root, "/safe/external/secret.md")).rejects.toThrow("Symlink leaves workspace");
  });
});
