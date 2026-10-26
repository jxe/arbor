// Compare an overstoryd data root before and after an offline migration: every
// tree's current root must decode to the same materialized files. Trees the
// migration adds are not compared.
//   bun run packages/overstoryd/migrations/tools/compare-overstoryd-roots.ts <original-data-root> <migrated-data-root>
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@ovst/object-store";
import { materializeTree } from "@ovst/fs";

const [originalRoot, migratedRoot] = process.argv.slice(2).map((path) => path && resolve(path));
if (!originalRoot || !migratedRoot) {
  console.error("usage: bun run packages/overstoryd/migrations/tools/compare-overstoryd-roots.ts <original-data-root> <migrated-data-root>");
  process.exit(2);
}

/** Each tree with its kind: a configuration governs another tree. */
function trees(dataRoot: string): Array<{ id: string; ref: `sha256:${string}`; kind: string }> {
  const db = new Database(join(dataRoot, "overstoryd.sqlite3"), { readonly: true });
  try {
    const rows = db.query("SELECT id, ref, governs FROM trees ORDER BY id").all() as Array<{ id: string; ref: `sha256:${string}`; governs: string | null }>;
    return rows.map(({ id, ref, governs }) => ({ id, ref, kind: governs ? "configuration" : "ordinary" }));
  } finally { db.close(); }
}

async function files(directory: string): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else result.set(relative(directory, path), new Uint8Array(await readFile(path)));
    }
  };
  await walk(directory);
  return result;
}

const before = trees(originalRoot);
const after = new Map(trees(migratedRoot).map((tree) => [tree.id, tree]));
let differences = 0;
for (const tree of before) {
  const migrated = after.get(tree.id);
  if (!migrated) { console.log(`${tree.id}: MISSING after migration`); differences += 1; continue; }
  if (tree.ref === migrated.ref) { console.log(`${tree.id} (${tree.kind}): root unchanged ${tree.ref}`); continue; }
  const scratch = await mkdtemp(join(tmpdir(), "story-compare-"));
  try {
    const storeBefore = new ObjectStore(join(originalRoot, "objects"));
    const storeAfter = new ObjectStore(join(migratedRoot, "objects"));
    await materializeTree(join(scratch, "before"), tree.ref, (hash) => storeBefore.read(hash));
    await materializeTree(join(scratch, "after"), migrated.ref, (hash) => storeAfter.read(hash));
    const [left, right] = await Promise.all([files(join(scratch, "before")), files(join(scratch, "after"))]);
    const names = new Set([...left.keys(), ...right.keys()]);
    console.log(`${tree.id} (${tree.kind}): root ${tree.ref} -> ${migrated.ref}`);
    for (const name of [...names].sort()) {
      const a = left.get(name); const b = right.get(name);
      if (a && b && Buffer.compare(a, b) === 0) continue;
      if (!a || !b) { console.log(`  ${name}: ${a ? "removed" : "added"}`); differences += 1; continue; }
      console.log(`  ${name}: bytes differ`); differences += 1;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
console.log(differences ? `UNEXPECTED DIFFERENCES: ${differences}` : "OK: every compared tree has the same files");
process.exit(differences ? 1 : 0);
