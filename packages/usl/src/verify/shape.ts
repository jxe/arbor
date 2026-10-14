// Compares a database's tables with a layout. Shared by the SQL backends:
// each reads its catalog into TableShapes and normalizes type names.

import type { Table } from "../layout.ts";
import type { StoreDiagnostic, TableShape } from "./types.ts";

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function compareShapes(
  tables: Table[],
  actual: TableShape[],
  expectedType: (table: Table, column: Table["columns"][number]) => string,
  sameType: (expected: string, actual: string) => boolean,
): StoreDiagnostic[] {
  const out: StoreDiagnostic[] = [];
  const byName = new Map(actual.map((t) => [t.name, t]));
  for (const table of tables) {
    const shape = byName.get(table.name);
    byName.delete(table.name);
    if (!shape) {
      out.push({ severity: "error", code: "missing-table", table: table.name, message: `No table \`${table.name}\` (stores ${table.stores})` });
      continue;
    }
    const columns = new Map(shape.columns.map((c) => [c.name, c]));
    for (const column of table.columns) {
      const found = columns.get(column.name);
      columns.delete(column.name);
      const at = { table: table.name, column: column.name };
      if (!found) {
        out.push({ severity: "error", code: "missing-column", ...at, message: `\`${table.name}\` has no column \`${column.name}\`` });
        continue;
      }
      const type = expectedType(table, column);
      if (!sameType(type, found.type)) {
        out.push({ severity: "error", code: "column-type", ...at, message: `\`${table.name}.${column.name}\` is ${found.type || "untyped"}, expected ${type}` });
      }
      if (found.nullable && !column.nullable && !table.primaryKey.includes(column.name)) {
        out.push({ severity: "error", code: "column-nullable", ...at, message: `\`${table.name}.${column.name}\` allows NULL, but the schema requires a value` });
      } else if (!found.nullable && column.nullable) {
        out.push({ severity: "error", code: "column-not-null", ...at, message: `\`${table.name}.${column.name}\` is NOT NULL, but the schema lets it be empty` });
      }
    }
    for (const extra of columns.values()) {
      const harmless = extra.nullable || extra.hasDefault;
      out.push({
        severity: harmless ? "warning" : "error",
        code: "extra-column",
        table: table.name,
        column: extra.name,
        message: harmless
          ? `\`${table.name}.${extra.name}\` isn't in the schema`
          : `\`${table.name}.${extra.name}\` isn't in the schema and is NOT NULL with no default, so rows written from the schema can't be inserted`,
      });
    }
    if (!same(table.primaryKey, shape.primaryKey)) {
      out.push({
        severity: "error",
        code: "primary-key",
        table: table.name,
        message: `\`${table.name}\` is keyed by (${shape.primaryKey.join(", ")}), expected (${table.primaryKey.join(", ")})`,
      });
    }
    for (const fk of table.foreignKeys) {
      const found = shape.foreignKeys.some((f) => f.table === fk.table && same(f.columns, fk.columns) && same(f.refColumns, fk.refColumns));
      if (!found) {
        out.push({
          severity: "error",
          code: "missing-foreign-key",
          table: table.name,
          message: `\`${table.name}\` (${fk.columns.join(", ")}) should reference \`${fk.table}\` (${fk.refColumns.join(", ")})`,
        });
      }
    }
  }
  for (const extra of byName.values()) {
    out.push({ severity: "warning", code: "extra-table", table: extra.name, message: `Table \`${extra.name}\` isn't in the schema` });
  }
  return out;
}
