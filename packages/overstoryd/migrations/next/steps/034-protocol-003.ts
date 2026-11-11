import type { MigrationStep } from "../../tools/batch.ts";
import { MIGRATION_CHANGE, type TreePlan } from "../protocol-003.ts";

/**
 * Schema 33 → 34, Protocol 003's flag day: each tree's history is replaced by
 * one first accepted update whose root is its head in the new format (entry
 * times, pages, row times), which `planProtocol003` wrote to the object store
 * beforehand. Every older update goes, with the records only history needed:
 * `document_versions` is emptied, and `entry_metadata` (Protocol 002's entry
 * metadata) is dropped. Profile facts are rewritten from the new roots.
 */
export function protocol003(plans: readonly TreePlan[]): MigrationStep {
  return {
    from: 33,
    name: "034-protocol-003",
    run(db) {
      const trees = (db.query("SELECT id FROM trees ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
      const planned = new Map(plans.map((plan) => [plan.tree, plan]));
      if (trees.length !== planned.size || trees.some((tree) => !planned.has(tree))) throw new Error("The plan does not cover exactly the host's trees");
      const head = db.prepare("SELECT ordinal, root FROM accepted_updates WHERE tree_id = ? ORDER BY ordinal DESC LIMIT 1");
      const drop = db.prepare("DELETE FROM accepted_updates WHERE tree_id = ?");
      const insert = db.prepare(`
        INSERT INTO accepted_updates (tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id, entry)
        VALUES (?, ?, NULL, 0, ?, NULL, NULL, ?, ?)`);
      const ref = db.prepare("UPDATE trees SET ref = ? WHERE id = ?");
      const profile = db.prepare(`
        INSERT INTO profile_facts (tree_id, index_hash, avatar_path, facts) VALUES (?, ?, ?, ?)
        ON CONFLICT(tree_id) DO UPDATE SET index_hash = excluded.index_hash, avatar_path = excluded.avatar_path, facts = excluded.facts`);
      const noProfile = db.prepare("DELETE FROM profile_facts WHERE tree_id = ?");
      for (const plan of plans) {
        // The plan was made from this head; a write since then would be lost.
        const current = head.get(plan.tree) as { ordinal: number; root: string } | null;
        if (current?.ordinal !== plan.from.update || current.root !== plan.from.root) throw new Error(`${plan.tree} changed after the plan was made`);
        drop.run(plan.tree);
        insert.run(plan.tree, plan.root, plan.acceptedAt, MIGRATION_CHANGE, plan.entry);
        ref.run(plan.root, plan.tree);
        if (plan.profile) profile.run(plan.tree, plan.profile.indexHash, plan.profile.avatarPath, JSON.stringify(plan.profile.facts));
        else noProfile.run(plan.tree);
      }
      db.run("DELETE FROM document_versions");
      db.run("DROP TABLE IF EXISTS entry_metadata");
      return [`${plans.length} trees now start at one update`];
    },
    verify(db) {
      const rows = db.query(`
        SELECT t.id, t.ref, COUNT(u.ordinal) AS n, MAX(u.root) AS root, MAX(u.previous_ordinal) AS previous
        FROM trees t LEFT JOIN accepted_updates u ON u.tree_id = t.id GROUP BY t.id`).all() as Array<{ id: string; ref: string; n: number; root: string | null; previous: number | null }>;
      for (const row of rows) {
        if (row.n !== 1 || row.root !== row.ref || row.previous !== null) throw new Error(`${row.id} does not start at one update holding its head`);
      }
      if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'entry_metadata'").get()) throw new Error("entry_metadata is still there");
      if (db.query("SELECT 1 FROM document_versions LIMIT 1").get()) throw new Error("document_versions still holds history");
    },
  };
}
