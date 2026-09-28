import type { Database } from "bun:sqlite";
import type { MigrationStep } from "../../tools/batch.ts";

/** Every table that names a tree by `tree_id`, besides `trees` itself. */
const TREE_TABLES = [
  "accepted_updates", "entry_metadata", "document_versions", "profile_facts",
  "tree_policy", "tree_admins", "profile_locator_pins",
] as const;

/**
 * Schema 28 → 29: `trees.status` goes. The product has not written `retired`
 * since canopyd 005, but earlier code did, and the live root kept one such
 * tree: ordinary, unmounted, unconfigured and visible to no one. At Joe's
 * decision (2026-09-28) a retired tree is deleted with its rows here, and the
 * step names each one it deletes; its objects become unreferenced. A retired
 * tree anything still points at (a mount, a boundary, a configuration, or an
 * app rule) is not the one this step was written for: it refuses, and the
 * whole batch rolls back.
 */
export const dropTreeStatus: MigrationStep = {
  from: 28,
  name: "029-drop-tree-status",
  run(db) {
    const retired = (db.query("SELECT id FROM trees WHERE status <> 'active' ORDER BY id").all() as Array<{ id: string }>).map(({ id }) => id);
    const notes: string[] = [];
    for (const tree of retired) {
      const held = heldBy(db, tree);
      if (held) throw new Error(`Retired tree ${tree} is still ${held}; trees.status cannot be dropped without deciding what it becomes`);
      const updates = (db.query("SELECT COUNT(*) AS n FROM accepted_updates WHERE tree_id = ?").get(tree) as { n: number }).n;
      for (const table of TREE_TABLES) db.run(`DELETE FROM ${table} WHERE tree_id = ?`, [tree]);
      db.run("DELETE FROM trees WHERE id = ?", [tree]);
      notes.push(`deleted retired tree ${tree} with ${updates} accepted update(s)`);
    }
    db.run("ALTER TABLE trees DROP COLUMN status");
    return notes;
  },
  verify(db) {
    const columns = (db.query("PRAGMA table_info(trees)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (columns.join(",") !== "id,ref,policy,governs") throw new Error(`trees has the wrong columns: ${columns.join(",")}`);
    for (const table of TREE_TABLES) {
      const orphans = (db.query(`SELECT COUNT(*) AS n FROM ${table} x WHERE NOT EXISTS (SELECT 1 FROM trees t WHERE t.id = x.tree_id)`).get() as { n: number }).n;
      if (orphans) throw new Error(`${table} names ${orphans} tree(s) that do not exist`);
    }
  },
};

/** What still points at `tree`, or null. */
function heldBy(db: Database, tree: string): string | null {
  const count = (sql: string) => (db.query(sql).get(tree, tree) as { n: number }).n;
  if (count("SELECT COUNT(*) AS n FROM mounts WHERE tree_id = ? OR parent_tree = ?")) return "mounted or a mount's parent";
  if (count("SELECT COUNT(*) AS n FROM boundaries WHERE tree_id = ? OR parent_tree = ?")) return "a canonical boundary";
  if (count("SELECT COUNT(*) AS n FROM trees WHERE governs = ? OR id = ? AND governs IS NOT NULL")) return "configured or a configuration";
  if (count("SELECT COUNT(*) AS n FROM app_policy WHERE app_tree = ? OR profile_tree = ?")) return "named by an app rule";
  return null;
}
