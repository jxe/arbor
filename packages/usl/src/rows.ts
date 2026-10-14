// Row values against a table's columns: the checks Overstory runs when it
// reads or writes a row, whatever the store.

import type { Column, Table } from "./layout.ts";

export interface RowDiagnostic {
  code: "bad-value" | "missing-value" | "extra-column";
  column: string;
  message: string;
}

/** Whether `value` is a valid value for `column`. Null is never valid here; callers decide whether a column may be empty. */
export function fitsColumn(value: unknown, column: Column, item = false): boolean {
  if (column.array && !item) return Array.isArray(value) && value.every((v) => fitsColumn(v, column, true));
  switch (column.type) {
    case "text":
      return typeof value === "string" && (!column.allowed || column.allowed.includes(value));
    case "int":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
    case "position":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
      return typeof value === "boolean";
    case "date":
    case "timestamp":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }
}

/** Converts a CSV cell to the value it holds, or undefined if it holds none. Arrays are JSON. */
export function fromCell(cell: string, column: Column): unknown {
  if (column.array) {
    try {
      return JSON.parse(cell);
    } catch {
      return undefined;
    }
  }
  if (column.type === "number" || column.type === "position" || column.type === "int") {
    return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(cell) ? Number(cell) : undefined;
  }
  if (column.type === "bool") return cell === "true" ? true : cell === "false" ? false : undefined;
  return cell;
}

export const describeColumn = (column: Column) =>
  column.allowed
    ? `one of ${column.allowed.map((a) => JSON.stringify(a)).join(", ")}`
    : `${column.type === "position" ? "number" : column.type}${column.array ? "[]" : ""}`;

/** Columns a row may leave out because the store fills them in. */
export const hasDefault = (column: Column) => column.type === "timestamp" || column.array;

/** Checks one row (already converted from its file format) against a table. */
export function validateRow(table: Table, row: Record<string, unknown>): RowDiagnostic[] {
  const out: RowDiagnostic[] = [];
  const columns = new Map(table.columns.map((c) => [c.name, c]));
  for (const [name, value] of Object.entries(row)) {
    const column = columns.get(name);
    if (!column) {
      out.push({ code: "extra-column", column: name, message: `\`${name}\` isn't in the schema` });
    } else if (value === null || value === undefined) {
      if (!column.nullable && !hasDefault(column)) out.push({ code: "missing-value", column: name, message: `\`${name}\` is required` });
    } else if (!fitsColumn(value, column)) {
      out.push({ code: "bad-value", column: name, message: `\`${name}\` should be ${describeColumn(column)}, not ${JSON.stringify(value)}` });
    }
  }
  for (const column of table.columns) {
    if (!(column.name in row) && !column.nullable && !hasDefault(column)) {
      out.push({ code: "missing-value", column: column.name, message: `\`${column.name}\` is required` });
    }
  }
  return out;
}
