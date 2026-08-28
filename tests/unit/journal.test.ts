import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMarkdown } from "@arbor/editor";
import { WriteJournal } from "@arbor/arborsync";
import { MutationJournal } from "@arbor/fs";

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

describe("durable mutation journal", () => {
  test("retains materialized effects and completed receipts across instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-mutations-")); directories.push(directory);
    const first = new MutationJournal(directory);
    await first.prepare("mutation-1", "request-hash", { operations: [] });
    await first.markMaterialized("mutation-1", "request-hash", [{ kind: "created", ref: { tree: "local", path: "/page", stableKey: null } }]);

    const reopened = new MutationJournal(directory);
    expect(await reopened.get("mutation-1")).toMatchObject({
      state: "materialized",
      effects: [{ kind: "created", ref: { tree: "local", path: "/page", stableKey: null } }],
    });
    const receipt = {
      mutationID: "mutation-1",
      observedThrough: "epoch:1",
      effects: [{ kind: "created" as const, ref: { tree: "local" as const, path: "/page", stableKey: null } }],
    };
    await reopened.complete("mutation-1", "request-hash", receipt);
    expect((await new MutationJournal(directory).get("mutation-1"))?.receipt).toEqual(receipt);
  });
});
