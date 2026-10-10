import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 29 → 30: `trees.policy` goes. It is `tree-config-v1` exactly when
 * `governs` names the tree a configuration configures, and `ordinary`
 * otherwise, so `governs` alone says which a tree is. A row where the two
 * disagree, or a policy other than those two, is not the data this step was
 * written for: it refuses, and the whole batch rolls back.
 */
export const dropTreePolicy: MigrationStep = {
  from: 29,
  name: "030-drop-tree-policy",
  run(db) {
    const disagreeing = (db.query(`
      SELECT id, policy, governs FROM trees
      WHERE policy NOT IN ('ordinary', 'tree-config-v1') OR (policy = 'tree-config-v1') <> (governs IS NOT NULL)
      ORDER BY id
    `).all() as Array<{ id: string; policy: string; governs: string | null }>);
    if (disagreeing.length) {
      throw new Error(`trees.policy disagrees with governs for ${disagreeing.map(({ id, policy, governs }) => `${id} (${policy}, governs ${governs ?? "nothing"})`).join(", ")}`);
    }
    db.run("ALTER TABLE trees DROP COLUMN policy");
  },
  verify(db) {
    const columns = (db.query("PRAGMA table_info(trees)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (columns.join(",") !== "id,ref,governs") throw new Error(`trees has the wrong columns: ${columns.join(",")}`);
  },
};
