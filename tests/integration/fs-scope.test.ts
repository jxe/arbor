import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { ArbordClient } from "@arbor/client";
import type { MutationRequest, NodeSnapshot } from "@arbor/core";

let outer: string;
let root: string;
let state: string;
let base: string;
let client: ArbordClient;
let close: () => Promise<void>;

beforeAll(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), "arbor-fs-scope-")));
  state = await mkdtemp(join(tmpdir(), "arbor-fs-scope-state-"));
  process.env.ARBOR_DATA_HOME = state;
  root = join(outer, "workspace");
  await mkdir(root);
  await writeFile(join(root, "inside.md"), "Inside the session root\n");
  await mkdir(join(root, "ordered"));
  await writeFile(join(root, "ordered", "_index.md"), "[First](first)\n\n[Second](second)\n");
  await writeFile(join(root, "ordered", "first.md"), "First\n");
  await writeFile(join(root, "ordered", "second.md"), "Second\n");
  await mkdir(join(outer, "stray"));
  await writeFile(join(outer, "stray", "note.md"), "Untracked note\n");
  await writeFile(join(outer, "stray", "photo.png"), new TextEncoder().encode("PNG"));
  await writeFile(join(outer, "stray", ".offline.txt.icloud"), "provider marker");
  await mkdir(join(outer, "stray", "ordered"));
  await writeFile(join(outer, "stray", "ordered", "_index.md"), "[First](first)\n\n[Second](second)\n");
  await writeFile(join(outer, "stray", "ordered", "first.md"), "First\n");
  await writeFile(join(outer, "stray", "ordered", "second.md"), "Second\n");
  await symlink(join(root, "inside.md"), join(outer, "stray", "link-into-root.md"));
  const running = await serveArbor(root, { port: 0 });
  base = running.url;
  client = new ArbordClient({ baseURL: base, retryDelay: async () => {} });
  close = async () => {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  };
});

