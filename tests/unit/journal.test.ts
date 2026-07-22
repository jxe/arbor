import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMarkdown } from "@arbor/editor";
import { WriteJournal } from "@arbor/arbord";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("write journal", () => {
  test("restores an edit journaled before a simulated file-write crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-journal-")); directories.push(directory);
    const journal = new WriteJournal(directory);
    const before = parseMarkdown("Before\n").blocks;
    const after = parseMarkdown("Before\n\nAdded before crash\n").blocks;
    const fileMtimeBeforeIntent = Date.now() / 1_000 - 1;
    await journal.commit("abc123", before, after);
    const result = await journal.reconcile("abc123", before, fileMtimeBeforeIntent);
    expect(result.restored).toBeGreaterThan(0);
    expect(result.blocks.some((block) => block.content === "Added before crash")).toBe(true);
  });

  test("materialized edits do not resurrect after a later external deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-journal-")); directories.push(directory);
    const journal = new WriteJournal(directory);
    const before = parseMarkdown("Before\n").blocks;
    const after = parseMarkdown("Before\n\nSaved\n").blocks;
    await journal.commit("abc123", before, after);
    await journal.markMaterialized("abc123");
    const result = await journal.reconcile("abc123", before, Date.now() / 1_000 + 1);
    expect(result.restored).toBe(0);
    expect((await journal.list("abc123", before)).some((entry) => entry.markdown.includes("Saved"))).toBe(true);
  });

  test("observed external blocks are recoverable but never auto-restored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-journal-")); directories.push(directory);
    const journal = new WriteJournal(directory);
    const external = parseMarkdown("External\n").blocks;
    await journal.observe("abc123", external);
    expect((await journal.reconcile("abc123", [], Date.now() / 1_000)).restored).toBe(0);
    expect((await journal.list("abc123", []))[0]?.status).toBe("lost");
  });

  test("purged blocks remain available in Recover", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-journal-")); directories.push(directory);
    const journal = new WriteJournal(directory);
    const before = parseMarkdown("Delete me\n").blocks;
    await journal.commit("abc123", [], before);
    await journal.commit("abc123", before, []);
    const entries = await journal.list("abc123", []);
    expect(entries[0]?.status).toBe("purged");
    expect(entries[0]?.markdown).toContain("Delete me");
  });
});
