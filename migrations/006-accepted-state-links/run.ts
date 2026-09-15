import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";

/** Offline only: stop writers and retain a verified database/object backup first.
 * IDs, roots, observation rows, digests and private merge provenance are untouched.
 */
export function migrateAcceptedStateLinks(path: string): { migrated: boolean; accepted: number } {
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    return db.transaction(() => {
      const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
      if (stamp === "8") {
        assertCurrentCanopySchema(db);
        return { migrated: false, accepted: (db.query("SELECT COUNT(*) AS n FROM accepted_updates").get() as { n: number }).n };
      }
      if (stamp !== "7") throw new Error(`Expected schema 7, found ${stamp}`);
      if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("SQLite integrity check failed");
      const rows = db.query("SELECT id, tree_id, root, previous_root FROM accepted_updates ORDER BY rowid").all() as Array<{ id: string; tree_id: string; root: string; previous_root: string | null }>;
      const prior = new Map<string, { id: string; root: string }>();
      const links = rows.map(row => {
        const previous = prior.get(row.tree_id);
        if (row.previous_root !== (previous?.root ?? null)) throw new Error(`Cannot reconstruct predecessor for accepted state ${row.id}; restore complete retained history`);
        prior.set(row.tree_id, row);
        return { id: row.id, previous: previous?.id ?? null };
      });
      db.run("ALTER TABLE accepted_updates ADD COLUMN previous_id TEXT");
      db.run("ALTER TABLE accepted_updates ADD COLUMN conflicted INTEGER NOT NULL DEFAULT 0");
      const update = db.query("UPDATE accepted_updates SET previous_id = ? WHERE id = ?");
      for (const link of links) update.run(link.previous, link.id);
      db.run("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
      assertCurrentCanopySchema(db);
      return { migrated: true, accepted: rows.length };
    })();
  } finally { db.close(); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--offline-database") throw new Error("Usage: bun migrations/006-accepted-state-links/run.ts --offline-database <canopy.sqlite3>");
  console.log(JSON.stringify(migrateAcceptedStateLinks(resolve(args[1]!))));
}