afterAll(async () => {
  await close();
  await rm(outer, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("the local filesystem scope", () => {
  test("browses directories above the session root", async () => {
    const node = await client.node({ tree: "local", path: outer });
    expect(node.tree).toBe("local");
    expect(node.kind).toBe("directory");
    expect(node.enclosingTree).toBeUndefined();
    const children = await client.children({ tree: "local", path: outer });
    const names = children.items.map((item) => item.name);
    expect(names).toContain("stray");
    expect(names).toContain("workspace");
    expect(children.parent.tree).toBe("local");
  });

  test("reads and CAS-edits an untracked Markdown file with byte-identical no-op saves", async () => {
    const path = join(outer, "stray", "note");
    const node = await client.node({ tree: "local", path });
    expect(node.tree).toBe("local");
    expect(node.document?.bodySource).toBe("Untracked note\n");
    // No-op save round-trips byte-identically and mints no id.
    const noop: MutationRequest = {
      mutationID: "fs-noop-save",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: "local", path },
        baseContentRevision: node.contentRevision!,
        source: node.document!.source,
      }],
    };
    const receipt = await client.mutate(noop);
    expect(receipt.effects[0]?.tree).toBe("local");
    const after = await client.node({ tree: "local", path });
    expect(after.contentRevision).toBe(node.contentRevision);
    expect(after.document?.frontmatter.id).toBeUndefined();
    // Retry returns the same receipt; a mismatched reuse is rejected.
    expect(await client.mutate(noop)).toEqual(receipt);
    // Stale CAS surfaces as a revision conflict with the current snapshot.
    const stale: MutationRequest = {
      mutationID: "fs-stale-save",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: "local", path },
        baseContentRevision: "sha256:not-current",
        source: node.document!.source,
      }],
    };
    expect(client.mutate(stale)).rejects.toThrow();
  });

  test("exposes provider placeholders as unavailable logical files", async () => {
    const path = join(outer, "stray", "offline.txt");
    const placeholder = await client.node({ tree: "local", path });
    expect(placeholder.kind).toBe("file");
    expect(placeholder.materialization).toBe("placeholder");
    expect(placeholder.writable).toBe(false);
    const children = await client.children({ tree: "local", path: join(outer, "stray") });
    expect(children.items).toContainEqual(expect.objectContaining({
      name: "offline.txt",
      path,
      materialization: "placeholder",
    }));
    expect(await (await fetch(`${base}${path}`)).text()).not.toContain("provider marker");
  });

  test("canonicalizes an absolute path inside the launch workspace", async () => {
    const viaLocal = await client.node({ tree: "local", path: join(root, "inside") });
    expect(viaLocal.tree).not.toBe("local");
    expect(viaLocal.path).toBe("/inside");
    expect(viaLocal.enclosingTree).toMatchObject({
      placement: "local",
      legacy: true,
      osPath: root,
    });
  });

  test("uses WorkspaceFS authored ordering through an absolute browser path", async () => {
    const absolute = join(root, "ordered");
    const directory = await client.node({ tree: "local", path: absolute });
    expect(directory.tree).not.toBe("local");
    expect(directory.path).toBe("/ordered");
    const first = directory.document!.blocks.find((block) => block.type === "standaloneLink" && block.props?.path === "first");
    expect(first).toBeDefined();

    await client.mutateContent({
      op: "writeMarkdown",
      ref: { tree: directory.tree, path: "/ordered" },
      baseContentRevision: directory.contentRevision!,
      source: "[second](second)\n\n[first](first)\n\n",
    }, "workspace-absolute-authored-order");

    const reordered = await client.node({ tree: "local", path: absolute });
    expect(reordered.document!.blocks
      .filter((block) => block.type === "standaloneLink")
      .map((block) => block.props?.path)).toEqual(["second", "first"]);
  });

  test("canonicalizes a symlink from untracked space into the launch workspace", async () => {
    const viaLink = await client.node({ tree: "local", path: join(outer, "stray", "link-into-root") });
    expect(viaLink.tree).not.toBe("local");
    expect(viaLink.path).toBe("/inside");
    expect(viaLink.kind).toBe("markdown");
    expect(viaLink.enclosingTree).toMatchObject({ placement: "local", legacy: true, osPath: root });
  });

  test("uses the shared authored-order engine without minting identity in untracked space", async () => {
    const absolute = join(outer, "stray", "ordered");
    const directory = await client.node({ tree: "local", path: absolute });
    expect(directory.tree).toBe("local");
    expect(directory.document?.frontmatter.id).toBeUndefined();
    const first = directory.document!.blocks.find((block) => block.type === "standaloneLink" && block.props?.path === "first");
    expect(first).toBeDefined();

    await client.mutateContent({
      op: "writeMarkdown",
      ref: { tree: "local", path: absolute },
      baseContentRevision: directory.contentRevision!,
      source: "[second](second)\n\n[first](first)\n\n",
    }, "untracked-authored-order");

    const reordered = await client.node({ tree: "local", path: absolute });
    expect(reordered.document!.blocks
      .filter((block) => block.type === "standaloneLink")
      .map((block) => block.props?.path)).toEqual([
        "second",
        "first",
      ]);
    expect(await readFile(join(absolute, "_index.md"), "utf8")).not.toContain("id:");
  });

  test("refuses managed-workspace capabilities in untracked space", async () => {
    for (const url of [
      `${base}/v1/search?tree=local&q=note`,
      `${base}/v1/recovery?tree=local&path=${encodeURIComponent(join(outer, "stray"))}`,
    ]) {
      const response = await fetch(url);
      expect(response.status).toBe(422);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe("unsupported-operation");
      expect(body.message).toContain("managed workspace");
    }
    const trash: MutationRequest = {
      mutationID: "fs-trash-refused",
      operations: [{ op: "trash", refs: [{ tree: "local", path: join(outer, "stray", "note") }] }],
    };
    expect(client.mutate(trash)).rejects.toThrow();
  });

  test("rejects a cross-scope structural batch", async () => {
    const response = await fetch(`${base}/v1/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationID: "cross-scope-1",
        operations: [{
          op: "move",
          refs: [{ tree: "local", path: join(outer, "stray", "note") }],
          destination: { path: "/" },
        }],
      }),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { message: string }).message).toContain("one scope");
  });

  test("creates, renames, and moves untracked nodes with plain filesystem semantics", async () => {
    const dir = join(outer, "made");
    const created = await client.mutate({
      mutationID: "fs-create-1",
      operations: [
        { op: "createDirectory", tree: "local", path: dir },
        { op: "createMarkdown", tree: "local", path: join(dir, "draft") },
      ],
    });
    expect(created.effects.filter((effect) => effect.kind === "created").map((effect) => effect.path)).toEqual([
      dir,
      join(dir, "draft"),
    ]);
    const renamed = await client.mutate({
      mutationID: "fs-rename-1",
      operations: [{ op: "rename", ref: { tree: "local", path: join(dir, "draft") }, name: "final" }],
    });
    expect(renamed.effects[0]).toMatchObject({ kind: "moved", path: join(dir, "final"), tree: "local" });
    const listing = await client.children({ tree: "local", path: dir });
    expect(listing.items.map((item) => item.name)).toEqual(["final"]);
  });

  test("serves untracked file bytes at OS-shaped routes", async () => {
    const served = await fetch(`${base}${join(outer, "stray", "photo.png")}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(await served.text()).toBe("PNG");
  });

  test("completes an untracked directory in the same shape as a root-scope directory", async () => {
    const node = await client.node({ tree: "local", path: join(outer, "stray") }) as NodeSnapshot;
    expect(node.bodyState).toBe("implicit");
    expect(node.directoryRevision).toBeDefined();
    const children = await client.children({ tree: "local", path: join(outer, "stray") });
    const note = children.items.find((item) => item.name === "note");
    expect(note).toMatchObject({ kind: "markdown", path: join(outer, "stray", "note") });
  });
});
