import { SQL } from "bun";
import { columnType } from "../sql.ts";
import { compareShapes } from "./shape.ts";
import type { StoreBackend, TableShape } from "./types.ts";

// format_type() spells some types differently from the names setup SQL uses.
const CANONICAL: Record<string, string> = {
  timestamptz: "timestamp with time zone",
  "timestamptz[]": "timestamp with time zone[]",
};
const canonical = (type: string) => CANONICAL[type] ?? type;

/** Reads the tables of one Postgres schema (namespace), `public` by default. */
export async function inspectPostgres(sql: SQL, schema = "public"): Promise<TableShape[]> {
  const columns: { table: string; name: string; type: string; notnull: boolean; hasdef: boolean }[] = await sql`
    SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.atthasdef AS hasdef
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`;
  const constraints: { table: string; kind: string; columns: string[]; ref_table: string | null; ref_columns: string[] | null }[] = await sql`
    SELECT c.relname AS table, k.contype AS kind,
      ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(n, i) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i)::text[] AS columns,
      r.relname AS ref_table,
      ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY u(n, i) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.i)::text[] AS ref_columns
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class r ON r.oid = k.confrelid
    WHERE n.nspname = ${schema} AND k.contype IN ('p', 'f')`;
  const tables = new Map<string, TableShape>();
  for (const c of columns) {
    const table = tables.get(c.table) ?? { name: c.table, columns: [], primaryKey: [], foreignKeys: [] };
    table.columns.push({ name: c.name, type: c.type, nullable: !c.notnull, hasDefault: c.hasdef });
    tables.set(c.table, table);
  }
  for (const k of constraints) {
    const table = tables.get(k.table);
    if (!table) continue;
    if (k.kind === "p") table.primaryKey = k.columns;
    else table.foreignKeys.push({ columns: k.columns, table: k.ref_table!, refColumns: k.ref_columns ?? [] });
  }
  for (const table of tables.values()) {
    for (const c of table.columns) if (table.primaryKey.includes(c.name)) c.nullable = false;
  }
  return [...tables.values()];
}

export const postgresBackend: StoreBackend = {
  name: "postgres",
  accepts: (location) => /^postgres(ql)?:\/\//.test(location),
  async verify(tables, location) {
    const url = new URL(location);
    const schema = url.searchParams.get("schema") ?? "public";
    url.searchParams.delete("schema");
    const sql = new SQL(url.toString());
    try {
      return compareShapes(
        tables,
        await inspectPostgres(sql, schema),
        (_, column) => canonical(columnType(column, "postgres")),
        (expected, actual) => expected === canonical(actual),
      );
    } finally {
      await sql.close();
    }
  },
};
