import { SourceIntentStore } from "../../packages/canopy/src/updates/source-intent-store.ts";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";
import { ConflictStore } from "../../packages/canopy/src/updates/conflict-store.ts";

export function migrateAcceptedConflicts(path: string): { migrated: boolean } {
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    return db.transaction(() => {
      const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
      if (stamp === "10") { assertCurrentCanopySchema(db); return { migrated: false }; }
      if (stamp !== "8" && stamp !== "9") throw new Error(`Expected schema 8 or 9, found ${stamp}`);
      if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("SQLite integrity check failed");
      if (db.query("SELECT name FROM sqlite_master WHERE name = 'accepted_conflicts'").get()) throw new Error("Unexpected accepted_conflicts in schema 9");
      if (db.query("SELECT 1 FROM accepted_updates WHERE conflicted = 1 LIMIT 1").get()) throw new Error("Existing unresolved signals require retained conflict evidence");
      if (stamp === "8") {
        if (db.query("SELECT name FROM sqlite_master WHERE name = 'authored_changes'").get()) throw new Error("Unexpected authored changes in schema 8");
        SourceIntentStore.createSchema(db);
      }
      db.run("ALTER TABLE accepted_updates ADD COLUMN change_id TEXT");
      db.run("UPDATE accepted_updates SET change_id = (SELECT change_id FROM authored_changes WHERE accepted_id = accepted_updates.id)");
      db.run("CREATE UNIQUE INDEX accepted_updates_change ON accepted_updates(tree_id, change_id) WHERE change_id IS NOT NULL");
      ConflictStore.createSchema(db);
      db.run("UPDATE meta SET value = '10' WHERE key = 'schema_version'");
      assertCurrentCanopySchema(db);
      return { migrated: true };
    })();
  } finally { db.close(); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--offline-database") throw new Error("Usage: bun migrations/008-accepted-conflicts/run.ts --offline-database <canopy.sqlite3>");
  console.log(JSON.stringify(migrateAcceptedConflicts(resolve(args[1]!))));
}
