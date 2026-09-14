import { readFile, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

/** Read-only inventory. Does not initialize stores, contact a daemon, or expose request text/credentials. */
export async function inspectCutoverState(root: string) {
  const records: Array<{ file: string; blockers: string[] }> = [];
  const errors: string[] = [];
  async function names(path: string): Promise<string[]> {
    try { return await readdir(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function inspect(path: string, kind: "daemon" | "coordinator" | "heads") {
    try {
      const source = await readFile(path, "utf8");
      const value = JSON.parse(source) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state object");
      const blockers: string[] = [];
      if (kind === "coordinator" && value.schema !== 2) blockers.push("unknown-coordinator-schema");
      if (kind === "heads" && value.schema !== 1) blockers.push("unknown-heads-schema");
      const fields = kind === "daemon" ? ["pending", "conflict", "conflictMaterial"]
        : kind === "coordinator" ? ["attempt", "head", "conflict", "hold", "nextBase"] : ["pendingRoot"];
      for (const field of fields) if (value[field] !== null && value[field] !== undefined) blockers.push(field);
      if (kind === "heads") {
        if (!value.acceptedRoot || !value.acceptedUpdate) blockers.push("unconfirmed-accepted-state");
        if (value.materializedRoot !== value.acceptedRoot) blockers.push("materialized-root-differs");
      }
      // Detect a concurrent write to a scanned file; this remains a point-in-time observation.
      if (source !== await readFile(path, "utf8")) blockers.push("changed-during-read");
      records.push({ file: relative(root, path), blockers });
    } catch (error) {
      errors.push(`${relative(root, path)}: ${(error as NodeJS.ErrnoException).code ?? "unreadable-or-invalid-json"}`);
    }
  }
  await readdir(root); // A missing root must not look like an empty, settled device.
  for (const name of await names(join(root, "sync"))) {
    if (name.endsWith(".json")) await inspect(join(root, "sync", name), "daemon");
  }
  for (const name of await names(join(root, "WorkingTrees"))) {
    const base = join(root, "WorkingTrees", name);
    const syncFiles = await names(join(base, "sync"));
    if (syncFiles.includes("update-control.json")) await inspect(join(base, "sync", "update-control.json"), "coordinator");
    const controls = await names(join(base, "control"));
    if (controls.includes("heads.json")) await inspect(join(base, "control", "heads.json"), "heads");
  }
  return {
    observedAt: new Date().toISOString(), root, records, errors,
    blockersFound: errors.length > 0 || records.some((record) => record.blockers.length > 0),
    cutoverAuthorized: false,
    limitations: ["No in-memory editor inspection", "No remote or phone-state check", "No filesystem-versus-Canopy root comparison", "Rerun after writers are quiescent; this does not establish readiness"],
  };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: bun tools/protocol-cutover-preflight.ts <client-data-home>");
  const report = await inspectCutoverState(resolve(args[0]!));
  console.log(JSON.stringify(report, null, 2));
  if (report.blockersFound) process.exitCode = 1;
}
