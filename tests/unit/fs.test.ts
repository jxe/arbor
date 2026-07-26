import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformStructuralRows, type ArborBlock } from "@arbor/core";
import { FsConflictError, FsInjectedCrashError, type FsMutation, WorkspaceFS } from "@arbor/fs";

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
    expect((await fs.resolve("/duplicate")).diagnostics[0]?.code).toBe("duplicate-body-representation");
    expect((await fs.list("/")).filter((entry) => entry.path === "/sibling")).toHaveLength(1);
  });

  test("adding a child keeps the leaf body beside the new directory", async () => {
    const { root, fs } = await workspace({ "page.md": "Page body\n" });
    await fs.mutate({ operations: [{ op: "createMarkdown", path: "/page/child" }] });
    expect(await readFile(join(root, "page.md"), "utf8")).toBe("Page body\n");
    expect(await readFile(join(root, "page", "child.md"), "utf8")).toContain("id:");
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

  test("moves managed rows between prose blocks without regrouping the other children", async () => {
    const { fs } = await workspace({ "a.md": "A\n", "b.md": "B\n", "_index.md": "Initial\n" });
    const root = await fs.read("/");
    const written = await fs.writeMarkdown("/", {
      baseRevision: root.byteRevision,
      blocks: [
        { id: "heading-one", type: "heading", content: "One", props: { level: 2 }, children: [] },
        { id: "heading-two", type: "heading", content: "Two", props: { level: 2 }, children: [] },
        { id: "child-a", type: "standaloneLink", content: "a", props: { path: "a" }, children: [] },
        { id: "child-b", type: "standaloneLink", content: "b", props: { path: "b" }, children: [] },
      ],
    });

    const headingTwoID = (await fs.read("/")).document!.blocks.find((block) => block.type === "heading" && block.content === "Two")!.id;
    await fs.mutate({ operations: [{
      op: "move",
      paths: ["/b"],
      destination: "/",
      beforeBlockId: headingTwoID,
      directoryRevision: written.byteRevision,
    }] });
    const blocks = (await fs.read("/")).document!.blocks;
    expect(blocks.map((block) => `${block.type}:${block.content}`)).toEqual([
      "heading:One",
      "standaloneLink:b",
      "heading:Two",
      "standaloneLink:a",
    ]);
  });

  test("rejects stale and missing structural insertion anchors", async () => {
    const { fs } = await workspace({ "a.md": "A\n", "b.md": "B\n", "_index.md": "[a](a)\n[b](b)\n" });
    const current = await fs.read("/");
    const anchored: FsMutation = { op: "move", paths: ["/b"], destination: "/", beforeBlockId: "missing" };

    await expect(fs.mutate({ operations: [anchored] })).rejects.toMatchObject({
      details: { code: "stale-revision" },
    });
    await expect(fs.mutate({ operations: [{ ...anchored, directoryRevision: "stale" }] })).rejects.toMatchObject({
      details: { code: "stale-revision" },
    });
    await expect(fs.mutate({ operations: [{ ...anchored, directoryRevision: current.byteRevision }] })).rejects.toMatchObject({
      details: { code: "missing-insertion-anchor" },
    });
  });

  test("uses the shared structural-row transform for nested prose placement", () => {
    const blocks: ArborBlock[] = [
      {
        id: "heading",
        type: "heading",
        content: "Section",
        props: { level: 2 },
        children: [{
          id: "anchor",
          type: "paragraph",
          content: "Anchor",
          props: {},
          children: [],
        }],
      },
      { id: "child-a", type: "standaloneLink", content: "a", props: { path: "a" }, children: [] },
      { id: "child-b", type: "standaloneLink", content: "b", props: { path: "b" }, children: [] },
    ];
    const transformed = transformStructuralRows(blocks, {
      directory: "/",
      removePaths: ["/b"],
      insertMoves: [{ oldPath: "/b", newPath: "/b" }],
      beforeBlockId: "anchor",
    });
    expect(transformed.anchor).toBe("found");
    expect(transformed.blocks[0]?.children.map((block) => block.id)).toEqual(["child-b", "anchor"]);
    expect(transformStructuralRows(blocks, {
      directory: "/",
      removePaths: ["/b"],
      insertMoves: [{ oldPath: "/b", newPath: "/b" }],
      beforeBlockId: "gone",
    }).anchor).toBe("missing");
  });

  test("rejects duplicate bodies, occupied destinations, and recursive moves", async () => {
    const { fs } = await workspace({
      "duplicate.md": "Sibling\n",
      "duplicate/_index.md": "Index\n",
      "destination/child.md": "Existing\n",
      "folder/child.md": "Child\n",
    });
    const duplicate = await fs.read("/duplicate");
    await expect(fs.writeMarkdown("/duplicate", { baseRevision: duplicate.byteRevision, blocks: [] })).rejects.toBeInstanceOf(FsConflictError);
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

  test("rolls a structural move and its directory rows forward together", async () => {
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
    await expect(crashing.mutate({ operations: [{ op: "move", paths: ["/page"], destination: "/folder", placement: "authored" }] })).rejects.toBeInstanceOf(FsInjectedCrashError);
    await crashing[Symbol.asyncDispose]();

    const recovered = await WorkspaceFS.open(root, { stateDirectory: state });
    opened.push(recovered);
    expect(await readFile(join(root, "folder", "page.md"), "utf8")).toContain("Page\n");
    expect((await recovered.read("/folder")).document?.blocks.some((block) => block.type === "standaloneLink" && block.content === "page")).toBe(true);
    expect(await readFile(join(root, "_index.md"), "utf8")).not.toContain("](page)");
  });

  test("a natural move strips source rows without materializing destination ordering", async () => {
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
    expect(await readFile(join(root, "_index.md"), "utf8")).not.toContain("](page)");
    await expect(stat(join(root, "folder", "_index.md"))).rejects.toThrow();
  });

  test("a rename never materializes a row for a previously synthetic child", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-rename-synthetic-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-rename-synthetic-state-"));
    directories.push(root, state);
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "draft.md"), "Draft\n");
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    opened.push(fs);
    await fs.mutate({ operations: [{ op: "rename", path: "/folder/draft", name: "published" }] });
    expect(await readFile(join(root, "folder", "published.md"), "utf8")).toContain("Draft\n");
    await expect(stat(join(root, "folder", "_index.md"))).rejects.toThrow();
  });

  test("anchoring before a synthetic child materializes the anchor row too", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-fs-anchor-synth-"));
    const state = await mkdtemp(join(tmpdir(), "arbor-fs-anchor-synth-state-"));
    directories.push(root, state);
    await writeFile(join(root, "page.md"), "Page\n");
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "existing.md"), "Existing\n");
    const fs = await WorkspaceFS.open(root, { stateDirectory: state });
    opened.push(fs);
    const revision = (await fs.read("/folder")).byteRevision;
    await fs.mutate({ operations: [{
      op: "move",
      paths: ["/page"],
      destination: "/folder",
      beforePath: "/folder/existing",
      directoryRevision: revision,
    }] });
    const body = await readFile(join(root, "folder", "_index.md"), "utf8");
    expect(body.indexOf("](page)")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("](existing)")).toBeGreaterThan(body.indexOf("](page)"));
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
      blocks: [{ id: "first", type: "paragraph", content: "First", props: {}, children: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 320));
    const second = await fs.writeMarkdown("/page", {
      baseRevision: first.byteRevision,
      blocks: [{ id: "second", type: "paragraph", content: "Second", props: {}, children: [] }],
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
