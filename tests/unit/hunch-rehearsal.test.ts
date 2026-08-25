import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRun,
  buildPlan,
  draftRecipe,
  inventorySource,
  readManifest,
  recordDryRun,
  verifyRun,
  type ConversionRecipe,
} from "../../tools/hunch-rehearsal/conversion.ts";

describe("Hunch rehearsal converter", () => {
  let root: string;
  let source: string;
  let operator: string;
  let destinationParent: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "arbor-hunch-rehearsal-"));
    source = join(root, "hunch");
    operator = join(root, "operator");
    destinationParent = join(root, "rehearsals");
    await Promise.all([
      mkdir(join(source, "Assets"), { recursive: true }),
      mkdir(join(source, "Trash"), { recursive: true }),
      mkdir(join(source, ".history", "Home.md"), { recursive: true }),
      mkdir(operator, { recursive: true }),
      mkdir(destinationParent, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(source, ".clamshell.json"), `${JSON.stringify({ homeRelativePath: "Home.md" }, null, 2)}\n`),
      writeFile(join(source, "Home.md"), Buffer.from(
        "---\r\n# retained comment\r\ntags: [alpha]\r\nclamshell-id: home12\r\nclamshell: {\"v\":1}\r\n---\r\n# Home\r\n\r\n[Note](Note.md#note34)\r\n",
      )),
      writeFile(join(source, "Note.md"), "# Note\n\n[Home](Home.md)\n\n[Discard](Discard.md#gone56)\n\n[Missing](Missing.md)\n"),
      writeFile(join(source, "Discard.md"), "---\nclamshell-id: gone56\n---\n# Collision\n"),
      writeFile(join(source, "Assets", "photo.png"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47])),
      writeFile(join(source, "Trash", "old.md"), "# Old\n"),
      writeFile(join(source, ".history", "Home.md", "device.jsonl"), "{}\n"),
      writeFile(join(source, "notes.txt"), "not imported\n"),
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeRecipe(): Promise<string> {
    const recipe: ConversionRecipe = {
      version: 1,
      home: "Home.md",
      assetRoots: ["Assets"],
      pages: {
        "Home.md": { action: "keep" },
        "Note.md": { action: "keep", pageID: "note34" },
        "Discard.md": { action: "discard", reason: "reviewed collision" },
      },
    };
    const path = join(operator, "recipe.json");
    await writeFile(path, `${JSON.stringify(recipe, null, 2)}\n`, { mode: 0o600 });
    return path;
  }

  test("inventory is read-only and drafts explicit review decisions", async () => {
    const before = await inventorySource(source);
    expect(before.home).toBe("Home.md");
    expect(before.pages.map((page) => page.path)).toEqual(["Discard.md", "Home.md", "Note.md"]);
    expect(before.pages.find((page) => page.path === "Home.md")?.clamshellID).toBe("home12");
    expect(before.pages.find((page) => page.path === "Note.md")?.clamshellID).toBeUndefined();
    expect(before.assetFiles).toEqual([expect.objectContaining({ path: "Assets/photo.png", bytes: 4 })]);
    expect(before.trashMarkdown).toBe(1);
    expect(before.historyFiles).toBe(1);
    expect(before.otherFiles).toEqual(["notes.txt"]);

    const draftPath = join(operator, "draft.json");
    const draft = await draftRecipe(source, draftPath);
    expect(draft.home).toBe("Home.md");
    expect(draft.pages["Home.md"]).toEqual({ action: "review" });
    expect(draft.pages["Note.md"]).toEqual({ action: "review", proposedPageID: expect.stringMatching(/^[a-z0-9]{6}$/) });
    await expect(draftRecipe(source, draftPath)).rejects.toThrow("refusing to remint PageIDs");
    expect((await inventorySource(source)).sourceDigest).toBe(before.sourceDigest);
  });

  test("two deterministic dry runs gate a byte-preserving apply and verify", async () => {
    const recipePath = await writeRecipe();
    const destination = join(destinationParent, "run-a");
    const manifestPath = join(operator, "run-a.json");
    const common = {
      source,
      recipePath,
      destination,
      runId: "run-a",
      manifestPath,
      knownGaps: ["Images are deliberately deferred"],
    };
    const sourceBefore = await inventorySource(source);

    const first = await recordDryRun({ ...common, now: "2026-08-25T12:00:00.000Z" });
    const second = await recordDryRun({ ...common, now: "2026-08-25T12:01:00.000Z" });
    expect(first.planDigest).toBe(second.planDigest);
    expect(second.dryRuns).toHaveLength(2);
    expect(second.knownGaps).toEqual(["Images are deliberately deferred"]);
    expect(second.repositoryState.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(second.repositoryState.toolDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.entries.map((entry) => entry.destinationPath)).toEqual(["Assets/photo.png", "Note.md", "_index.md"]);
    expect(second.linkWarnings).toEqual([
      { sourcePath: "Note.md", destination: "Discard.md#gone56", resolvedPath: "Discard.md", reason: "discarded-target" },
      { sourcePath: "Note.md", destination: "Home.md", resolvedPath: "Home.md", reason: "fragmentless-home-link" },
      { sourcePath: "Note.md", destination: "Missing.md", resolvedPath: "Missing.md", reason: "missing-target" },
    ]);

    const applied = await applyRun({ ...common, now: "2026-08-25T12:02:00.000Z" });
    expect(applied.appliedAt).toBe("2026-08-25T12:02:00.000Z");
    expect(applied.sourceDigestAfter).toBe(sourceBefore.sourceDigest);
    expect((await inventorySource(source)).sourceDigest).toBe(sourceBefore.sourceDigest);

    const home = await readFile(join(destination, "_index.md"), "utf8");
    expect(home).toBe("---\r\n# retained comment\r\ntags: [alpha]\r\nid: home12\r\n---\r\n# Home\r\n\r\n[Note](Note.md#note34)\r\n");
    expect(await readFile(join(destination, "Note.md"), "utf8")).toBe(
      "---\nid: note34\n---\n# Note\n\n[Home](Home.md)\n\n[Discard](Discard.md#gone56)\n\n[Missing](Missing.md)\n",
    );
    expect(new Uint8Array(await readFile(join(destination, "Assets", "photo.png")))).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(readFile(join(destination, "Discard.md"))).rejects.toThrow();
    await expect(readFile(join(destination, "Trash", "old.md"))).rejects.toThrow();
    await expect(readFile(join(destination, ".clamshell.json"))).rejects.toThrow();
    await expect(readFile(join(destination, "notes.txt"))).rejects.toThrow();

    const verified = await verifyRun({ manifestPath, now: "2026-08-25T12:03:00.000Z" });
    expect(verified.verifiedAt).toBe("2026-08-25T12:03:00.000Z");
    expect((await readManifest(manifestPath)).manifest.dryRuns).toHaveLength(2);
  });

  test("apply refuses one dry run, unknown pages, and existing destinations", async () => {
    const recipePath = await writeRecipe();
    const destination = join(destinationParent, "run-b");
    const manifestPath = join(operator, "run-b.json");
    const common = { source, recipePath, destination, runId: "run-b", manifestPath };
    await recordDryRun(common);
    await expect(applyRun(common)).rejects.toThrow("two matching dry-run confirmations");

    await writeFile(join(source, "New.md"), "---\nclamshell-id: new789\n---\n# New\n");
    await expect(buildPlan(common)).rejects.toThrow("Source pages need recipe decisions: New.md");
    await rm(join(source, "New.md"));

    await recordDryRun(common);
    await mkdir(destination);
    await expect(applyRun(common)).rejects.toThrow("Destination already exists");
  });

  test("a recorded run refuses recipe drift", async () => {
    const recipePath = await writeRecipe();
    const common = {
      source,
      recipePath,
      destination: join(destinationParent, "run-d"),
      runId: "run-d",
      manifestPath: join(operator, "run-d.json"),
    };
    await recordDryRun(common);
    const changed: ConversionRecipe = {
      version: 1,
      home: "Home.md",
      pages: {
        "Home.md": { action: "keep" },
        "Note.md": { action: "keep", pageID: "note34" },
        "Discard.md": { action: "discard", reason: "a different reviewed reason" },
      },
    };
    await writeFile(recipePath, `${JSON.stringify(changed, null, 2)}\n`);
    await expect(recordDryRun(common)).rejects.toThrow("does not match the recorded manifest");
  });

  test("conversion stops on duplicate IDs and preexisting Arbor IDs", async () => {
    const recipePath = await writeRecipe();
    const destination = join(destinationParent, "run-c");
    await writeFile(join(source, "Note.md"), "---\nid: note34\n---\n# Already Arbor\n");
    await expect(buildPlan({ source, recipePath, destination, runId: "run-c" }))
      .rejects.toThrow("preexisting-arbor-id");

    await writeFile(join(source, "Note.md"), "---\nclamshell-id: home12\n---\n# Duplicate\n");
    const duplicateRecipe: ConversionRecipe = {
      version: 1,
      home: "Home.md",
      pages: {
        "Home.md": { action: "keep" },
        "Note.md": { action: "keep" },
        "Discard.md": { action: "discard", reason: "reviewed" },
      },
    };
    await writeFile(recipePath, `${JSON.stringify(duplicateRecipe)}\n`);
    await expect(buildPlan({ source, recipePath, destination, runId: "run-c" }))
      .rejects.toThrow("Duplicate PageID home12");
  });
});
