// Idempotent setup SQL for SQLite and Postgres from a schema's layout. Run it
// any number of times: tables, indexes and foreign keys are created only
// when missing, and @@seed rows are inserted only when their id is missing.
// It never alters or drops anything; migrations are separate.

import type { RowValue } from "./check.ts";
import type { Column, ForeignKey, Table } from "./layout.ts";

export type Dialect = "sqlite" | "postgres";

export const SQL_TYPES: Record<Dialect, Record<Column["type"], string>> = {
  sqlite: { text: "TEXT", int: "INTEGER", number: "REAL", bool: "BOOLEAN", date: "TEXT", timestamp: "TEXT", position: "REAL" },
  // SQLite stores BOOLEAN with integer affinity; the name tells readers (and apps-runtime) the column is a flag.
  postgres: {
    text: "text",
    int: "bigint",
    number: "double precision",
    bool: "boolean",
    date: "date",
    timestamp: "timestamptz",
    position: "double precision",
  },
};

export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: RowValue, dialect: Dialect): string => {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return dialect === "sqlite" ? (value ? "1" : "0") : String(value);
  return dialect === "sqlite" ? literal(JSON.stringify(value), dialect) : `ARRAY[${value.map((v) => literal(v, dialect)).join(", ")}]`;
};

export function columnType(column: Column, dialect: Dialect): string {
  if (column.array) return dialect === "sqlite" ? "TEXT" : `${SQL_TYPES.postgres[column.type]}[]`;
  return SQL_TYPES[dialect][column.type];
}

function columnSql(column: Column, dialect: Dialect): string {
  const name = quote(column.name);
  let sql = `${name} ${columnType(column, dialect)}`;
  if (!column.nullable) sql += " NOT NULL";
  if (column.array) sql += dialect === "sqlite" ? ` DEFAULT '[]' CHECK (json_type(${name}) = 'array')` : " DEFAULT '{}'";
  if (column.type === "timestamp") {
    sql += dialect === "sqlite" ? " DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" : " DEFAULT now()";
  }
  if (column.type === "bool" && !column.array && dialect === "sqlite") sql += ` CHECK (${name} IN (0, 1))`;
  if (column.allowed) sql += ` CHECK (${name} IN (${column.allowed.map((v) => literal(v, dialect)).join(", ")}))`;
  return sql;
}

const columnList = (names: string[]) => `(${names.map(quote).join(", ")})`;
const onDelete = (fk: ForeignKey) => (fk.onDelete === "restrict" ? "" : ` ON DELETE ${fk.onDelete.toUpperCase()}`);
const references = (fk: ForeignKey) => `FOREIGN KEY ${columnList(fk.columns)} REFERENCES ${quote(fk.table)} ${columnList(fk.refColumns)}${onDelete(fk)}`;
export const foreignKeyName = (table: Table, fk: ForeignKey) => `${table.name}_${fk.columns.join("_")}_fkey`;

export function setupSql(tables: Table[], dialect: Dialect): string {
  const out: string[] = [];
  for (const table of tables) {
    const lines = table.columns.map((c) => columnSql(c, dialect));
    lines.push(`PRIMARY KEY ${columnList(table.primaryKey)}`);
    for (const unique of table.uniques) lines.push(`UNIQUE ${columnList(unique)}`);
    // SQLite has no ALTER TABLE ADD CONSTRAINT, but doesn't need referenced tables to exist yet.
    if (dialect === "sqlite") for (const fk of table.foreignKeys) lines.push(references(fk));
    out.push(`CREATE TABLE IF NOT EXISTS ${quote(table.name)} (\n  ${lines.join(",\n  ")}\n);`);
  }
  if (dialect === "postgres") {
    for (const table of tables) {
      for (const fk of table.foreignKeys) {
        const name = foreignKeyName(table, fk);
        out.push(
          `DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${literal(name, dialect)}) THEN\n` +
            `    ALTER TABLE ${quote(table.name)} ADD CONSTRAINT ${quote(name)} ${references(fk)};\n  END IF;\nEND $$;`,
        );
      }
    }
  }
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      const leadsKey = fk.columns.every((c, i) => table.primaryKey[i] === c);
      if (leadsKey) continue;
      out.push(`CREATE INDEX IF NOT EXISTS ${quote(`${table.name}_${fk.columns.join("_")}_idx`)} ON ${quote(table.name)} ${columnList(fk.columns)};`);
    }
  }
  for (const table of tables) {
    for (const row of table.seed) {
      const names = Object.keys(row);
      const values = names.map((n) => literal(row[n]!, dialect)).join(", ");
      const verb = dialect === "sqlite" ? "INSERT OR IGNORE INTO" : "INSERT INTO";
      const tail = dialect === "sqlite" ? "" : " ON CONFLICT DO NOTHING";
      out.push(`${verb} ${quote(table.name)} ${columnList(names)} VALUES (${values})${tail};`);
    }
  }
  return out.join("\n\n") + "\n";
}
