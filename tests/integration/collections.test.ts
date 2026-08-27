import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalStableKey } from "@arbor/core";
import { CollectionStore, detectCollection } from "@arbor/stores";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-collections-"));
  await mkdir(join(root, "csv"));
  await writeFile(join(root, "csv", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string(), count: z.coerce.number() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "csv", "_store.csv"), "id,title,count\none,One,1\ntwo,Two,nope\n");
  await mkdir(join(root, "jsonl"));
  await writeFile(join(root, "jsonl", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "jsonl", "_store.jsonl"), '{"id":"one","title":"One"}\nnot json\n{"id":"three","title":"Three"}\n');
  await mkdir(join(root, "json"));
  await writeFile(join(root, "json", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
  await writeFile(join(root, "json", "_store.json"), '[{"id":"b","title":"Second"},{"id":"a","title":"First"}]\n');
  await mkdir(join(root, "markdown"));
  await writeFile(join(root, "markdown", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string(), status: z.enum(["draft", "done"]) });\n');
  await writeFile(join(root, "markdown", "one.md"), "---\nid: abc123\ntitle: One\nstatus: draft\n---\nBody\n");
});

afterAll(async () => rm(root, { recursive: true, force: true }));

describe("file-backed collections", () => {
  test("detects fixed backing names", async () => {
    expect((await detectCollection(join(root, "csv")))?.backing).toBe("csv");
    expect((await detectCollection(join(root, "json")))?.backing).toBe("json");
    expect((await detectCollection(join(root, "jsonl")))?.backing).toBe("jsonl");
    expect((await detectCollection(join(root, "markdown")))?.backing).toBe("markdown");
  });

  test("validates CSV rows in the schema sandbox", async () => {
    const page = await new CollectionStore().page(join(root, "csv"), "/csv", null, 20);
    expect(page.columns).toEqual(["id", "title", "count"]);
    expect(page.rows[0]?.values.count).toBe(1);
    expect(page.rows[0]?.stableKey).toBe(canonicalStableKey([["id", "one"]]));
    expect(page.rows[1]?.diagnostics[0]?.code).toBe("schema-validation");
    expect(page.rows[1]?.stableKey).toBeNull();
  });

  test("reports malformed JSONL by source line", async () => {
    const page = await new CollectionStore().page(join(root, "jsonl"), "/jsonl", null, 20);
    expect(page.rows[1]?.diagnostics[0]?.code).toBe("invalid-jsonl");
    expect(page.rows[1]?.diagnostics[0]?.row).toBe(2);
    expect(page.rows[0]?.stableKey).toBe(canonicalStableKey([["id", "one"]]));
  });

  test("uses declared keys for JSON row paths, keyset paging, and direct resolution", async () => {
    const collections = new CollectionStore();
    const first = await collections.page(join(root, "json"), "/json", null, 1);
    expect(first.identityRule).toEqual({ scope: "parent", properties: ["id"] });
    expect(first.rows[0]).toMatchObject({ path: "a", stableKey: canonicalStableKey([["id", "a"]]) });
    expect(first.nextCursor).not.toBeNull();

    const second = await collections.page(join(root, "json"), "/json", first.nextCursor, 1);
    expect(second.rows[0]).toMatchObject({ path: "b", stableKey: canonicalStableKey([["id", "b"]]) });
    expect(second.nextCursor).toBeNull();

    const resolved = await collections.row(join(root, "json"), "/json", {
      path: "/json/stale-readable-path",
      stableKey: canonicalStableKey([["id", "b"]]),
    });
    expect(resolved?.row.values.title).toBe("Second");

    const beforeFormatting = await collections.summary(join(root, "json"));
    await writeFile(join(root, "json", "_store.json"), '[\n  { "id": "b", "title": "Second" },\n  { "id": "a", "title": "First" }\n]\n');
    const afterFormatting = await collections.summary(join(root, "json"));
    expect(afterFormatting?.revision).not.toBe(beforeFormatting?.revision);
    expect(afterFormatting?.modelDigest).toBe(beforeFormatting?.modelDigest);
    await expect(collections.page(join(root, "json"), "/json", first.nextCursor, 1)).rejects.toThrow("another revision");
  });

  test("never falls back from duplicate or nullable declared identity", async () => {
    const duplicate = join(root, "duplicate");
    await mkdir(duplicate);
    await writeFile(join(duplicate, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string(), title: z.string() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(duplicate, "_store.json"), '[{"id":"same","title":"One"},{"id":"same","title":"Two"}]\n');
    const page = await new CollectionStore().page(duplicate, "/duplicate", null, 20);
    expect(page.rows.every((row) => row.stableKey === null)).toBe(true);
    expect(page.rows.every((row) => row.diagnostics.some((item) => item.code === "duplicate-row-key"))).toBe(true);

    const nullable = join(root, "nullable");
    await mkdir(nullable);
    await writeFile(join(nullable, "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ id: z.string().optional() }); export const primaryKey = ["id"] as const;\n');
    await writeFile(join(nullable, "_store.json"), "[]\n");
    await expect(new CollectionStore().summary(nullable)).rejects.toThrow("required schema properties");
  });

  test("keeps Markdown identity in the same property map as record fields", async () => {
    const page = await new CollectionStore().page(join(root, "markdown"), "/markdown", null, 20);
    expect(page.editable).toBe(true);
    expect(page.rows[0]?.values).toEqual({ id: "abc123", title: "One", status: "draft" });
  });
});
