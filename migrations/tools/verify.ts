// Verify a cutover: server health, each public tree's ref against the migration
// report, every local placement idle, and the authored manifest unchanged.
//   bun run migrations/tools/verify.ts <canopy-origin> <report.json> [--manifest before.json after.json] [--sync http://127.0.0.1:4317]
// The report is what a migration's run.ts prints: { trees: [{ id, root }] }.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const [origin, reportPath] = args;
if (!origin || !reportPath) {
  console.error("usage: verify.ts <canopy-origin> <report.json> [--manifest before after] [--sync origin]");
  process.exit(2);
}
const flag = (name: string, count: number) => { const i = args.indexOf(name); return i >= 0 ? args.slice(i + 1, i + 1 + count) : null; };
const manifest = flag("--manifest", 2);
const sync = flag("--sync", 1)?.[0] ?? "http://127.0.0.1:4317";
// A report captured over `railway ssh` carries the CLI's own notices before the JSON.
const reportText = await readFile(resolve(reportPath), "utf8");
const report = JSON.parse(reportText.slice(reportText.indexOf("{"))) as { trees: Array<{ id: string; root: string }> };
const failures: string[] = [];

const health = await fetch(`${origin}/.arbor/health`).catch(() => null);
if (!health?.ok) failures.push(`health: ${health?.status ?? "unreachable"}`);

for (const tree of report.trees) {
  const response = await fetch(`${origin}/.arbor/trees/${tree.id}/ref`).catch(() => null);
  if (!response) { failures.push(`${tree.id}: unreachable`); continue; }
  if (response.status === 401 || response.status === 403 || response.status === 404) continue; // private; the daemon checks it
  if (!response.ok) { failures.push(`${tree.id}: HTTP ${response.status}`); continue; }
  const body = await response.json() as { snapshot?: { ref?: string } };
  if (body.snapshot?.ref !== tree.root) failures.push(`${tree.id}: server ref ${body.snapshot?.ref} != report ${tree.root}`);
}

const local = await fetch(`${sync}/v1/trees`).catch(() => null);
if (!local?.ok) failures.push(`arborsync: ${local?.status ?? "not running"} at ${sync}`);
else {
  const body = await local.json() as { snapshot: Array<{ id: string; sync?: string; placement: string }> };
  for (const tree of body.snapshot) {
    if (tree.placement !== "remote" && tree.sync !== "idle") failures.push(`${tree.id}: local placement is ${tree.sync ?? "unknown"}, not idle`);
  }
}

if (manifest) {
  const diff = Bun.spawn(["bun", "run", resolve(import.meta.dir, "authored-manifest.ts"), "diff", manifest[0]!, manifest[1]!], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(diff.stdout).text();
  if ((await diff.exited) !== 0) failures.push(`authored files changed: ${out.trim()}`);
}

console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
