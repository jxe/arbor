import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCutoverState } from "../../tools/protocol-cutover-preflight.ts";

test("cutover inventory detects pending work without exposing or rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "arbor-preflight-"));
  try {
    await mkdir(join(root, "sync"));
    const path = join(root, "sync", "tree.json");
    const source = JSON.stringify({ pending: { privateText: "PRIVATE_PAYLOAD", operations: null } });
    await writeFile(path, source);
    const report = await inspectCutoverState(root);
    expect(report.blockersFound).toBe(true);
    expect(report.records[0]!.blockers).toEqual(["pending"]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PAYLOAD");
    expect(await readFile(path, "utf8")).toBe(source);
    await writeFile(path, "broken");
    expect((await inspectCutoverState(root)).blockersFound).toBe(true);
    await writeFile(path, "{}");
    const clean = await inspectCutoverState(root);
    expect(clean.blockersFound).toBe(false);
    expect(clean.cutoverAuthorized).toBe(false);
    const native = join(root, "WorkingTrees", "tree", "sync");
    await mkdir(native, { recursive: true });
    await writeFile(join(native, "update-control.json"), JSON.stringify({ schema: 999 }));
    expect((await inspectCutoverState(root)).records.some((record) => record.blockers.includes("unknown-coordinator-schema"))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
  await expect(inspectCutoverState(root)).rejects.toThrow();
});
