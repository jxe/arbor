import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalStableKey } from "../../../protocol/src/index.ts";
import { ProjectionProviderHost } from "../../../arborsync/src/state/index.ts";
import { convertTrees, rollback } from "./run.ts";

let root: string;
let tree: string;
const legacy = (body: string) => `import { z } from "zod";\n${body}\n`;
const FIXTURES: Record<string, Record<string, string>> = {
  csv: {
    "schema.ts": legacy('export const schema = z.object({ id: z.string(), title: z.string(), count: z.coerce.number() });\nexport const primaryKey = ["id"] as const;'),
    "_store.csv": "id,title,count\n001,One,1\n002,Two,2.5\n",
  },
  named: {
    "schema.ts": legacy('export const schema = z.object({ id: z.string(), slug: z.string(), tags: z.array(z.string()), rank: z.number().int().min(0), note: z.string().nullable() });\nexport const primaryKey = ["id"] as const;\nexport const childName = { from: "property", property: "slug" } as const;'),
    "_store.json": '[{"id":"a","slug":"first","tags":["x"],"rank":1,"note":null}]\n',
  },
  markdown: {
    "schema.ts": legacy('export const schema = z.object({ id: z.string(), status: z.enum(["draft", "done"]) });'),
    "one.md": "---\nid: one\nstatus: draft\n---\nBody\n",
  },
  transform: {
    "schema.ts": legacy('export const schema = z.object({ id: z.string().transform((value) => value.trim()) });\nexport const primaryKey = ["id"] as const;'),
    "_store.jsonl": '{"id":" a "}\n',
  },
  stripped: {
    "schema.ts": legacy('export const schema = z.object({ id: z.string() });\nexport const primaryKey = ["id"] as const;'),
    "_store.json": '[{"id":"a","extra":true}]\n',
  },
  "empty-optional-csv": {
    "schema.ts": legacy('export const schema = z.object({ id: z.string(), note: z.string().optional() });\nexport const primaryKey = ["id"] as const;'),
    "_store.csv": "id,note\na,\n",
  },
};

async function listing(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (path: string, prefix: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name), `${prefix}${entry.name}/`);
      else result[`${prefix}${entry.name}`] = await readFile(join(path, entry.name), "utf8");
    }
  };
  await walk(directory, "");
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-migration-021-"));
  tree = join(root, "tree");
  for (const [name, files] of Object.entries(FIXTURES)) {
    await mkdir(join(tree, name), { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(join(tree, name, file), text);
  }
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const status = (report: Awaited<ReturnType<typeof convertTrees>>) =>
  Object.fromEntries(report.collections.map((item) => [item.directory.slice(tree.length + 1), item.status]));

test("dry run reports every collection and changes nothing", async () => {
  const before = await listing(tree);
  const report = await convertTrees([tree], { dryRun: true });
  expect(status(report)).toEqual({
    csv: "would-convert", named: "would-convert", markdown: "would-convert",
    transform: "blocked", stripped: "blocked", "empty-optional-csv": "blocked",
  });
  const blockers = Object.fromEntries(report.collections.map((item) => [item.directory.slice(tree.length + 1), item.blockers.join("; ")]));
  expect(blockers.transform).toContain(".transform()");
  expect(blockers.stripped).toContain("valid under schema.ts but invalid under schema.cddl");
  expect(blockers["empty-optional-csv"]).toContain("changes properties");
  expect(await listing(tree)).toEqual(before);
});

test("conversion preserves identities, is repeatable, resumes an interruption, and rolls back exactly", async () => {
  const before = await listing(tree);
  const providers = new ProjectionProviderHost();
  const backup = join(root, "backup");
  const report = await convertTrees([tree], { dryRun: false, backup });
  expect(status(report)).toMatchObject({ csv: "converted", named: "converted", markdown: "converted", transform: "blocked" });
  const after = await listing(tree);
  expect(after["csv/schema.ts"]).toBeUndefined();
  expect(after["csv/_store.csv"]).toBe(before["csv/_store.csv"]);
  expect(after["transform/schema.ts"]).toBe(before["transform/schema.ts"]);
  expect(after["named/schema.cddl"]).toContain('overstory-child-name = "slug"');
  expect(after["named/schema.cddl"]).toContain("tags: [* tstr]");

  // The converted collections read with the same keys, names and values schema.ts produced.
  const children = async (name: string) => (await (await providers.open(join(tree, name)))!.children(
    `/${name}`, { tree: "tr_test", path: `/${name}`, stableKey: null }, { tree: "tr_test", observedThrough: "test:0", writable: false }, null,
  )).items.map((item) => [item.ref.path, item.ref.stableKey, item.properties]);
  expect(await children("csv")).toEqual([
    ["/csv/001", canonicalStableKey([["id", "001"]]), { id: "001", title: "One", count: 1 }],
    ["/csv/002", canonicalStableKey([["id", "002"]]), { id: "002", title: "Two", count: 2.5 }],
  ]);
  expect(await children("named")).toEqual([["/named/first", canonicalStableKey([["id", "a"]]), { id: "a", slug: "first", tags: ["x"], rank: 1, note: null }]]);
  expect(await providers.collectionFileDescriptor(join(tree, "csv"), "_store.csv")).toMatchObject({ format: "csv" });

  // Repeating the run changes nothing.
  const repeated = await convertTrees([tree], { dryRun: false, backup });
  expect(status(repeated)).toMatchObject({ csv: "already-converted", named: "already-converted", markdown: "already-converted" });
  expect(await listing(tree)).toEqual(after);

  // An interruption after schema.cddl was written leaves both files; the next run finishes it.
  await cp(join(tree, "csv"), join(tree, "interrupted"), { recursive: true });
  await writeFile(join(tree, "interrupted", "schema.ts"), before["csv/schema.ts"]!);
  const resumed = await convertTrees([join(tree, "interrupted")], { dryRun: false, backup: join(root, "backup-interrupted") });
  expect(status(resumed)).toEqual({ interrupted: "resumed" });
  expect((await listing(join(tree, "interrupted")))["schema.ts"]).toBeUndefined();
  // A schema.cddl that differs from the translation is an ambiguity, never overwritten.
  await writeFile(join(tree, "interrupted", "schema.ts"), before["csv/schema.ts"]!);
  await writeFile(join(tree, "interrupted", "schema.cddl"), "overstory-schema-version = 1\nrow = { id: tstr }\n");
  expect(status(await convertTrees([join(tree, "interrupted")], { dryRun: false, backup: join(root, "backup-interrupted") }))).toEqual({ interrupted: "blocked" });
  await rm(join(tree, "interrupted"), { recursive: true });

  // Matched-version rollback restores the exact schema.ts bytes and removes schema.cddl.
  const restored = await rollback(backup);
  expect(restored.filter((item) => item.restored).length).toBe(restored.length);
  expect(await listing(tree)).toEqual(before);
  expect((await rollback(backup)).every((item) => item.restored)).toBe(true);
  await providers[Symbol.asyncDispose]();
});
