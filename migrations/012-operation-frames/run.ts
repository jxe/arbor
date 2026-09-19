import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { assertCurrentCanopySchema } from "../../packages/canopy/src/schema.ts";

/** Retained authored intent becomes a frame chain. A schema-13 row carried a
 * flat operation list from its `basis_root` to its `candidate_root`, which is
 * exactly one frame; the conversion is the wrapping and nothing else. A row
 * with no operations keeps an empty chain rather than inventing a frame.
 * No accepted root, object, receipt or evidence row is rewritten.
 */
export function migrateOperationFrames(path: string): { migrated: boolean; rows: number } {
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    return db.transaction(() => {
      const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
      if (stamp === "14") { assertCurrentCanopySchema(db); return { migrated: false, rows: 0 }; }
      if (stamp !== "13") throw new Error(`Expected schema 13, found ${stamp}`);
      if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") {
        throw new Error("SQLite integrity check failed");
      }
      const rows = db.query("SELECT tree_id, change_id, basis_root, candidate_root, operations_json FROM authored_changes").all() as Array<{
        tree_id: string; change_id: string; basis_root: string; candidate_root: string; operations_json: string;
      }>;
      db.run("ALTER TABLE authored_changes RENAME COLUMN operations_json TO trace_json");
      const update = db.prepare("UPDATE authored_changes SET trace_json = ? WHERE tree_id = ? AND change_id = ?");
      for (const row of rows) {
        const operations = JSON.parse(row.operations_json);
        if (!Array.isArray(operations)) throw new Error(`Authored change ${row.change_id} has no operation list`);
        const trace = operations.length
          ? [{ before: row.basis_root, after: row.candidate_root, operations }]
          : [];
        update.run(JSON.stringify(trace), row.tree_id, row.change_id);
      }
      db.run("UPDATE meta SET value = '14' WHERE key = 'schema_version'");
      assertCurrentCanopySchema(db);
      return { migrated: true, rows: rows.length };
    })();
  } finally { db.close(); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--offline-database") {
    throw new Error("Usage: bun migrations/012-operation-frames/run.ts --offline-database <canopy.sqlite3>");
  }
  console.log(JSON.stringify(migrateOperationFrames(resolve(args[1]!))));
}
