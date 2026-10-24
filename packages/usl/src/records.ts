// Records and the rows that store them. A record is a row as an app sees it:
// a model's fields by name, a reference as the key of the row it names, and an
// n:m connection as an array of keys. Stores hold rows of the tables
// `layoutOf` gives, so a store adaptor converts with these both ways.
//
// - A key with one column is that column's value; a longer key is an object of
//   the target table's key columns.
// - An n:m connection's array is on its `@fold` end, as data files keep it, or
//   on both ends when neither is folded. An `ordered` end's array is in order.
// - The many side of a 1:n connection isn't part of a record; it is the rows
//   whose reference names this one.
// - Columns that hold no field (timestamps, positions) keep their names.

import type { JoinEnd, StoredField, Table } from "./layout.ts";

/** A model's fields by name. */
export type StoredRecord = Record<string, unknown>;
/** Records by model name. */
export type RecordsByModel = Record<string, StoredRecord[]>;
/** Rows by table name. */
export type RowsByTable = Record<string, Record<string, unknown>[]>;

export interface RecordOptions {
  /** Keep `created` and `modified` on records read from rows. Off by default. */
  timestamps?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a stored key: one column's value, or an object of `keyColumns`. */
function readKey(row: Record<string, unknown>, columns: string[], keyColumns: string[]): unknown {
  if (columns.length === 1) return row[columns[0]!];
  return Object.fromEntries(keyColumns.map((k, i) => [k, row[columns[i]!]]));
}

/** Writes a key into `columns` of `row`. */
function writeKey(row: Record<string, unknown>, columns: string[], keyColumns: string[], key: unknown) {
  if (columns.length === 1) {
    row[columns[0]!] = key;
    return;
  }
  const value = isObject(key) ? key : {};
  columns.forEach((c, i) => (row[c] = key === null ? null : value[keyColumns[i]!]));
}

class Tables {
  readonly byModel = new Map<string, Table>();
  readonly joins: Table[] = [];
  constructor(tables: Table[]) {
    for (const t of tables) (t.ends ? this.joins.push(t) : this.byModel.set(t.stores, t));
  }
  /** The column names a model's key goes by: its table's primary key, or `id` for Person and fixed rows. */
  keyColumns(model: string | undefined): string[] {
    return (model && this.byModel.get(model)?.primaryKey) || ["id"];
  }
  keyColumnsOf(field: StoredField): string[] {
    return field.target ? this.keyColumns(field.target) : field.columns;
  }
  /** Which ends of a join table carry its array on records. */
  carriers(join: Table): JoinEnd[] {
    const ends = join.ends!.filter((e) => this.byModel.has(e.model));
    const folded = ends.filter((e) => e.fold);
    return folded.length > 0 ? folded : ends;
  }
}

/** The row of `table` (a model's table) that stores `record`. Fields the record leaves out are left out, so a partial record gives a partial row. */
export function rowOf(tables: Table[] | Tables, table: Table, record: StoredRecord): Record<string, unknown> {
  const t = tables instanceof Tables ? tables : new Tables(tables);
  const row: Record<string, unknown> = {};
  const held = new Set<string>();
  for (const field of table.fields) {
    field.columns.forEach((c) => held.add(c));
    if (!(field.name in record)) continue;
    const value = record[field.name];
    if (field.target && !Array.isArray(value)) writeKey(row, field.columns, t.keyColumnsOf(field), value);
    else row[field.columns[0]!] = value;
  }
  for (const column of table.columns) {
    if (!held.has(column.name) && column.name in record) row[column.name] = record[column.name];
  }
  return row;
}

/** The record `row` of `table` (a model's table) stores. */
export function recordOf(tables: Table[] | Tables, table: Table, row: Record<string, unknown>, options: RecordOptions = {}): StoredRecord {
  const t = tables instanceof Tables ? tables : new Tables(tables);
  const record: StoredRecord = {};
  const held = new Set<string>();
  for (const field of table.fields) {
    field.columns.forEach((c) => held.add(c));
    const columns = table.columns.filter((c) => field.columns.includes(c.name));
    if (columns.length === 0 || !columns.some((c) => c.name in row)) continue;
    record[field.name] = field.target && !columns[0]!.array ? readKey(row, field.columns, t.keyColumnsOf(field)) : row[field.columns[0]!];
  }
  for (const column of table.columns) {
    if (held.has(column.name) || !(column.name in row)) continue;
    if (column.type === "timestamp" && !options.timestamps) continue;
    record[column.name] = row[column.name];
  }
  for (const column of table.columns) {
    const field = table.fields.find((f) => f.columns.length === 1 && f.columns[0] === column.name);
    const name = field?.name ?? column.name;
    if (name in record) record[name] = fromStored(record[name], column.type, column.array);
  }
  return record;
}

/** Normalizes what a driver returns: Date objects, SQLite's 0/1 flags and JSON-text arrays. */
function fromStored(value: unknown, type: string, array: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (array && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value instanceof Date) return type === "date" ? value.toISOString().slice(0, 10) : value.toISOString();
  if (type === "bool" && typeof value === "number") return value !== 0;
  return value;
}

/** The join-table rows that connect the `model` row keyed `key` to `members`, through the join table's end `end`. */
export function joinRowsOf(tables: Table[] | Tables, join: Table, end: JoinEnd, key: unknown, members: unknown[]): Record<string, unknown>[] {
  const t = tables instanceof Tables ? tables : new Tables(tables);
  const other = join.ends![0] === end ? join.ends![1] : join.ends![0];
  return members.map((member, i) => {
    const row: Record<string, unknown> = {};
    writeKey(row, end.columns, t.keyColumns(end.model), key);
    writeKey(row, other.columns, t.keyColumns(other.model), member);
    if (end.position) row[end.position] = i;
    return row;
  });
}

/** Rows for every table, from records by model. */
export function rowsFromRecords(tables: Table[], records: RecordsByModel): RowsByTable {
  const t = new Tables(tables);
  const out: RowsByTable = {};
  for (const [model, table] of t.byModel) out[table.name] = (records[model] ?? []).map((r) => rowOf(t, table, r));
  for (const join of t.joins) {
    const rows = new Map<string, Record<string, unknown>>();
    for (const end of t.carriers(join)) {
      const table = t.byModel.get(end.model)!;
      for (const record of records[end.model] ?? []) {
        const members = record[end.field];
        if (!Array.isArray(members)) continue;
        const key = readKey(rowOf(t, table, record), table.primaryKey, table.primaryKey);
        for (const row of joinRowsOf(t, join, end, key, members)) {
          const id = JSON.stringify(join.primaryKey.map((c) => row[c]));
          rows.set(id, { ...rows.get(id), ...row });
        }
      }
    }
    out[join.name] = [...rows.values()];
  }
  return out;
}

/** Records by model, from rows by table. */
export function recordsFromRows(tables: Table[], rows: RowsByTable, options: RecordOptions = {}): RecordsByModel {
  const t = new Tables(tables);
  const out: RecordsByModel = {};
  const byKey = new Map<string, Map<string, StoredRecord>>();
  for (const [model, table] of t.byModel) {
    const records = (rows[table.name] ?? []).map((row) => [row, recordOf(t, table, row, options)] as const);
    out[model] = records.map(([, r]) => r);
    byKey.set(model, new Map(records.map(([row, r]) => [JSON.stringify(table.primaryKey.map((c) => row[c])), r])));
  }
  for (const join of t.joins) {
    for (const end of t.carriers(join)) {
      const other = join.ends![0] === end ? join.ends![1] : join.ends![0];
      const records = byKey.get(end.model)!;
      for (const record of records.values()) record[end.field] = [];
      const joinRows = [...(rows[join.name] ?? [])];
      if (end.position) joinRows.sort((x, y) => Number(x[end.position!]) - Number(y[end.position!]));
      for (const row of joinRows) {
        const record = records.get(JSON.stringify(end.columns.map((c) => row[c])));
        (record?.[end.field] as unknown[] | undefined)?.push(readKey(row, other.columns, t.keyColumns(other.model)));
      }
    }
  }
  return out;
}
