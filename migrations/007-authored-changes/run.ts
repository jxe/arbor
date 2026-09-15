import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";
import { SourceIntentStore } from "../../packages/canopy/src/updates/source-intent-store.ts";

export function migrateAuthoredChanges(path: string): { migrated: boolean } {
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    return db.transaction(() => {
      const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
      if (stamp === "9") { assertCurrentCanopySchema(db); return { migrated: false }; }
      if (stamp !== "8") throw new Error(`Expected schema 8, found ${stamp}`);
      if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("SQLite integrity check failed");
      if (db.query("SELECT name FROM sqlite_master WHERE name = 'authored_changes'").get()) throw new Error("Unexpected authored_changes in schema 8");
      SourceIntentStore.createSchema(db);
      db.run("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
      assertCurrentCanopySchema(db);
      return { migrated: true };
    })();
  } finally { db.close(); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--offline-database") throw new Error("Usage: bun migrations/007-authored-changes/run.ts --offline-database <canopy.sqlite3>");
  console.log(JSON.stringify(migrateAuthoredChanges(resolve(args[1]!))));
}
