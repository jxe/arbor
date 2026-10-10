import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore, holdsObject } from "@overstory/object-store";
import { stableJSONString } from "@overstory/protocol";
import { decodeLogEntry } from "@overstory/merge-protocol";
import { Sidecar } from "../../../../packages/canopyd-merge/src/sidecar.ts";

/** Rehearsal check for migration 018, on a migrated copy (never live data;
 * it writes nothing to the data root). For each tree, a fresh sidecar is
 * asked a question whose head is the tree's head entry, which rebuilds its
 * cache from the chain's start: the first merge after a restart. It reports
 * the time and the entries replayed, and checks the answer keeps the head's
 * root and decisions.
 *
 *   bun run packages/canopyd/migrations/018-log-entries/rebuild-check.ts <migrated-root>
 */
export async function rebuildCheck(root: string) {
  const shared = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  const heads = db.query(`SELECT u.tree_id AS tree, u.entry FROM accepted_updates u
    WHERE u.ordinal = (SELECT MAX(ordinal) FROM accepted_updates WHERE tree_id = u.tree_id) ORDER BY u.tree_id`).all() as Array<{ tree: string; entry: string }>;
  db.close();
  const trees = [];
  for (const { tree, entry } of heads) {
    const head = decodeLogEntry(await shared.read(entry));
    const staged = new Map<string, Uint8Array>();
    const sidecar = new Sidecar({
      shared: { find: (hash) => shared.find(hash), has: (hash) => holdsObject(shared, hash) },
      staging: { find: async (hash) => staged.get(hash) ?? null, stage: async (values) => { for (const v of values) staged.set(v.hash, v.bytes); } },
    });
    const started = performance.now();
    const answer = await sidecar.answer({
      base: entry, head: entry,
      candidate: { root: head.root, change: `rebuild-check-${tree}`, trace: null, resolves: [] },
      rules: { id: "tree-default", revision: 1, config: { contentChoices: "source", conflictProjection: "current", maxMillis: 30_000 } },
    });
    trees.push({
      tree,
      replayed: sidecar.replayed,
      ms: Math.round(performance.now() - started),
      same: answer.root === head.root && stableJSONString(answer.decisions) === stableJSONString(head.decisions),
    });
  }
  return { ok: trees.every((t) => t.same), trees };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: rebuild-check.ts <migrated-root>"); process.exit(2); }
  const report = await rebuildCheck(resolve(root));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exit(1);
}
