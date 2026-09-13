import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { snapshotDirectory } from "@arbor/fs";

interface Placement {
  id: string;
  osPath?: string;
  canonical?: { path: string; parentTree: string | null } | null;
}

/** Read only, uncached filesystem hashing. No daemon or state-store initialization. */
export async function checkLocal(placements: Placement[], expected?: Map<string, string>) {
  const reports = [];
  for (const placement of placements) {
    if (!placement.osPath) throw new Error(`Placement has no filesystem path: ${placement.id}`);
    const root = resolve(placement.osPath);
    const boundaries = new Map<string, string>();
    for (const other of placements) {
      if (other.id === placement.id) continue;
      if (other.osPath) {
        const rel = relative(root, resolve(other.osPath));
        if (rel && rel !== ".." && !rel.startsWith(`..${sep}`)) boundaries.set(resolve(other.osPath), other.id);
      }
      if (other.canonical?.parentTree === placement.id && placement.canonical) {
        const prefix = placement.canonical.path.replace(/\/$/, "") + "/";
        if (!other.canonical.path.startsWith(prefix)) throw new Error("Canonical child lies outside its parent");
        boundaries.set(join(root, other.canonical.path.slice(prefix.length)), other.id);
      }
    }
    const snapshot = await snapshotDirectory(root, boundaries);
    if (expected && expected.get(placement.id) !== snapshot.root) throw new Error(`Local content differs from migrated Canopy: ${placement.id}`);
    reports.push({ tree: placement.id, root: snapshot.root, objects: snapshot.objects.size });
  }
  return reports;
}

if (import.meta.main) {
  const [placementsPath, reportPath] = Bun.argv.slice(2);
  if (!placementsPath) throw new Error("Usage: check-local.ts <local-descriptors.json> [migration-report.json]");
  const placements = JSON.parse(await readFile(placementsPath, "utf8")) as Placement[];
  const report = reportPath ? JSON.parse(await readFile(reportPath, "utf8")) as { trees: Array<{ id: string; root: string }> } : undefined;
  console.log(JSON.stringify(await checkLocal(placements, report ? new Map(report.trees.map(tree => [tree.id, tree.root])) : undefined), null, 2));
}
