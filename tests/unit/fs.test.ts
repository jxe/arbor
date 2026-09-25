import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceFS } from "@overstory/fs";

const opened: WorkspaceFS[] = [];
const directories: string[] = [];

async function workspace(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "arbor-fs-"));
  const state = await mkdtemp(join(tmpdir(), "arbor-fs-state-"));
  directories.push(root, state);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), source);
  }
  const fs = await WorkspaceFS.open(root, { stateDirectory: state });
  opened.push(fs);
  return { root, state, fs };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((fs) => fs[Symbol.asyncDispose]()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("@overstory/fs logical nodes", () => {
  test("resolves sibling bodies, index fallbacks, implicit bodies, and duplicate bodies", async () => {
    const { fs } = await workspace({
      "sibling.md": "Sibling\n",
      "sibling/child.md": "Child\n",
      "index/_index.md": "Index\n",
      "implicit/child.txt": "raw",
      "duplicate.md": "Sibling\n",
      "duplicate/_index.md": "Index\n",
    });

    expect((await fs.resolve("/sibling")).bodySource).toBe("sibling");
    expect(new TextDecoder().decode((await fs.read("/sibling")).bytes!)).toBe("Sibling\n");
    expect((await fs.resolve("/index")).bodySource).toBe("index");
    expect((await fs.resolve("/implicit")).bodyPath).toBeNull();
    expect((await fs.read("/implicit")).document?.bodySource).toBe("");
    expect((await fs.list("/implicit")).map((entry) => entry.path)).toEqual(["/implicit/child.txt"]);
    expect((await fs.resolve("/duplicate")).bodySource).toBe("index");
    expect(new TextDecoder().decode((await fs.read("/duplicate")).bytes!)).toBe("Index\n");
    expect((await fs.resolve("/duplicate")).diagnostics[0]?.code).toBe("shadowed-body");
    expect((await fs.list("/")).filter((entry) => entry.path === "/sibling")).toHaveLength(1);
  });

  test("keeps byte and parsed-body revisions separate", async () => {
    const { root, fs } = await workspace({ "page.md": "---\ntitle: One\n---\nSame body\n" });
    const before = await fs.read("/page");
    await writeFile(join(root, "page.md"), "---\ntitle: Two\n---\nSame body\n");
    const after = await fs.read("/page");
    expect(after.byteRevision).not.toBe(before.byteRevision);
    expect(after.bodyRevision).toBe(before.bodyRevision);
  });

  test("maps iCloud marker files to unavailable logical nodes without reading marker bytes", async () => {
    const { fs } = await workspace({
      ".offline.md.icloud": "provider marker, not Markdown content",
      ".photo.png.icloud": "provider marker, not image content",
    });
    const page = await fs.resolve("/offline");
    expect(page.kind).toBe("markdown");
    expect(page.materialization).toBe("placeholder");
    expect((await fs.read("/offline")).bytes).toBeNull();
    const file = await fs.resolve("/photo.png");
    expect(file.kind).toBe("file");
    expect(file.materialization).toBe("placeholder");
    expect((await fs.read("/photo.png")).bytes).toBeNull();
    expect((await fs.list("/")).map((entry) => entry.path)).toEqual(["/offline", "/photo.png"]);
  });

  test("directory revisions include exact index bytes and physical child add, rename, and removal", async () => {
    const { root, fs } = await workspace({ "a.md": "A\n", "_index.md": "[a](a)\n" });
    const current = await fs.read("/");
    await writeFile(join(root, "_index.md"), "[a](a) edited\n");
    const afterIndex = await fs.read("/");
    expect(afterIndex.byteRevision).not.toBe(current.byteRevision);

    await writeFile(join(root, "b.md"), "B\n");
    const afterChild = await fs.read("/");
    expect(afterChild.byteRevision).not.toBe(afterIndex.byteRevision);

    await rename(join(root, "b.md"), join(root, "renamed.md"));
    const afterRename = await fs.read("/");
    expect(afterRename.byteRevision).not.toBe(afterChild.byteRevision);

    await rm(join(root, "renamed.md"));
    const afterRemoval = await fs.read("/");
    expect(afterRemoval.byteRevision).not.toBe(afterRename.byteRevision);
  });

  test("directory revision ignores filesystem enumeration order", async () => {
    const first = await workspace({ "b.md": "B\n", "a.md": "A\n" });
    const second = await workspace({ "a.md": "A\n", "b.md": "B\n" });
    expect((await first.fs.read("/")).byteRevision).toBe((await second.fs.read("/")).byteRevision);
  });

  test("correlates an external Markdown rename by durable page ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-rename-watch-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-rename-watch-state-"));
    directories.push(root, state);
    await writeFile(join(root, "before.md"), "---\nid: abc123\n---\nBody\n");
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    opened.push(fs);
    const events: Array<{ type: string; path: string; previousPath?: string }> = [];
    fs.subscribe((event) => events.push(event));
    await rename(join(root, "before.md"), join(root, "after.md"));
    for (let attempt = 0; attempt < 20 && !events.some((event) => event.type === "moved"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const moved = events.find((event) => event.type === "moved");
    expect(moved?.path).toBe("/after");
    expect(moved?.previousPath).toBe("/before");
    expect(events.some((event) => event.type === "deleted" && event.path === "/before")).toBe(false);
  });
});
