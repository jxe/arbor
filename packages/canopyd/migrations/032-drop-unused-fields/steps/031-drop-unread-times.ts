import type { Database } from "bun:sqlite";
import type { MigrationStep } from "../../tools/batch.ts";

/** Columns written on insert and never read. */
const UNREAD = [
  ["profile_locator_pins", "pinned_at"],
  ["pairings", "created_at"],
  ["device_sessions", "created_at"],
] as const;

/**
 * Schema 30 → 31: three times nothing reads go. A pin's time was never
 * consulted (a pin is honoured until its locator names another profile), and
 * a pairing's or session's lifetime is its `expires_at`.
 */
export const dropUnreadTimes: MigrationStep = {
  from: 30,
  name: "031-drop-unread-times",
  run(db) {
    for (const [table, column] of UNREAD) db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  },
  verify(db) {
    for (const [table, column] of UNREAD) {
      if (columnsOf(db, table).includes(column)) throw new Error(`${table}.${column} is still there`);
    }
  },
};

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}
