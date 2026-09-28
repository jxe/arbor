import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 28 → 29: `trees.status` goes. Nothing has ever written `retired`
 * (every tree is inserted `active`), so each `status = 'active'` test the
 * product makes is always true. A data root holding a retired tree is not
 * the one this step was written for: it refuses, and the whole batch rolls
 * back, rather than silently reactivating that tree.
 */
export const dropTreeStatus: MigrationStep = {
  from: 28,
  name: "029-drop-tree-status",
  run(db) {
    const retired = (db.query("SELECT COUNT(*) AS n FROM trees WHERE status <> 'active'").get() as { n: number }).n;
    if (retired) throw new Error(`${retired} tree(s) are not active; trees.status cannot be dropped without deciding what they become`);
    db.run("ALTER TABLE trees DROP COLUMN status");
  },
  verify(db) {
    const columns = (db.query("PRAGMA table_info(trees)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (columns.join(",") !== "id,ref,policy,governs") throw new Error(`trees has the wrong columns: ${columns.join(",")}`);
  },
};
