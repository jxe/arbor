import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  AUTHORITY_SCHEMA,
  assertCurrentCanopySchema,
} from "../../packages/canopy/src/schema.ts";
import { MergeStateStore } from "../../packages/canopy/src/updates/merge-state-store.ts";
/** Offline additive migration. Existing accepted identities, receipts and bytes
 * remain untouched. Historical semantic checkpoints are reconstructed lazily. */
export function migrateMergeState(path: string): { migrated: boolean } {
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    return db
      .transaction(() => {
        const stamp = (
          db
            .query("SELECT value FROM meta WHERE key='schema_version'")
            .get() as { value: string }
        ).value;
        if (stamp === "12") {
          assertCurrentCanopySchema(db);
          return { migrated: false };
        }
        if (stamp !== "11")
          throw new Error(`Expected schema 11, found ${stamp}`);
        if (
          (db.query("PRAGMA quick_check").get() as { quick_check: string })
            .quick_check !== "ok" ||
          db.query("PRAGMA foreign_key_check").all().length
        )
          throw new Error("Invalid source database");
        for (const [table, expected] of Object.entries(AUTHORITY_SCHEMA)) {
          const columns = (
            db.query(`PRAGMA table_info(${table})`).all() as Array<{
              name: string;
            }>
          ).map((c) => c.name);
          if (table === "accepted_merge_states") {
            if (columns.length)
              throw new Error("Unexpected semantic storage in schema 11");
            continue;
          }
          if (
            columns.length !== expected.length ||
            expected.some((name) => !columns.includes(name))
          )
            throw new Error(`Unexpected source schema: ${table}`);
        }
        MergeStateStore.createSchema(db);
        db.run("UPDATE meta SET value='12' WHERE key='schema_version'");
        assertCurrentCanopySchema(db);
        return { migrated: true };
      })
      .immediate();
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--offline-database")
    throw new Error(
      "Usage: bun migrations/010-merge-state/run.ts --offline-database <canopy.sqlite3>"
    );
  console.log(JSON.stringify(migrateMergeState(resolve(args[1]!))));
}
