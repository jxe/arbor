import type { JSONValue } from "@ovst/protocol";
import { pointer, type ValueDiagnostic } from "./diagnostics.ts";
import type { CollectionSchema, CsvColumn } from "./compile.ts";
import { validateRow, type ValidationBudget } from "./validate.ts";

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * File-level header checks: header names are distinct. An undeclared column is
 * allowed; it converts as if declared `? name: tstr` (spec 06 §2.4.5).
 */
export function csvHeaderDiagnostics(_schema: CollectionSchema, header: readonly string[]): ValueDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: ValueDiagnostic[] = [];
  for (const name of header) {
    if (seen.has(name)) {
      diagnostics.push({ code: "csv-duplicate-column", path: pointer("", name), message: `CSV column ${JSON.stringify(name)} appears more than once` });
    }
    seen.add(name);
  }
  return diagnostics;
}

/** How an undeclared column converts: an optional text member. */
const UNDECLARED: Omit<CsvColumn, "name"> = { optional: true, nullable: false, scalar: "text" };

type Cell = { absent: true } | { absent: false; value: JSONValue };

function convertCell(column: CsvColumn, text: string): Cell | null {
  if (text === "") {
    if (column.optional) return { absent: true };
    if (column.nullable) return { absent: false, value: null };
    if (column.scalar === "text") return { absent: false, value: "" };
    return null;
  }
  if (column.scalar === "text") return { absent: false, value: text };
  if (column.scalar === "number") {
    if (!JSON_NUMBER.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? { absent: false, value } : null;
  }
  if (column.scalar === "json") {
    try {
      return { absent: false, value: JSON.parse(text) as JSONValue };
    } catch {
      return null;
    }
  }
  if (column.scalar === "boolean") {
    if (text === "true") return { absent: false, value: true };
    if (text === "false") return { absent: false, value: false };
  }
  return null;
}

/**
 * Convert one CSV record to a row value by its columns' declared types, then
 * validate it. A header or schema failure must be reported separately.
 */
export function csvRowValue(
  schema: CollectionSchema,
  header: readonly string[],
  cells: readonly string[],
  budget?: ValidationBudget,
): { value?: Record<string, JSONValue>; diagnostics: ValueDiagnostic[] } {
  const diagnostics: ValueDiagnostic[] = [];
  if (cells.length > header.length) {
    diagnostics.push({ code: "csv-invalid-row", path: "", message: "The record has more cells than the header has columns" });
  }
  const positions = new Map<string, number>();
  header.forEach((name, index) => { if (!positions.has(name)) positions.set(name, index); });
  const value: Record<string, JSONValue> = {};
  for (const column of schema.csvColumns) {
    const position = positions.get(column.name);
    const text = position === undefined ? "" : cells[position] ?? "";
    const cell = convertCell(column, text);
    if (!cell) {
      diagnostics.push({ code: "csv-invalid-cell", path: pointer("", column.name), message: `Cell ${JSON.stringify(text)} does not convert to the declared ${column.scalar}` });
    } else if (!cell.absent) {
      value[column.name] = cell.value;
    }
  }
  const declared = new Set(schema.columns);
  for (const [name, position] of positions) {
    if (declared.has(name)) continue;
    const text = cells[position] ?? "";
    if (text !== "") value[name] = text;
  }
  if (diagnostics.length) return { diagnostics };
  const validation = validateRow(schema, value, budget);
  return validation.length ? { diagnostics: validation } : { value, diagnostics: [] };
}

function sameValue(left: JSONValue | undefined, right: JSONValue | undefined): boolean {
  if (typeof left === "object" && left !== null) return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

export class CsvEncodeError extends Error {
  constructor(readonly diagnostic: ValueDiagnostic) {
    super(diagnostic.message);
    this.name = "CsvEncodeError";
  }
}

function cellText(value: JSONValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Encode one record in an existing file's header order, by the same exact
 * round-trip rule as `encodeCsvRows`. A member with no column is rejected. */
export function encodeCsvRecord(schema: CollectionSchema, header: readonly string[], row: Readonly<Record<string, JSONValue>>): string {
  const missing = Object.keys(row).find((name) => !header.includes(name));
  if (missing !== undefined) {
    throw new CsvEncodeError({ code: "csv-unrepresentable-value", path: pointer("", missing), message: `CSV has no column for ${JSON.stringify(missing)}` });
  }
  const declared = new Map(schema.csvColumns.map((column) => [column.name, column]));
  return header.map((name) => {
    const column = declared.get(name) ?? { name, ...UNDECLARED };
    const present = Object.hasOwn(row, name);
    const value = present ? row[name] : undefined;
    const text = cellText(value);
    const decoded = convertCell(column, text);
    if (decoded === null || !(decoded.absent ? !present : present && sameValue(decoded.value, value))) {
      throw new CsvEncodeError({
        code: "csv-unrepresentable-value",
        path: pointer("", name),
        message: `The value of ${JSON.stringify(name)} cannot be written to CSV without changing it`,
      });
    }
    return quote(text);
  }).join(",");
}

/**
 * Encode rows in `row` column order, followed by undeclared members in order
 * of first appearance. Every cell must convert back to its value exactly;
 * otherwise the write is rejected rather than changing data.
 */
export function encodeCsvRows(schema: CollectionSchema, rows: readonly Readonly<Record<string, JSONValue>>[]): string {
  const declared = new Set(schema.columns);
  const extra = new Set<string>();
  for (const row of rows) for (const name of Object.keys(row)) if (!declared.has(name)) extra.add(name);
  const columns = [...schema.csvColumns, ...[...extra].map((name): CsvColumn => ({ name, ...UNDECLARED }))];
  const lines = [columns.map((column) => quote(column.name)).join(",")];
  for (const row of rows) {
    const cells: string[] = [];
    for (const column of columns) {
      const present = Object.hasOwn(row, column.name);
      const value = present ? row[column.name] : undefined;
      const text = cellText(value);
      const decoded = convertCell(column, text);
      const roundTrips = decoded !== null && (decoded.absent ? !present : present && sameValue(decoded.value, value));
      if (!roundTrips) {
        throw new CsvEncodeError({
          code: "csv-unrepresentable-value",
          path: pointer("", column.name),
          message: `The value of ${JSON.stringify(column.name)} cannot be written to CSV without changing it`,
        });
      }
      cells.push(quote(text));
    }
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}
