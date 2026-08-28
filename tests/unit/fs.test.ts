import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsConflictError, FsInjectedCrashError, WorkspaceFS } from "@arbor/fs";

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
  const fs = await WorkspaceFS.open(root, { stateDirectory: state, settleDelayMs: 20 });
  opened.push(fs);
  return { root, state, fs };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((fs) => fs[Symbol.asyncDispose]()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("@arbor/fs logical nodes", () => {
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
    expect((await fs.resolve("/duplicate")).diagnostics[0]?.code).toBe("duplicate-body-representation");
    expect((await fs.list("/")).filter((entry) => entry.path === "/sibling")).toHaveLength(1);
  });

  test("adding a child keeps the leaf body beside the new directory", async () => {
    const { root, fs } = await workspace({ "page.md": "Page body\n" });
    await fs.mutate({ operations: [{ op: "createMarkdown", path: "/page/child" }] });
    expect(await readFile(join(root, "page.md"), "utf8")).toBe("Page body\n");
    expect(await readFile(join(root, "page", "child.md"), "utf8")).toBe("");
    expect((await fs.resolve("/page")).kind).toBe("directory");
    expect((await fs.resolve("/page")).bodySource).toBe("sibling");
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

  test("moves and trashes both physical parts of a sibling-bodied directory", async () => {
    const { root, fs } = await workspace({ "page.md": "Page body\n", "page/child.md": "Child\n" });
    const renamed = await fs.mutate({ operations: [{ op: "rename", path: "/page", name: "renamed" }] });
    expect(renamed.moved).toEqual([{ from: "/page", to: "/renamed" }]);
    expect(await readFile(join(root, "renamed.md"), "utf8")).toContain("Page body\n");
    expect(await readFile(join(root, "renamed", "child.md"), "utf8")).toBe("Child\n");

    const trashed = await fs.mutate({ operations: [{ op: "trash", paths: ["/renamed"] }] });
    expect(trashed.deleted).toEqual(["/renamed"]);
    await expect(stat(join(root, "renamed.md"))).rejects.toThrow();
    expect(await readFile(join(root, "Trash", "renamed.md"), "utf8")).toContain("Page body\n");
    expect(await readFile(join(root, "Trash", "renamed", "child.md"), "utf8")).toBe("Child\n");
  });

  test("accepts exact directory Markdown and uses its first child link as the authored position", async () => {
    const { root: workspaceRoot, fs } = await workspace({ "a.md": "A\n", "b.md": "B\n", "_index.md": "Initial\n" });
    const root = await fs.read("/");
    const written = await fs.writeMarkdown("/", {
      baseRevision: root.byteRevision,
      source: "## One\n\n[b](b)\n\n## Two\n\n[a](a)\n",
    });
    expect(written.document?.source).toBe("## One\n\n[b](b)\n\n## Two\n\n[a](a)\n");
    expect(await readFile(join(workspaceRoot, "_index.md"), "utf8")).toBe("## One\n\n[b](b)\n\n## Two\n\n[a](a)\n");
  });

  test("directory revisions include exact index bytes and physical child add, rename, and removal", async () => {
    const { fs } = await workspace({ "a.md": "A\n", "_index.md": "[a](a)\n" });
    const current = await fs.read("/");
    await fs.mutate({ operations: [{ op: "createMarkdown", path: "/b", source: "B\n" }] });
    const afterChild = await fs.read("/");
    expect(afterChild.byteRevision).not.toBe(current.byteRevision);
    await expect(fs.writeMarkdown("/", { baseRevision: current.byteRevision, source: current.document!.source })).rejects.toBeInstanceOf(FsConflictError);

    await fs.mutate({ operations: [{ op: "rename", path: "/b", name: "renamed" }] });
    const afterRename = await fs.read("/");
    expect(afterRename.byteRevision).not.toBe(afterChild.byteRevision);
    await expect(fs.writeMarkdown("/", { baseRevision: afterChild.byteRevision, source: afterChild.document!.source })).rejects.toBeInstanceOf(FsConflictError);

    await fs.mutate({ operations: [{ op: "trash", paths: ["/renamed"] }] });
    const afterRemoval = await fs.read("/");
    expect(afterRemoval.byteRevision).not.toBe(afterRename.byteRevision);
    await expect(fs.writeMarkdown("/", { baseRevision: afterRename.byteRevision, source: afterRename.document!.source })).rejects.toBeInstanceOf(FsConflictError);
  });

  test("directory revision ignores filesystem enumeration order", async () => {
    const first = await workspace({ "b.md": "B\n", "a.md": "A\n" });
    const second = await workspace({ "a.md": "A\n", "b.md": "B\n" });
    expect((await first.fs.read("/")).byteRevision).toBe((await second.fs.read("/")).byteRevision);
  });

  test("rejects duplicate bodies, occupied destinations, and recursive moves", async () => {
    const { fs } = await workspace({
      "duplicate.md": "Sibling\n",
      "duplicate/_index.md": "Index\n",
      "destination/child.md": "Existing\n",
      "folder/child.md": "Child\n",
    });
    const duplicate = await fs.read("/duplicate");
    await expect(fs.writeMarkdown("/duplicate", { baseRevision: duplicate.byteRevision, source: "" })).rejects.toBeInstanceOf(FsConflictError);
    await expect(fs.mutate({ operations: [{ op: "move", paths: ["/folder/child"], destination: "/destination" }] })).rejects.toThrow("Destination already exists");
    await expect(fs.mutate({ operations: [{ op: "move", paths: ["/folder"], destination: "/folder" }] })).rejects.toThrow("itself");
    await expect(fs.mutate({ operations: [{ op: "createDirectory", path: "/schema.ts" }] })).rejects.toThrow("Invalid workspace name");
    await expect(fs.mutate({ operations: [{ op: "createDirectory", path: "/named.md" }] })).rejects.toThrow("do not include .md");
  });

  for (const [point, shouldExist] of [
    ["mutation:prepared", false],
    ["mutation:source-staged", true],
    ["mutation:destination-committed", true],
    ["mutation:committed", true],
  ] as const) {
    test(`recovers an injected crash at ${point}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "arbor-fs-crash-"));
      const state = await mkdtemp(join(tmpdir(), "arbor-fs-crash-state-"));
      directories.push(root, state);
      const crashing = await WorkspaceFS.open(root, {
        stateDirectory: state,
        faultInjector: (current) => { if (current === point) throw new Error("power loss"); },
      });
      await expect(crashing.mutate(
        { operations: [{ op: "createFile", path: "/created.txt", bytes: new TextEncoder().encode("complete") }] },
        { mutationID: `client-${point}` },
      )).rejects.toBeInstanceOf(FsInjectedCrashError);
      await crashing[Symbol.asyncDispose]();

      const recovered = await WorkspaceFS.open(root, { stateDirectory: state });
      opened.push(recovered);
      if (shouldExist) {
        expect(await readFile(join(root, "created.txt"), "utf8")).toBe("complete");
        expect(recovered.takeRecoveredMutationResults()).toMatchObject([{
          mutationID: `client-${point}`,
          result: { changes: [{ path: "/created.txt", kind: "created" }] },
        }]);
      }
      else await expect(stat(join(root, "created.txt"))).rejects.toThrow();
    });
  }

  test("rolls a structural move forward without rewriting authored directory Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-row-crash-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-row-crash-state-"));
    directories.push(root, state);
    await writeFile(join(root, "page.md"), "Page\n");
    await writeFile(join(root, "_index.md"), "[page](page)\n");
    await mkdir(join(root, "folder"));
    const crashing = await WorkspaceFS.open(root, {
      stateDirectory: state,
      faultInjector: (point) => { if (point === "mutation:destination-committed") throw new Error("power loss"); },
    });
    await expect(crashing.mutate({ operations: [{ op: "move", paths: ["/page"], destination: "/folder" }] })).rejects.toBeInstanceOf(FsInjectedCrashError);
    await crashing[Symbol.asyncDispose]();

    const recovered = await WorkspaceFS.open(root, { stateDirectory: state });
    opened.push(recovered);
    expect(await readFile(join(root, "folder", "page.md"), "utf8")).toContain("Page\n");
    expect((await recovered.read("/folder")).document?.blocks.some((block) => block.type === "standaloneLink" && block.content === "page")).toBe(false);
    expect((await recovered.list("/folder")).map((entry) => entry.path)).toContain("/folder/page");
    expect(await readFile(join(root, "_index.md"), "utf8")).toBe("[page](page)\n");
  });

  test("a move leaves authored links ordinary and does not materialize a destination index", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-natural-move-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-natural-move-state-"));
    directories.push(root, state);
    await writeFile(join(root, "page.md"), "Page\n");
    await writeFile(join(root, "_index.md"), "[page](page)\n");
    await mkdir(join(root, "folder"));
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    opened.push(fs);
    await fs.mutate({ operations: [{ op: "move", paths: ["/page"], destination: "/folder" }] });
    expect(await readFile(join(root, "folder", "page.md"), "utf8")).toContain("Page\n");
    expect(await readFile(join(root, "_index.md"), "utf8")).toBe("[page](page)\n");
    await expect(stat(join(root, "folder", "_index.md"))).rejects.toThrow();
  });

  test("a rename never materializes the provider-completed directory source", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-rename-complete-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-rename-complete-state-"));
    directories.push(root, state);
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "draft.md"), "Draft\n");
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    opened.push(fs);
    await fs.mutate({ operations: [{ op: "rename", path: "/folder/draft", name: "published" }] });
    expect(await readFile(join(root, "folder", "published.md"), "utf8")).toContain("Draft\n");
    await expect(stat(join(root, "folder", "_index.md"))).rejects.toThrow();
  });

  test("keeps missing child placement virtual across an exact-source write", async () => {
    const { root, fs } = await workspace({ "folder/_index.md": "Intro\n", "folder/b.md": "B\n", "folder/a.md": "A\n" });
    const projected = await fs.read("/folder");
    expect(projected.document?.source).toBe("Intro\n");
    expect((await fs.list("/folder")).map((entry) => entry.path).sort()).toEqual(["/folder/a", "/folder/b"]);
    expect(await readFile(join(root, "folder", "_index.md"), "utf8")).toBe("Intro\n");
    await fs.writeMarkdown("/folder", { baseRevision: projected.byteRevision, source: projected.document!.source });
    expect(await readFile(join(root, "folder", "_index.md"), "utf8")).toBe("Intro\n");
  });

  test("reasserts only unsettled authored stomps and observes settled rewrites", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-watch-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-watch-state-"));
    directories.push(root, state);
    await writeFile(join(root, "page.md"), "---\nid: abc123\n---\nInitial\n");
    const fs = await WorkspaceFS.open(root, { stateDirectory: state, settleDelayMs: 250 });
    opened.push(fs);
    const events: string[] = [];
    fs.subscribe((event) => { if (event.classification) events.push(event.classification); });

    const initial = await fs.read("/page");
    const first = await fs.writeMarkdown("/page", {
      baseRevision: initial.byteRevision,
      source: "---\nid: abc123\n---\nFirst\n",
    });
    await new Promise((resolve) => setTimeout(resolve, 320));
    const second = await fs.writeMarkdown("/page", {
      baseRevision: first.byteRevision,
      source: "---\nid: abc123\n---\nSecond\n",
    });
    await writeFile(join(root, "page.md"), first.bytes!);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(await readFile(join(root, "page.md"), "utf8")).toContain("Second");
    expect(events).toContain("stomp");

    await new Promise((resolve) => setTimeout(resolve, 320));
    await writeFile(join(root, "page.md"), first.bytes!);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(await readFile(join(root, "page.md"), "utf8")).toContain("First");
    expect(events.at(-1)).toBe("external");
    expect(second.byteRevision).not.toBe(first.byteRevision);
  });

  test("correlates an external Markdown rename by durable page ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-rename-watch-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-rename-watch-state-"));
    directories.push(root, state);
    await writeFile(join(root, "before.md"), "---\nid: abc123\n---\nBody\n");
    const fs = await WorkspaceFS.open(root, { stateDirectory: state, settleDelayMs: 30 });
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
