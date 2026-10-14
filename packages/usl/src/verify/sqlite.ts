import { Database } from "bun:sqlite";
import { columnType } from "../sql.ts";
import { compareShapes } from "./shape.ts";
import type { StoreBackend, TableShape } from "./types.ts";

/** SQLite's type affinity rules (https://sqlite.org/datatype3.html §3.1), with BOOLEAN read as INTEGER like apps-runtime does. */
export function sqliteAffinity(declared: string): string {
  const t = declared.toUpperCase();
  if (t.includes("INT") || t.includes("BOOL")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t === "" || t.includes("BLOB")) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

export function inspectSqlite(db: Database): TableShape[] {
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return names.map((name) => {
    const q = JSON.stringify(name);
    const info = db.query<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }, []>(`PRAGMA table_info(${q})`).all();
    const fks = db.query<{ id: number; seq: number; table: string; from: string; to: string }, []>(`PRAGMA foreign_key_list(${q})`).all();
    const grouped = new Map<number, { columns: string[]; table: string; refColumns: string[] }>();
    for (const fk of fks.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
      const entry = grouped.get(fk.id) ?? { columns: [], table: fk.table, refColumns: [] };
      entry.columns.push(fk.from);
      entry.refColumns.push(fk.to);
      grouped.set(fk.id, entry);
    }
    return {
      name,
      columns: info.map((c) => ({ name: c.name, type: c.type, nullable: c.notnull === 0 && c.pk === 0, hasDefault: c.dflt_value !== null })),
      primaryKey: info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      foreignKeys: [...grouped.values()],
    };
  });
}

export const sqliteBackend: StoreBackend = {
  name: "sqlite",
  layout: "database",
  accepts: (location) => /\.(sqlite3?|db)$/.test(location),
  async verify(tables, location) {
    const db = new Database(location, { readonly: true });
    try {
      return compareShapes(
        tables,
        inspectSqlite(db),
        (_, column) => columnType(column, "sqlite"),
        (expected, actual) => sqliteAffinity(expected) === sqliteAffinity(actual),
      );
    } finally {
      db.close();
    }
  },
};
