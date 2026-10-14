// Data files: a folder holding one file per table, `<Table>.csv`,
// `<Table>.jsonl` or `<Table>.json` (an array of objects). A schema with one
// table may use Overstory's `_store.csv` / `_store.jsonl` / `_store.json`
// instead. Unlike the database backends, which compare declared structure,
// this one reads every row: types, required values, allowed values, unique
// keys, and references between the files.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import type { Table } from "../layout.ts";
import { fromCell, hasDefault, validateRow } from "../rows.ts";
import type { StoreBackend, StoreDiagnostic } from "./types.ts";

const FORMATS = ["csv", "jsonl", "json"] as const;
type Format = (typeof FORMATS)[number];
const MAX_PER_TABLE = 20;

interface LoadedTable {
  table: Table;
  file: string;
  rows: { row: number; values: Record<string, unknown> }[];
}

function findFile(dir: string, table: Table, single: boolean): { path: string; format: Format } | null {
  for (const base of single ? [table.name, "_store"] : [table.name]) {
    for (const format of FORMATS) {
      const path = join(dir, `${base}.${format}`);
      if (existsSync(path)) return { path, format };
    }
  }
  return null;
}

function readRows(path: string, format: Format): { rows: { row: number; values: Record<string, unknown> }[]; header?: string[] } {
  const text = readFileSync(path, "utf8");
  if (format === "csv") {
    const records: string[][] = parseCsv(text, { relax_column_count: false, skip_empty_lines: true });
    const [header = [], ...body] = records;
    return {
      header,
      // CSV cells stay strings; an empty cell is absent. Line numbers count the header.
      rows: body.map((cells, i) => ({
        row: i + 2,
        values: Object.fromEntries(header.flatMap((h, j) => (cells[j] === "" || cells[j] === undefined ? [] : [[h, cells[j]]]))),
      })),
    };
  }
  if (format === "jsonl") {
    return {
      rows: text
        .split("\n")
        .map((line, i) => ({ line, row: i + 1 }))
        .filter(({ line }) => line.trim() !== "")
        .map(({ line, row }) => ({ row, values: JSON.parse(line) as Record<string, unknown> })),
    };
  }
  const array = JSON.parse(text) as unknown;
  if (!Array.isArray(array)) throw new Error("expected an array of rows");
  return { rows: array.map((values, i) => ({ row: i + 1, values: values as Record<string, unknown> })) };
}

export function verifyFiles(tables: Table[], dir: string): StoreDiagnostic[] {
  const out: StoreDiagnostic[] = [];
  const loaded = new Map<string, LoadedTable>();
  const single = tables.length === 1;

  for (const table of tables) {
    const found = findFile(dir, table, single);
    if (!found) {
      out.push({ severity: "error", code: "missing-table", table: table.name, message: `No ${table.name}.csv, .jsonl or .json in ${dir}` });
      continue;
    }
    let read: ReturnType<typeof readRows>;
    try {
      read = readRows(found.path, found.format);
    } catch (error) {
      out.push({ severity: "error", code: "unreadable", table: table.name, message: `${found.path}: ${(error as Error).message}` });
      continue;
    }
    const columns = new Map(table.columns.map((c) => [c.name, c]));
    if (read.header) {
      for (const h of read.header) {
        if (!columns.has(h)) out.push({ severity: "warning", code: "extra-column", table: table.name, column: h, message: `${found.path}: column \`${h}\` isn't in the schema` });
      }
      for (const c of table.columns) {
        if (!read.header.includes(c.name) && !c.nullable && !hasDefault(c)) {
          out.push({ severity: "error", code: "missing-column", table: table.name, column: c.name, message: `${found.path} has no \`${c.name}\` column` });
        }
      }
    }
    let reported = 0;
    const report = (d: StoreDiagnostic) => {
      if (reported++ < MAX_PER_TABLE) out.push(d);
    };
    const rows: LoadedTable["rows"] = [];
    const keys = new Map<string, number>();
    for (const { row, values: raw } of read.rows) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        report({ severity: "error", code: "row-shape", table: table.name, row, message: `${found.path}:${row}: a row is an object` });
        continue;
      }
      // Convert CSV cells, then check the row as Overstory would.
      const values: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(raw)) {
        const column = columns.get(name);
        if (!column && read.header) continue; // reported once, from the header
        values[name] = column && read.header && typeof value === "string" ? (fromCell(value, column) ?? value) : value;
      }
      for (const d of validateRow(table, values)) {
        const severity = d.code === "extra-column" ? "warning" : "error";
        report({ severity, code: d.code, table: table.name, column: d.column, row, message: `${found.path}:${row}: ${d.message}` });
        if (d.code === "bad-value") delete values[d.column];
      }
      const key = JSON.stringify(table.primaryKey.map((k) => values[k] ?? null));
      const first = keys.get(key);
      if (first !== undefined) {
        report({ severity: "error", code: "duplicate-key", table: table.name, row, message: `${found.path}:${row}: same key as row ${first} (${table.primaryKey.join(", ")})` });
      } else {
        keys.set(key, row);
      }
      rows.push({ row, values });
    }
    if (reported > MAX_PER_TABLE) {
      out.push({ severity: "error", code: "more", table: table.name, message: `${found.path}: ${reported - MAX_PER_TABLE} more problems not shown` });
    }
    loaded.set(table.name, { table, file: found.path, rows });
  }

  // References between files: each foreign key must name an existing row.
  for (const { table, file, rows } of loaded.values()) {
    for (const fk of table.foreignKeys) {
      const target = loaded.get(fk.table);
      if (!target) continue;
      const present = new Set(target.rows.map((r) => JSON.stringify(fk.refColumns.map((c) => r.values[c] ?? null))));
      let reported = 0;
      for (const { row, values } of rows) {
        const ref = fk.columns.map((c) => values[c] ?? null);
        if (ref.every((v) => v === null)) continue;
        if (!present.has(JSON.stringify(ref)) && reported++ < MAX_PER_TABLE) {
          out.push({
            severity: "error",
            code: "dangling-reference",
            table: table.name,
            row,
            message: `${file}:${row}: (${fk.columns.join(", ")}) = ${JSON.stringify(ref)} names no row of ${fk.table}`,
          });
        }
      }
    }
  }

  const expected = new Set(tables.flatMap((t) => FORMATS.map((f) => `${t.name}.${f}`)));
  for (const name of readdirSync(dir)) {
    const format = name.split(".").pop() as Format;
    if (FORMATS.includes(format) && !expected.has(name) && !(single && name.startsWith("_store."))) {
      out.push({ severity: "warning", code: "extra-table", message: `${join(dir, name)} isn't a table in the schema` });
    }
  }
  return out;
}

export const filesBackend: StoreBackend = {
  name: "files",
  accepts: (location) => existsSync(location) && statSync(location).isDirectory(),
  async verify(tables, location) {
    return verifyFiles(tables, location);
  },
};
