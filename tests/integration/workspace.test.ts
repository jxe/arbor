import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace, RevisionConflictError } from "@arbor/arbord";

let root: string;
let state: string;
let workspace: Workspace;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-workspace-"));
  state = await mkdtemp(join(tmpdir(), "arbor-state-"));
  process.env.ARBOR_DATA_HOME = state;
  await writeFile(join(root, "notes.md"), "---\ntitle: Notes\n---\n▸ Ideas\n  First\n");
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "child.md"), "Child body\n");
  workspace = await Workspace.open(root);
});

afterAll(async () => {
  await workspace[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("workspace service", () => {
  test("browses pages and directories", async () => {
    const rootNode = await workspace.node("/");
    expect(rootNode.children?.map((item) => item.name)).toContain("notes");
    const leaf = await workspace.node("/notes");
    expect(leaf.document?.blocks[0]?.type).toBe("toggle");
    expect((await workspace.node("/notes.md")).path).toBe("/notes");
  });

  test("mints an ID and enforces revision CAS", async () => {
    const node = await workspace.node("/notes");
    const blocks = node.document!.blocks;
    blocks[0]!.content = "Changed";
    const saved = await workspace.write("/notes", { baseRevision: node.revision, blocks });
    expect(saved.document?.frontmatter.id).toMatch(/^[a-z0-9]{6}$/);
    expect(await readFile(join(root, "notes.md"), "utf8")).toContain("▸ Changed");
    await expect(workspace.write("/notes", { baseRevision: node.revision, blocks })).rejects.toBeInstanceOf(RevisionConflictError);
  });

  test("materializes a directory page on first write", async () => {
    const node = await workspace.node("/folder");
    const blocks = [{ id: "new-block", type: "paragraph" as const, content: "About this folder", props: {}, children: [] }];
    await workspace.write("/folder", { baseRevision: node.revision, blocks });
    expect(await readFile(join(root, "folder", "_index.md"), "utf8")).toContain("About this folder");
    expect((await workspace.node("/folder/_index.md")).path).toBe("/folder");
  });

  test("soft deletes and restores", async () => {
    const deleted = await workspace.delete("/folder/child");
    expect(deleted.trashPath).toStartWith("/Trash/folder/child");
    await expect(stat(join(root, "folder", "child.md"))).rejects.toThrow();
    await mkdir(join(root, "folder", "child"));
    const restored = await workspace.restore(deleted.trashPath);
    expect(restored.path).toBe("/folder/child-2");
    expect(await readFile(join(root, "folder", "child-2.md"), "utf8")).toContain("Child body");
  });

  test("stores content-addressed assets", async () => {
    const asset = await workspace.addAsset("/folder", "picture.png", new TextEncoder().encode("image"));
    expect(asset.path).toMatch(/^\/Assets\/[a-f0-9]{16}\.png$/);
    expect(asset.markdownPath).toStartWith("../Assets/");
  });

  test("searches indexed content", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workspace.search("Changed").some((item) => item.path === "/notes")).toBe(true);
  });

  test("diagnoses and blocks duplicate leaf/directory representations", async () => {
    const duplicateRoot = await mkdtemp(join(tmpdir(), "arbor-duplicate-"));
    const duplicateState = await mkdtemp(join(tmpdir(), "arbor-duplicate-state-"));
    process.env.ARBOR_DATA_HOME = duplicateState;
    let duplicateWorkspace: Workspace | null = null;
    try {
      await writeFile(join(duplicateRoot, "same.md"), "Leaf\n");
      await mkdir(join(duplicateRoot, "same"));
      await writeFile(join(duplicateRoot, "same", "_index.md"), "Directory\n");
      duplicateWorkspace = await Workspace.open(duplicateRoot);
      const rootNode = await duplicateWorkspace.node("/");
      expect(rootNode.children?.filter((child) => child.path === "/same")).toHaveLength(1);
      expect(rootNode.diagnostics.some((item) => item.code === "duplicate-node-representation")).toBe(true);
      const same = await duplicateWorkspace.node("/same");
      await expect(duplicateWorkspace.write("/same", { baseRevision: same.revision, blocks: same.document?.blocks ?? [] })).rejects.toThrow("both a .md file");
    } finally {
      await duplicateWorkspace?.[Symbol.asyncDispose]();
      process.env.ARBOR_DATA_HOME = state;
      await rm(duplicateRoot, { recursive: true, force: true });
      await rm(duplicateState, { recursive: true, force: true });
    }
  });
});
