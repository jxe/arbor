// How a collection's database layout stores row values in SQLite: flags as
// 0/1, value arrays as JSON text, absent values as null.

import type { JSONValue } from "@ovst/protocol";
import type { CollectionSchema } from "./compile.ts";

type Row = Record<string, JSONValue>;

/** A stored SQLite value as the row's JSON value: flags as booleans, value arrays from their JSON text. Null is absent. */
export function fromSQLite(schema: CollectionSchema, column: string, value: unknown): JSONValue | undefined {
  if (value === null || value === undefined) return undefined;
  const check = schema.row.byName.get(column)?.check;
  if (check?.kind === "bool" && typeof value === "number") return value !== 0;
  if (check?.kind === "bool" && typeof value === "boolean") return value;
  if (check?.kind === "array" && typeof value === "string") return JSON.parse(value) as JSONValue;
  if (typeof value === "bigint") return Number(value);
  return value as JSONValue;
}

/** A row value as SQLite stores it. */
export function toSQLite(value: JSONValue | undefined): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/** A stored SQLite row as the database layout's row, without its absent members. */
export function sqliteRow(schema: CollectionSchema, raw: Record<string, unknown>): Row {
  const row: Row = {};
  for (const column of schema.columns) {
    const value = fromSQLite(schema, column, raw[column]);
    if (value !== undefined) row[column] = value;
  }
  return row;
}
