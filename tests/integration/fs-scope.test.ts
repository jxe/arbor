import { nodeDocument, nodeKind } from "../helpers/node-snapshot.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { serveArborSync } from "@arbor/arborsync";
import { ArborSyncRESTClient } from "@arbor/client";
import type { MutationRequest, NodeSnapshot } from "@arbor/core";
import { canonicalStableKey } from "@arbor/core";

let outer: string;
let root: string;
let state: string;
let base: string;
let client: ArborSyncRESTClient;
let close: () => Promise<void>;
let scope: string;

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
  await mkdir(join(outer, "stray", "rolled"));
  await writeFile(join(outer, "stray", "rolled", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(outer, "stray", "rolled", "_store.json"), '[{"id":"one","title":"One"}]\n');
  await mkdir(join(outer, "stray", "records"));
  await writeFile(join(outer, "stray", "records", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ slug: z.string(), title: z.string() }); export const primaryKey = ["slug"] as const;\n');
  await writeFile(join(outer, "stray", "records", "one.md"), '---\nslug: one\ntitle: One\n---\nRecord body.\n');
  await mkdir(join(outer, "stray", "database"));
  const sqlite = new Database(join(outer, "stray", "database", "_store.sqlite3"));
  sqlite.exec("create table items (id text primary key, title text not null); insert into items values ('one', 'One')");
  sqlite.close();
  await mkdir(join(outer, "implicit-edit"));
  await writeFile(join(outer, "implicit-edit", "child.md"), "Child\n");
  await symlink(join(root, "inside.md"), join(outer, "stray", "link-into-root.md"));
  const running = await serveArborSync(root, { port: 0 });
  base = running.url;
  client = new ArborSyncRESTClient({ baseURL: base, retryDelay: async () => {} });
  scope = running.workspace.tree;
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
    const node = await client.node({ tree: "local", path: outer, stableKey: null });
    expect(node.ref.tree).toBe("local");
    expect(nodeKind(node)).toBe("directory");
    expect(node.enclosingTree).toBeUndefined();
    const children = await client.children({ tree: "local", path: outer, stableKey: null });
    const names = children.items.map((item) => item.name);
    expect(names).toContain("stray");
    expect(names).toContain("workspace");
    expect(children.parent.tree).toBe("local");
  });

  test("reads and CAS-edits an untracked Markdown file with byte-identical no-op saves", async () => {
    const path = join(outer, "stray", "note");
    const node = await client.node({ tree: "local", path, stableKey: null });
    expect(node.ref.tree).toBe("local");
    expect(nodeDocument(node)?.bodySource).toBe("Untracked note\n");
    // No-op save round-trips byte-identically and mints no id.
    const noop: MutationRequest = {
      mutationID: "fs-noop-save",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: "local", path, stableKey: null },
        baseContentRevision: node.capabilities.content?.revision!,
        source: nodeDocument(node)!.source,
      }],
    };
    const receipt = await client.mutate(noop);
    expect(receipt.effects[0]?.tree).toBe("local");
    const after = await client.node({ tree: "local", path, stableKey: null });
    expect(after.capabilities.content?.revision).toBe(node.capabilities.content?.revision);
    expect(nodeDocument(after)?.frontmatter.id).toBeUndefined();
    // Retry returns the same receipt; a mismatched reuse is rejected.
    expect(await client.mutate(noop)).toEqual(receipt);
    // Stale CAS surfaces as a revision conflict with the current snapshot.
    const stale: MutationRequest = {
      mutationID: "fs-stale-save",
      operations: [{
        op: "writeMarkdown",
        ref: { tree: "local", path, stableKey: null },
        baseContentRevision: "sha256:not-current",
        source: nodeDocument(node)!.source,
      }],
    };
    expect(client.mutate(stale)).rejects.toThrow();
  });

  test("exposes provider placeholders as unavailable logical files", async () => {
    const path = join(outer, "stray", "offline.txt");
    const placeholder = await client.node({ tree: "local", path, stableKey: null });
    expect(nodeKind(placeholder)).toBe("file");
    expect(placeholder.materialization).toBe("placeholder");
    expect(placeholder.capabilities.content?.writable).toBe(false);
    const children = await client.children({ tree: "local", path: join(outer, "stray"), stableKey: null });
    expect(children.items).toContainEqual(expect.objectContaining({
      name: "offline.txt",
      ref: expect.objectContaining({ path }),
      materialization: "placeholder",
    }));
    expect(await (await fetch(`${base}${path}`)).text()).not.toContain("provider marker");
  });

  test("canonicalizes an absolute path inside the launch workspace", async () => {
    const viaLocal = await client.node({ tree: "local", path: join(root, "inside"), stableKey: null });
    expect(viaLocal.ref.tree).not.toBe("local");
    expect(viaLocal.ref.path).toBe("/inside");
    expect(viaLocal.enclosingTree).toMatchObject({
      placement: "placed",
      access: "write",
      osPath: root,
    });
  });

  test("browses untracked SQLite tables and stable rows through ordinary nodes", async () => {
    const databasePath = join(outer, "stray", "database");
    const container = await client.node({ tree: "local", path: databasePath, stableKey: null });
    expect(container.capabilities.children?.representation).toMatchObject({ type: "rollup", codec: "sqlite", scope: "subtree" });
    const tables = await client.children(container.ref);
    const tableRef = tables.items.find((item) => item.ref.path === join(databasePath, "items"))?.ref;
    expect(tableRef).toBeDefined();
    const rows = await client.children(tableRef!);
    expect(rows.items[0]).toMatchObject({
      ref: { tree: "local", path: join(databasePath, "items", "one"), stableKey: canonicalStableKey([["id", "one"]]) },
      properties: { id: "one", title: "One" },
    });
    const healed = await client.node({
      tree: "local",
      path: join(databasePath, "items", "stale"),
      stableKey: canonicalStableKey([["id", "one"]]),
    });
    expect(healed.ref.path).toBe(join(databasePath, "items", "one"));
  });

  test("directly edits untracked Markdown and stable SQLite properties", async () => {
    const markdownPath = join(outer, "stray", "note");
    const markdown = await client.node({ tree: "local", path: markdownPath, stableKey: null });
    const markdownReceipt = await client.writeProperties(
      markdown.ref,
      markdown.capabilities.properties!.revision,
      { title: "Untracked title", optional: null },
      "untracked-properties-1",
    );
    expect(markdownReceipt.effects[0]?.propertiesRevision).toMatch(/^sha256:/);
    const savedMarkdown = await client.node(markdown.ref);
    expect(savedMarkdown.properties).toEqual({ title: "Untracked title", optional: null });
    expect(nodeDocument(savedMarkdown)?.bodySource).toBe("Untracked note\n");

    const databasePath = join(outer, "stray", "database");
    const rows = await client.children({ tree: "local", path: join(databasePath, "items"), stableKey: null });
    const row = rows.items[0]!;
    expect(row.capabilities.properties?.writable).toBe(true);
    const request = {
      ref: row.ref,
      revision: row.capabilities.properties!.revision,
      properties: { id: "one", title: "One updated" },
    } as const;
    const first = await client.writeProperties(request.ref, request.revision, request.properties, "untracked-row-properties-1");
    expect(await client.writeProperties(request.ref, request.revision, request.properties, "untracked-row-properties-1")).toEqual(first);
    const savedRow = await client.node({ ...row.ref, path: join(databasePath, "items", "stale-again") });
    expect(savedRow.properties).toEqual(request.properties);
    expect(savedRow.capabilities.properties?.revision).toBe(first.effects[0]?.propertiesRevision);

    await expect(client.writeProperties(
      row.ref,
      savedRow.capabilities.properties!.revision,
      { id: "renamed", title: "No" },
      "untracked-row-properties-identity",
    )).rejects.toThrow("immutable");
  });

  test("uses WorkspaceFS authored ordering through an absolute browser path", async () => {
    const absolute = join(root, "ordered");
    const directory = await client.node({ tree: "local", path: absolute, stableKey: null });
    expect(directory.ref.tree).not.toBe("local");
    expect(directory.ref.path).toBe("/ordered");
    const first = nodeDocument(directory)!.blocks.find((block) => block.type === "standaloneLink" && block.props?.path === "first");
    expect(first).toBeDefined();

    await client.mutateContent({
      op: "writeMarkdown",
      ref: { tree: directory.ref.tree, path: "/ordered", stableKey: null },
      baseContentRevision: directory.capabilities.content?.revision!,
      source: "[second](second)\n\n[first](first)\n\n",
    }, "workspace-absolute-authored-order");

    const reordered = await client.node({ tree: "local", path: absolute, stableKey: null });
    expect(nodeDocument(reordered)!.blocks
      .filter((block) => block.type === "standaloneLink")
      .map((block) => block.props?.path)).toEqual(["second", "first"]);
  });

  test("canonicalizes a symlink from untracked space into the launch workspace", async () => {
    const viaLink = await client.node({ tree: "local", path: join(outer, "stray", "link-into-root"), stableKey: null });
    expect(viaLink.ref.tree).not.toBe("local");
    expect(viaLink.ref.path).toBe("/inside");
    expect(nodeKind(viaLink)).toBe("markdown");
    expect(viaLink.enclosingTree).toMatchObject({ placement: "placed", access: "write", osPath: root });
  });

  test("uses the shared authored-order engine without minting identity in untracked space", async () => {
    const absolute = join(outer, "stray", "ordered");
    const directory = await client.node({ tree: "local", path: absolute, stableKey: null });
    expect(directory.ref.tree).toBe("local");
    expect(nodeDocument(directory)?.frontmatter.id).toBeUndefined();
    const first = nodeDocument(directory)!.blocks.find((block) => block.type === "standaloneLink" && block.props?.path === "first");
    expect(first).toBeDefined();

    await client.mutateContent({
      op: "writeMarkdown",
      ref: { tree: "local", path: absolute, stableKey: null },
      baseContentRevision: directory.capabilities.content?.revision!,
      source: "[second](second)\n\n[first](first)\n\n",
    }, "untracked-authored-order");

    const reordered = await client.node({ tree: "local", path: absolute, stableKey: null });
    expect(nodeDocument(reordered)!.blocks
      .filter((block) => block.type === "standaloneLink")
      .map((block) => block.props?.path)).toEqual([
        "second",
        "first",
      ]);
    expect(await readFile(join(absolute, "_index.md"), "utf8")).not.toContain("id:");
  });

  test("resolves and exactly edits stable rolled-up rows outside a managed workspace", async () => {
    const collection = join(outer, "stray", "rolled");
    const children = await client.children({ tree: "local", path: collection, stableKey: null });
    expect(children.items).toHaveLength(1);
    const key = canonicalStableKey([["id", "one"]]);
    expect(children.items[0]?.ref).toEqual({ tree: "local", path: join(collection, "one"), stableKey: key });

    const row = await client.node({ tree: "local", path: join(collection, "old-name"), stableKey: key });
    expect(row.ref.path).toBe(join(collection, "one"));
    expect(row.properties).toEqual({ id: "one", title: "One" });
    expect(row.capabilities.properties?.writable).toBe(true);
    const receipt = await client.writeProperties(
      row.ref,
      row.capabilities.properties!.revision,
      { id: "one", title: "Changed" },
      "untracked-json-properties",
    );
    expect(await client.writeProperties(
      row.ref,
      row.capabilities.properties!.revision,
      { id: "one", title: "Changed" },
      "untracked-json-properties",
    )).toEqual(receipt);
    expect(await readFile(join(collection, "_store.json"), "utf8"))
      .toBe('[{"id":"one","title":"Changed"}]\n');
    expect((await client.node({ tree: "local", path: join(collection, "stale-again"), stableKey: key })).properties)
      .toEqual({ id: "one", title: "Changed" });
  });

  test("treats untracked Markdown records as identity-safe writable nodes", async () => {
    const collection = join(outer, "stray", "records");
    const key = canonicalStableKey([["slug", "one"]]);
    const row = await client.node({ tree: "local", path: join(collection, "stale"), stableKey: key });
    expect(row.ref.path).toBe(join(collection, "one"));
    expect(row.capabilities.properties?.writable).toBe(true);
    expect(row.capabilities.content?.writable).toBe(true);
    expect(nodeDocument(row)?.bodySource).toBe("Record body.\n");

    await client.writeProperties(
      { tree: "local", path: join(collection, "one"), stableKey: null },
      row.capabilities.properties!.revision,
      { slug: "one", title: "Updated" },
      "untracked-markdown-properties",
    );
    const updated = await client.node({ tree: "local", path: join(collection, "one"), stableKey: key });
    expect(updated.properties).toEqual({ slug: "one", title: "Updated" });
    expect(nodeDocument(updated)?.bodySource).toBe("Record body.\n");

    await expect(client.writeProperties(
      { tree: "local", path: join(collection, "one"), stableKey: null },
      updated.capabilities.properties!.revision,
      { slug: "different", title: "Updated" },
      "untracked-markdown-identity-change",
    )).rejects.toThrow("immutable");

    const changed = nodeDocument(updated)!.source.replace("Record body.", "Changed body.");
    await client.mutateContent({
      op: "writeMarkdown",
      ref: { tree: "local", path: join(collection, "stale"), stableKey: key },
      baseContentRevision: updated.capabilities.content!.revision,
      source: changed,
    }, "untracked-markdown-content");
    expect(nodeDocument(await client.node({ tree: "local", path: join(collection, "one"), stableKey: key }))?.bodySource)
      .toBe("Changed body.\n");
  });

  test("materializes an implicit untracked directory only after an authored edit", async () => {
    const absolute = join(outer, "implicit-edit");
    const before = await client.node({ tree: "local", path: absolute, stableKey: null });
    expect(before.content?.representation?.state).toBe("implicit");
    expect(before.ref.stableKey).toBeNull();
    await expect(readFile(join(absolute, "_index.md"), "utf8")).rejects.toThrow();

    const source = `${nodeDocument(before)!.source}\nAuthored directory note.\n`;
    await client.mutateContent({
      op: "writeMarkdown",
      ref: { tree: "local", path: absolute, stableKey: null },
      baseContentRevision: before.capabilities.content?.revision!,
      source,
    }, "untracked-implicit-directory-edit");

    expect(await readFile(join(absolute, "_index.md"), "utf8")).toBe(source);
    const after = await client.node({ tree: "local", path: absolute, stableKey: null });
    expect(after.content?.representation?.state).toBe("stored");
    expect(after.ref.stableKey).toBeNull();
    expect(nodeDocument(after)?.frontmatter.id).toBeUndefined();
  });

  test("refuses managed-workspace capabilities in untracked space", async () => {
    for (const url of [
      `${base}/v1/search?tree=local&q=note`,
      `${base}/v1/recovery?tree=local&path=${encodeURIComponent(join(outer, "stray"))}&stableKey=`,
    ]) {
      const response = await fetch(url);
      expect(response.status).toBe(422);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe("unsupported-operation");
      expect(body.message).toContain("managed workspace");
    }
    const trash: MutationRequest = {
      mutationID: "fs-trash-refused",
      operations: [{ op: "trash", refs: [{ tree: "local", path: join(outer, "stray", "note"), stableKey: null }] }],
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
          refs: [{ tree: "local", path: join(outer, "stray", "note"), stableKey: null }],
          destination: { tree: scope, path: "/", stableKey: null },
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
      operations: [{ op: "rename", ref: { tree: "local", path: join(dir, "draft"), stableKey: null }, name: "final" }],
    });
    expect(renamed.effects[0]).toMatchObject({ kind: "moved", path: join(dir, "final"), tree: "local" });
    const listing = await client.children({ tree: "local", path: dir, stableKey: null });
    expect(listing.items.map((item) => item.name)).toEqual(["final"]);
  });

  test("serves untracked file bytes at OS-shaped routes", async () => {
    const served = await fetch(`${base}${join(outer, "stray", "photo.png")}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(await served.text()).toBe("PNG");
  });

  test("completes an untracked directory in the same shape as a root-scope directory", async () => {
    const node = await client.node({ tree: "local", path: join(outer, "stray"), stableKey: null }) as NodeSnapshot;
    expect(node.content?.representation?.state).toBe("implicit");
    expect(node.capabilities.children?.revision).toBeDefined();
    const children = await client.children({ tree: "local", path: join(outer, "stray"), stableKey: null });
    const note = children.items.find((item) => item.name === "note");
    expect(note).toMatchObject({
      ref: { tree: "local", path: join(outer, "stray", "note"), stableKey: null },
      capabilities: { content: { format: "markdown" } },
    });
  });
});
