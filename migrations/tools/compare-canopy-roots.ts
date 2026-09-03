// Compare a Canopy data root before and after the offline migration: every
// tree's current root must decode to the same materialized files, except that
// the account-configuration tree's trees.yaml loses its kind lines.
//   bun run migrations/tools/compare-canopy-roots.ts <original-data-root> <migrated-data-root>
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "../../packages/canopy/src/objects.ts";
import { readAccountConfigGraph, type AccountConfigGraph } from "../../packages/canopy/src/account-policy.ts";
import { readAccountConfigGraphV2, type AccountConfigGraphV2 } from "../../packages/canopy/src/account-policy-v2.ts";
import { materializeTree } from "@arbor/fs";

const [originalRoot, migratedRoot] = process.argv.slice(2).map((path) => path && resolve(path));
if (!originalRoot || !migratedRoot) {
  console.error("usage: bun run migrations/tools/compare-canopy-roots.ts <original-data-root> <migrated-data-root>");
  process.exit(2);
}

function trees(dataRoot: string): Array<{ id: string; ref: `sha256:${string}`; policy: string }> {
  const db = new Database(join(dataRoot, "canopy.sqlite3"), { readonly: true });
  try {
    return db.query("SELECT id, ref, policy FROM trees ORDER BY id").all() as Array<{ id: string; ref: `sha256:${string}`; policy: string }>;
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
function isV1(graph: AccountConfigGraph | AccountConfigGraphV2): graph is AccountConfigGraph {
  return "version" in graph.account;
}

function accountSemantic(graph: AccountConfigGraph | AccountConfigGraphV2) {
  if (isV1(graph)) {
    return {
      canopy: graph.account.community,
      profile: graph.account.profile.tree,
      trees: Object.fromEntries(Object.entries(graph.trees.trees).map(([id, tree]) => [id, {
        canonical: `${graph.account.community}${tree.canonicalPath === "/" ? "/" : tree.canonicalPath}`,
        access: tree.access,
      }])),
      devices: Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
        label: device.label,
        administrator: graph.account.admins.includes(id),
      }])),
    };
  }
  return {
    canopy: graph.account.canopy,
    profile: graph.account.profile,
    trees: Object.fromEntries(Object.entries(graph.trees).map(([id, tree]) => [id, { canonical: tree.canonical, access: tree.access }])),
    devices: Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
      label: device.label,
      administrator: device.administrator,
    }])),
  };
}

function stable(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(normalize)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]))
      : entry;
  return JSON.stringify(normalize(value));
}

for (const tree of before) {
  const migrated = after.get(tree.id);
  if (!migrated) { console.log(`${tree.id}: MISSING after migration`); differences += 1; continue; }
  if (tree.ref === migrated.ref) { console.log(`${tree.id} (${tree.policy}): root unchanged ${tree.ref}`); continue; }
  if (tree.policy === "account-config-v1" && migrated.policy === "account-config-v2") {
    const beforeStore = new ObjectStore(join(originalRoot, "objects"));
    const afterStore = new ObjectStore(join(migratedRoot, "objects"));
    const left = accountSemantic(readAccountConfigGraph(await beforeStore.completeSnapshot(tree.ref), tree.id));
    const right = accountSemantic(readAccountConfigGraphV2(await afterStore.completeSnapshot(migrated.ref), tree.id));
    if (stable(left) !== stable(right)) {
      console.log(`${tree.id}: account-configuration semantics differ`);
      differences += 1;
    } else {
      console.log(`${tree.id}: account-configuration v1 -> v2, semantics preserved`);
    }
    continue;
  }
  const scratch = await mkdtemp(join(tmpdir(), "arbor-compare-"));
  try {
    const storeBefore = new ObjectStore(join(originalRoot, "objects"));
    const storeAfter = new ObjectStore(join(migratedRoot, "objects"));
    await materializeTree(join(scratch, "before"), tree.ref, (hash) => storeBefore.read(hash));
    await materializeTree(join(scratch, "after"), migrated.ref, (hash) => storeAfter.read(hash));
    const [left, right] = await Promise.all([files(join(scratch, "before")), files(join(scratch, "after"))]);
    const names = new Set([...left.keys(), ...right.keys()]);
    console.log(`${tree.id} (${tree.policy}): root ${tree.ref} -> ${migrated.ref}`);
    for (const name of [...names].sort()) {
      const a = left.get(name); const b = right.get(name);
      if (a && b && Buffer.compare(a, b) === 0) continue;
      if (!a || !b) { console.log(`  ${name}: ${a ? "removed" : "added"}`); differences += 1; continue; }
      if (name === "trees.yaml") {
        const removed = new TextDecoder().decode(a).split("\n").filter((line) => !new TextDecoder().decode(b).split("\n").includes(line));
        const added = new TextDecoder().decode(b).split("\n").filter((line) => !new TextDecoder().decode(a).split("\n").includes(line));
        console.log(`  trees.yaml: removed ${JSON.stringify(removed)}, added ${JSON.stringify(added)}`);
        if (added.length || removed.some((line) => !/^\s*kind:/.test(line))) differences += 1;
        continue;
      }
      console.log(`  ${name}: bytes differ`); differences += 1;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
console.log(differences ? `UNEXPECTED DIFFERENCES: ${differences}` : "OK: migration-specific semantic differences only");
process.exit(differences ? 1 : 0);
