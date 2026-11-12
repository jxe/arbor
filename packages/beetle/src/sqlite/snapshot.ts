// A collection snapshot's database (collections §1): rows in the schema's database layout,
// as a SQLite file's bytes. The tree's host writes one now and then; anyone loading a log
// that starts from it reads it back. Only the rows count, never the file's bytes.

import { Database } from "bun:sqlite";
import { setupSql, type RowsByTable, type Table } from "@ovst/usl";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A row value as SQLite stores it: flags as 0/1, value arrays as JSON text. */
function stored(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function unstored(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of table.columns) {
    const value = row[column.name] ?? null;
    if (value === null) out[column.name] = null;
    else if (column.array) out[column.name] = typeof value === "string" ? JSON.parse(value) : value;
    else if (column.type === "bool") out[column.name] = value === 1 || value === true;
    else out[column.name] = value;
  }
  return out;
}

export const sqliteSnapshots = {
  /** A SQLite file holding `rows` in `layout`. */
  write(layout: readonly Table[], rows: RowsByTable): Uint8Array {
    const database = new Database(":memory:");
    try {
      database.exec(setupSql([...layout], "sqlite"));
      database.transaction(() => {
        for (const table of layout) {
          const columns = table.columns.map((c) => c.name);
          const insert = database.prepare(`insert into ${quote(table.name)} (${columns.map(quote).join(", ")}) values (${columns.map(() => "?").join(", ")})`);
          for (const row of rows[table.name] ?? []) insert.run(...columns.map((c) => stored(row[c])) as never[]);
        }
      })();
      database.exec("vacuum");
      return database.serialize();
    } finally {
      database.close();
    }
  },

  /** The rows a SQLite file holds in `layout`. */
  read(layout: readonly Table[], bytes: Uint8Array): RowsByTable {
    const database = Database.deserialize(bytes);
    try {
      const rows: RowsByTable = {};
      for (const table of layout) {
        rows[table.name] = (database.query(`select * from ${quote(table.name)}`).all() as Record<string, unknown>[]).map((row) => unstored(table, row));
      }
      return rows;
    } finally {
      database.close();
    }
  },
};
