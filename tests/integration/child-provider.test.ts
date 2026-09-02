import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Workspace } from "@arbor/arborsync";
import { canonicalStableKey } from "@arbor/core";

let root: string;
let state: string;
let workspace: Workspace;

const schema = 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-child-provider-"));
  state = await mkdtemp(join(tmpdir(), "arbor-child-provider-state-"));
  process.env.ARBOR_DATA_HOME = state;

  await mkdir(join(root, "expanded"));
  await writeFile(join(root, "expanded", "one.md"), "---\ntitle: One\n---\nExpanded body.\n");

  await mkdir(join(root, "markdown"));
  await writeFile(join(root, "markdown", "schema.ts"), schema);
  await writeFile(join(root, "markdown", "one.md"), "---\nid: one\ntitle: One\n---\nRecord body.\n");

  for (const name of ["csv", "json", "jsonl"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "schema.ts"), schema);
  }
  await writeFile(join(root, "csv", "_store.csv"), "id,title\none,One\n");
  await writeFile(join(root, "json", "_store.json"), '[{"id":"one","title":"One"}]\n');
  await writeFile(join(root, "jsonl", "_store.jsonl"), '{"id":"one","title":"One"}\n');

  await mkdir(join(root, "outer", "deep", "nested"), { recursive: true });
  await writeFile(join(root, "outer", "deep", "nested", "schema.ts"), schema);
  await writeFile(join(root, "outer", "deep", "nested", "_store.json"), '[{"id":"one","title":"One"}]\n');

  await mkdir(join(root, "mixed"));
  await writeFile(join(root, "mixed", "schema.ts"), schema);
  await writeFile(join(root, "mixed", "_store.json"), '[{"id":"collectionFile","title":"CollectionFile"}]\n');
  await writeFile(join(root, "mixed", "one.md"), "---\nid: physical\ntitle: Physical\n---\nBody.\n");

  await mkdir(join(root, "sqlite"));
  const sql = "create table items (id text primary key, title text not null);";
  await writeFile(join(root, "sqlite", "schema.sql"), `${sql}\n`);
  await writeFile(join(root, "sqlite", "relationships.json"), '{"version":1,"relationships":{}}\n');
  const database = new Database(join(root, "sqlite", "_store.sqlite3"));
  database.exec(sql);
  database.query("insert into items values (?, ?)").run("one", "One");
  database.close();

  workspace = await Workspace.open(root);
});

afterAll(async () => {
  await workspace?.[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("NodeProviderRouter conformance", () => {
  const cases = [
    { name: "expanded", parent: "/expanded", child: "/expanded/one", keyed: false, backing: { type: "expanded-files" } },
    { name: "Markdown records", parent: "/markdown", child: "/markdown/one", keyed: true, backing: { type: "expanded-files" } },
    { name: "CSV collection file", parent: "/csv", child: "/csv/one", keyed: true, backing: { type: "collection-file", format: "csv" } },
    { name: "JSON collection file", parent: "/json", child: "/json/one", keyed: true, backing: { type: "collection-file", format: "json" } },
    { name: "JSONL collection file", parent: "/jsonl", child: "/jsonl/one", keyed: true, backing: { type: "collection-file", format: "jsonl" } },
    { name: "nested JSON mount", parent: "/outer/deep/nested", child: "/outer/deep/nested/one", keyed: true, backing: { type: "collection-file", format: "json" } },
    { name: "SQLite table", parent: "/sqlite/items", child: "/sqlite/items/one", keyed: true, backing: { type: "database", driver: "sqlite", scope: "children" } },
  ] as const;

  for (const item of cases) {
    test(`${item.name} exposes the shared snapshot and child-page contract`, async () => {
      const parent = await workspace.snapshot({ tree: workspace.tree, path: item.parent, stableKey: null });
      expect(parent.capabilities.children?.backing).toMatchObject(item.backing);
      expect(parent.enclosingTree).toMatchObject({ id: workspace.tree, osPath: workspace.root });

      const page = await workspace.children(parent.ref);
      expect(page.parent.path).toBe(item.parent);
      expect(page.items).toHaveLength(1);
      const summary = page.items[0]!;
      expect(summary.ref.path).toBe(item.child);
      expect(summary.properties.title).toBe("One");
      expect(summary.capabilities.properties?.revision).toBe(summary.revision);

      const key = item.keyed ? canonicalStableKey([["id", "one"]]) : null;
      expect(summary.ref.stableKey).toBe(key);
      const snapshot = await workspace.snapshot({
        tree: workspace.tree,
        path: item.keyed ? `${item.parent}/stale-path` : item.child,
        stableKey: key,
      });
      expect(snapshot.ref).toEqual({ tree: workspace.tree, path: item.child, stableKey: key });
      expect(snapshot.properties.title).toBe("One");
      expect(snapshot.capabilities).toEqual(summary.capabilities);
      expect(snapshot.enclosingTree).toMatchObject({ id: workspace.tree, osPath: workspace.root });
    });
  }

  test("virtual table summaries remain NodeSummary values", async () => {
    const page = await workspace.children({ tree: workspace.tree, path: "/sqlite", stableKey: null });
    const table = page.items.find((item) => item.ref.path === "/sqlite/items");
    expect(table).toBeDefined();
    expect("observedThrough" in table!).toBe(false);
    expect("enclosingTree" in table!).toBe(false);
  });

  test("ambiguous provider claims stay physical and report the existing diagnostic", async () => {
    const parent = await workspace.snapshot({ tree: workspace.tree, path: "/mixed", stableKey: null });
    expect(parent.capabilities.children?.backing).toEqual({ type: "expanded-files" });
    expect(parent.diagnostics.some((item) => item.code === "mixed-collection-backing")).toBe(true);
    const page = await workspace.children(parent.ref);
    expect(page.items.some((item) => item.ref.path === "/mixed/one")).toBe(true);
    expect((await workspace.snapshot({ tree: workspace.tree, path: "/mixed/one", stableKey: null })).properties.title).toBe("Physical");
  });

  test("collection files mutate through one provider transaction contract", async () => {
    for (const name of ["csv", "json", "jsonl"] as const) {
      const key = canonicalStableKey([["id", "one"]]);
      const before = await workspace.snapshot({ tree: workspace.tree, path: `/${name}/stale`, stableKey: key });
      expect(before.capabilities.properties?.writable).toBe(true);
      await workspace.executeMutation({
        mutationID: `provider-${name}-write`,
        operations: [{
          op: "writeProperties",
          ref: before.ref,
          basePropertiesRevision: before.capabilities.properties!.revision,
          properties: { id: "one", title: `${name.toUpperCase()} changed` },
        }],
      });
      const after = await workspace.snapshot({ tree: workspace.tree, path: `/${name}/stale-again`, stableKey: key });
      expect(after.properties).toEqual({ id: "one", title: `${name.toUpperCase()} changed` });
    }
  });
});
