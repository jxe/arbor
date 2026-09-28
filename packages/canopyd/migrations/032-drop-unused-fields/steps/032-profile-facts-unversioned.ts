import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 31 → 32: each `profile_facts.facts` loses `version: 3`, a relic of
 * the `meta` cache that migration 020 replaced; the schema stamp versions the
 * row now, and nothing reads the field. Every other member is kept as stored.
 * A row with another version is not one this step was written for: it
 * refuses, and the whole batch rolls back.
 */
export const profileFactsUnversioned: MigrationStep = {
  from: 31,
  name: "032-profile-facts-unversioned",
  run(db) {
    const rows = db.query("SELECT tree_id, facts FROM profile_facts ORDER BY tree_id").all() as Array<{ tree_id: string; facts: string }>;
    const update = db.prepare("UPDATE profile_facts SET facts = ? WHERE tree_id = ?");
    for (const row of rows) {
      const { version, ...facts } = JSON.parse(row.facts) as Record<string, unknown>;
      if (version !== 3) throw new Error(`profile_facts for ${row.tree_id} has version ${JSON.stringify(version)}, not 3`);
      update.run(JSON.stringify(facts), row.tree_id);
    }
  },
  verify(db) {
    const versioned = db.query("SELECT COUNT(*) AS n FROM profile_facts WHERE json_type(facts, '$.version') IS NOT NULL").get() as { n: number };
    if (versioned.n) throw new Error(`${versioned.n} profile_facts row(s) still carry a version`);
  },
};
