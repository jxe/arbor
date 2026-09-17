import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";
import { ConflictStore } from "../../packages/canopy/src/updates/conflict-store.ts";
import { SourceIntentStore } from "../../packages/canopy/src/updates/source-intent-store.ts";

/** No old conflict rows are rewritten: absent parent means the tree root.
 * The stamp prevents old binaries from misinterpreting a new nested decision.
 */
export function migrateNestedConflicts(path: string): { migrated: boolean } {
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    return db.transaction(() => {
      const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
      if (stamp === "11") { assertCurrentCanopySchema(db); return { migrated: false }; }
      if (!["8", "9", "10"].includes(stamp)) throw new Error(`Expected schema 8, 9 or 10, found ${stamp}`);
      if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("SQLite integrity check failed");
      if (stamp !== "10") {
        if (db.query("SELECT name FROM sqlite_master WHERE name = 'accepted_conflicts'").get()) throw new Error("Unexpected conflict storage");
        if (db.query("SELECT 1 FROM accepted_updates WHERE conflicted = 1 LIMIT 1").get()) throw new Error("Missing retained conflict evidence");
        if (stamp === "8") {
          if (db.query("SELECT name FROM sqlite_master WHERE name = 'authored_changes'").get()) throw new Error("Unexpected authored storage");
          SourceIntentStore.createSchema(db);
        }
        db.run("ALTER TABLE accepted_updates ADD COLUMN change_id TEXT");
        db.run("UPDATE accepted_updates SET change_id = (SELECT change_id FROM authored_changes WHERE accepted_id = accepted_updates.id)");
        db.run("CREATE UNIQUE INDEX accepted_updates_change ON accepted_updates(tree_id, change_id) WHERE change_id IS NOT NULL");
        ConflictStore.createSchema(db);
      }
      db.run("UPDATE meta SET value = '11' WHERE key = 'schema_version'");
      assertCurrentCanopySchema(db);
      return { migrated: true };
    })();
  } finally { db.close(); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--offline-database") throw new Error("Usage: bun migrations/009-nested-conflict-locations/run.ts --offline-database <canopy.sqlite3>");
  console.log(JSON.stringify(migrateNestedConflicts(resolve(args[1]!))));
}
