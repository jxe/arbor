import { nodeDocument, nodeKind } from "../helpers/node-snapshot.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Workspace } from "@overstory/arborsync";
import { canonicalStableKey } from "@overstory/protocol";

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
  await mkdir(join(root, ".claude", "worktrees"), { recursive: true });
  await writeFile(join(root, ".claude", "worktrees", "visible.md"), "Workspace discovery marker\n");
  await mkdir(join(root, ".build", "artifacts"), { recursive: true });
  await writeFile(join(root, ".build", "artifacts", "hidden.md"), "Generated build marker\n");
  workspace = await Workspace.open(root);
});

afterAll(async () => {
  await workspace[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("workspace service", () => {
  test("browses pages and directories", async () => {
    const rootNode = await workspace.editor.snapshot({ tree: workspace.tree, path: "/", stableKey: null });
    const rootChildren = await workspace.editor.children(rootNode.ref);
    expect(rootChildren.items.map((item) => item.name)).toContain("notes");
    expect(rootChildren.items.map((item) => item.name)).toContain(".claude");
    expect(rootChildren.items.map((item) => item.name)).not.toContain(".build");
    const leaf = await workspace.editor.snapshot({ tree: workspace.tree, path: "/notes", stableKey: null });
    expect(nodeDocument(leaf)?.blocks[0]?.type).toBe("toggle");
    expect((await workspace.editor.snapshot({ tree: workspace.tree, path: "/notes.md", stableKey: null })).ref.path).toBe("/notes");
  });

  test("keeps generated collection types in private workspace state", async () => {
    const declarationPath = workspace.editor.generatedTypeDeclarationPath();
    expect(relative(root, declarationPath).startsWith("..")).toBe(true);
    expect(await readFile(declarationPath, "utf8")).toContain('declare module "arbor/runtime"');
    await expect(stat(join(root, ".arbor"))).rejects.toThrow();

    const collection = join(root, "typed");
    const schemaPath = join(collection, "schema.ts");
    await mkdir(collection);
    await writeFile(schemaPath, 'import { z } from "zod"; export const schema = z.object({ title: z.string() });\n');
    await writeFile(join(collection, "_store.csv"), "title\nExample\n");
    await workspace.editor.generateTypes();

    const generated = await readFile(declarationPath, "utf8");
    const schemaImport = generated.match(/import type \{ schema as Schema0 \} from ("[^"]+");/);
    expect(schemaImport).not.toBeNull();
    expect(resolve(dirname(declarationPath), JSON.parse(schemaImport![1]!))).toBe(join(workspace.root, "typed", "schema.ts"));
    expect(generated).toContain('"/typed": Collection<z.infer<typeof Schema0>>;');
  });

  test("keeps Markdown collection rows out of the directory document", async () => {
    const collection = join(root, "records");
    await mkdir(collection);
    await writeFile(join(collection, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() });\n');
    await writeFile(join(collection, "_index.md"), "About the records.\n");
    await writeFile(join(collection, "one.md"), "---\nid: abc123\ntitle: One\n---\nRow body.\n");

    const node = await workspace.editor.snapshot({ tree: workspace.tree, path: "/records", stableKey: null });
    expect(nodeKind(node)).toBe("directory");
    expect(nodeDocument(node)?.source).toBe("About the records.\n");
    expect((await workspace.editor.children(node.ref)).items.some((child) => child.ref.path === "/records/one")).toBe(true);
    const snapshot = await workspace.editor.snapshot({ tree: workspace.tree, path: "/records", stableKey: null });
    expect(snapshot.capabilities.children?.schema).toStartWith("sha256:");
    const children = await workspace.editor.children(snapshot.ref);
    expect(children.items).toContainEqual(expect.objectContaining({
      ref: expect.objectContaining({ path: "/records/one", stableKey: '[["id","abc123"]]' }),
      properties: expect.objectContaining({ id: "abc123", title: "One" }),
    }));
    const key = canonicalStableKey([["id", "abc123"]]);
    const row = await workspace.editor.snapshot({ tree: workspace.tree, path: "/records/stale", stableKey: key });
    expect(row.ref.path).toBe("/records/one");
    expect(row.capabilities.properties?.writable).toBe(true);
    expect(row.capabilities.content?.writable).toBe(true);
    expect(nodeDocument(row)?.bodySource).toBe("Row body.\n");
  });

  test("resolves rolled-up JSON rows as ordinary stable-key nodes", async () => {
    const collection = join(root, "rolled");
    await mkdir(collection);
    await writeFile(join(collection, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(collection, "_store.json"), '[{"id":"b","title":"Second"},{"id":"a","title":"First"}]\n');

    const parent = await workspace.editor.snapshot({ tree: workspace.tree, path: "/rolled", stableKey: null });
    expect(parent.capabilities.children?.backing).toMatchObject({ type: "collection-file", format: "json" });
    expect(parent.capabilities.children?.writable).toBe(false);
    const children = await workspace.editor.children(parent.ref);
    expect(children.items.map((item) => item.ref.path)).toEqual(["/rolled/a", "/rolled/b"]);

    const key = canonicalStableKey([["id", "b"]]);
    const row = await workspace.editor.snapshot({ tree: workspace.tree, path: "/rolled/stale-name", stableKey: key });
    expect(row.ref).toEqual({ tree: workspace.tree, path: "/rolled/b", stableKey: key });
    expect(row.properties).toEqual({ id: "b", title: "Second" });
    expect(row.capabilities.content).toBeUndefined();
    expect(row.capabilities.properties?.writable).toBe(true);
  });

  test("resolves SQLite databases, tables, and rows as ordinary nodes", async () => {
    const directory = join(root, "database");
    await mkdir(directory);
    const schema = "create table items (id text primary key, title text not null);";
    await writeFile(join(directory, "schema.sql"), `${schema}\n`);
    await writeFile(join(directory, "relationships.json"), '{"version":1,"relationships":{}}\n');
    const database = new Database(join(directory, "_store.sqlite3"));
    database.exec(schema);
    database.query("insert into items values (?, ?), (?, ?)").run("b", "Second", "a", "First");
    database.close();

    const container = await workspace.editor.snapshot({ tree: workspace.tree, path: "/database", stableKey: null });
    expect(container.capabilities.children?.backing).toMatchObject({ type: "database", driver: "sqlite", scope: "subtree" });
    const tables = await workspace.editor.children(container.ref);
    expect(tables.items).toContainEqual(expect.objectContaining({
      ref: expect.objectContaining({ path: "/database/items", stableKey: null }),
      capabilities: expect.objectContaining({ children: expect.objectContaining({ total: 2 }) }),
    }));

    const table = await workspace.editor.snapshot({ tree: workspace.tree, path: "/database/items", stableKey: null });
    expect(table.capabilities.children?.backing).toMatchObject({ type: "database", driver: "sqlite", scope: "children" });
    const rows = await workspace.editor.children(table.ref);
    expect(rows.items.map((item) => item.ref.path)).toEqual(["/database/items/a", "/database/items/b"]);

    const key = canonicalStableKey([["id", "b"]]);
    const row = await workspace.editor.snapshot({ tree: workspace.tree, path: "/database/items/stale", stableKey: key });
    expect(row.ref).toEqual({ tree: workspace.tree, path: "/database/items/b", stableKey: key });
    expect(row.properties).toEqual({ id: "b", title: "Second" });
    expect(row.capabilities.properties?.writable).toBe(true);
  });

  test("reports body state and unambiguous child identity", async () => {
    const notes = await workspace.editor.snapshot({ tree: "local", path: "/notes", stableKey: null });
    expect(notes.content?.representation?.state).toBe("stored");
    expect(notes.content?.representation?.origin).toBe("sibling");
    expect(notes.ref.stableKey).toBeNull();

    await writeFile(join(root, "folder", "_index.md"), "About this folder\n");
    const materialized = await workspace.editor.snapshot({ tree: "local", path: "/folder", stableKey: null });
    expect(materialized.content?.representation?.state).toBe("stored");
    expect(materialized.content?.representation?.origin).toBe("index");

    await mkdir(join(root, "plain"));
    const implicit = await workspace.editor.snapshot({ tree: "local", path: "/plain", stableKey: null });
    expect(implicit.content?.representation?.state).toBe("implicit");
    expect(implicit.content?.representation?.origin).toBeUndefined();
    expect(nodeDocument(implicit)?.blocks).toEqual([]);

    const listing = await workspace.editor.children({ tree: "local", path: "/", stableKey: null });
    const child = listing.items.find((item) => item.ref.path === "/notes");
    expect(child?.ref.stableKey).toBeNull();
    expect(listing.items.find((item) => item.ref.path === "/plain")?.ref.stableKey).toBeNull();
  });

  test("uses a sibling Markdown body for a directory and prefers _index.md beside it", async () => {
    const duplicateRoot = await mkdtemp(join(tmpdir(), "arbor-duplicate-"));
    const duplicateState = await mkdtemp(join(tmpdir(), "arbor-duplicate-state-"));
    process.env.ARBOR_DATA_HOME = duplicateState;
    let duplicateWorkspace: Workspace | null = null;
    try {
      await writeFile(join(duplicateRoot, "same.md"), "Leaf\n");
      await mkdir(join(duplicateRoot, "same"));
      await writeFile(join(duplicateRoot, "same", "child.md"), "Child\n");
      duplicateWorkspace = await Workspace.open(duplicateRoot);
      const rootNode = await duplicateWorkspace.editor.snapshot({ tree: duplicateWorkspace.tree, path: "/", stableKey: null });
      expect((await duplicateWorkspace.editor.children(rootNode.ref)).items.filter((child) => child.ref.path === "/same")).toHaveLength(1);
      const same = await duplicateWorkspace.editor.snapshot({ tree: duplicateWorkspace.tree, path: "/same", stableKey: null });
      expect(nodeKind(same)).toBe("directory");
      expect(nodeDocument(same)?.bodySource).toBe("Leaf\n");
      await duplicateWorkspace[Symbol.asyncDispose]();
      duplicateWorkspace = null;

      await writeFile(join(duplicateRoot, "same", "_index.md"), "Directory\n");
      duplicateWorkspace = await Workspace.open(duplicateRoot);
      const duplicate = await duplicateWorkspace.editor.snapshot({ tree: duplicateWorkspace.tree, path: "/same", stableKey: null });
      expect(nodeDocument(duplicate)?.bodySource).toBe("Directory\n");
      expect(duplicate.diagnostics.some((item) => item.code === "shadowed-body")).toBe(true);
    } finally {
      await duplicateWorkspace?.[Symbol.asyncDispose]();
      process.env.ARBOR_DATA_HOME = state;
      await rm(duplicateRoot, { recursive: true, force: true });
      await rm(duplicateState, { recursive: true, force: true });
    }
  });
});
