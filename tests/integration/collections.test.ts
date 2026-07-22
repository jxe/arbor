import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollectionStore, detectCollection } from "@arbor/stores";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-collections-"));
  await mkdir(join(root, "csv"));
  await writeFile(join(root, "csv", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ title: z.string(), count: z.coerce.number() });\n');
  await writeFile(join(root, "csv", "_store.csv"), "title,count\nOne,1\nTwo,nope\n");
  await mkdir(join(root, "jsonl"));
  await writeFile(join(root, "jsonl", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ title: z.string() });\n');
  await writeFile(join(root, "jsonl", "_store.jsonl"), '{"title":"One"}\nnot json\n{"title":"Three"}\n');
  await mkdir(join(root, "markdown"));
  await writeFile(join(root, "markdown", "schema.ts"), 'import { z } from "zod"; export const schema = z.object({ title: z.string(), status: z.enum(["draft", "done"]) });\n');
  await writeFile(join(root, "markdown", "one.md"), "---\nid: abc123\ntitle: One\nstatus: draft\n---\nBody\n");
});

afterAll(async () => rm(root, { recursive: true, force: true }));

describe("file-backed collections", () => {
  test("detects fixed backing names", async () => {
    expect((await detectCollection(join(root, "csv")))?.backing).toBe("csv");
    expect((await detectCollection(join(root, "jsonl")))?.backing).toBe("jsonl");
    expect((await detectCollection(join(root, "markdown")))?.backing).toBe("markdown");
  });

  test("validates CSV rows in the schema sandbox", async () => {
    const page = await new CollectionStore().page(join(root, "csv"), "/csv", 0, 20);
    expect(page.columns).toEqual(["title", "count"]);
    expect(page.rows[0]?.values.count).toBe(1);
    expect(page.rows[1]?.diagnostics[0]?.code).toBe("schema-validation");
  });

  test("reports malformed JSONL by source line", async () => {
    const page = await new CollectionStore().page(join(root, "jsonl"), "/jsonl", 0, 20);
    expect(page.rows[1]?.diagnostics[0]?.code).toBe("invalid-jsonl");
    expect(page.rows[1]?.diagnostics[0]?.row).toBe(2);
  });

  test("excludes reserved Markdown metadata from schema values", async () => {
    const page = await new CollectionStore().page(join(root, "markdown"), "/markdown", 0, 20);
    expect(page.editable).toBe(true);
    expect(page.rows[0]?.values).toEqual({ title: "One", status: "draft" });
  });
});
