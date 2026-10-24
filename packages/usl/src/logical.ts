// The logical form of a collection's rows (spec 06 §2.2): what the tree holds,
// whatever a placement stores them in. One table per model with data rows;
// each row is its key as `[field, value]` pairs, its stored fields, and its
// timestamps.
//
// - A value field holds its value; an unordered value array is a set, sorted.
// - A connection is held once. An end marked `ordered` holds the sequence of
//   its members' keys. Otherwise a 1:1 or 1:n connection is a reference on
//   its single side, and a plain n:m connection is the set of member keys on
//   its first end that has rows. The other end's field is derived.
// - A connection model's rows hold their ends as references; the models they
//   connect derive their fields, unless the end is `ordered`.
// - A reference is the target's key value: its one key field's value, or its
//   pairs when the key has several fields. A person is a profile id, an enum
//   value its name.
//
// `logicalFromRows` and `rowsFromLogical` convert between this form and the
// rows of a layout's tables, so every projection goes through one path.

import type { Arity } from "./ast.ts";
import type { CheckResult, ResolvedModel } from "./check.ts";
import type { Table } from "./layout.ts";
import { recordsFromRows, rowsFromRecords, type RecordsByModel, type RowsByTable, type StoredRecord } from "./records.ts";

export type LogicalValue = null | boolean | number | string | LogicalValue[];

export interface LogicalRow {
  key: [string, LogicalValue][];
  fields: Record<string, LogicalValue>;
  created: string;
  modified: string;
}

/** Rows by model name, each table in stable-key order. */
export type LogicalTables = Record<string, LogicalRow[]>;

export interface LogicalField {
  name: string;
  /** A value type, a model, an enum or `Person`. */
  type: string;
  arity: Arity;
  /** `value` (or a value array), `reference` to one row, or `members`: the keys of a connection's other end. */
  kind: "value" | "reference" | "members";
  /** `members` and value arrays: a sequence rather than a set. */
  ordered: boolean;
}

export interface LogicalModel {
  name: string;
  key: string[];
  /** Key fields, in key order. `id` is a `Text` value. */
  keyFields: LogicalField[];
  /** Every other stored field, in the model's field order. */
  fields: LogicalField[];
  /** The field naming each row in the tree (`path`), if any. */
  path?: string;
}

const VALUE_TYPES = new Set(["Text", "Markdown", "Int", "Number", "Bool", "Date"]);
const compareText = (a: string, b: string) => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};

/** Where a connection field's data is held, from the model that has the field. */
function holding(result: CheckResult, model: ResolvedModel, field: string): "here" | "elsewhere" {
  const hasRows = (name: string) => name !== "Person" && result.models.find((m) => m.name === name)?.rows !== "fixed";
  for (const c of result.connections) {
    const here = c.a.model === model.name && c.a.field === field ? c.a : c.b.model === model.name && c.b.field === field ? c.b : null;
    if (!here) continue;
    const other = here === c.a ? c.b : c.a;
    if (here.ordered) return "here";
    if (other.ordered) return "elsewhere";
    if (here.arity === "many" && other.arity === "many") {
      const first = [c.a, c.b].find((e) => hasRows(e.model));
      return first === here ? "here" : "elsewhere";
    }
    if (here.arity === "many") return "elsewhere";
    if (other.arity === "many") return "here";
    // 1:1: where the layout puts the column.
    return c.storage.kind === "column" && c.storage.on === here.model && c.storage.field === here.field ? "here" : "elsewhere";
  }
  // An end of a connection model: its rows hold it, unless the end is ordered.
  for (const m of result.models) {
    const end = m.ends.find((e) => e.model === model.name && e.field === field);
    if (end) return end.ordered ? "here" : "elsewhere";
  }
  return "elsewhere";
}

/** The models with data rows and the fields their logical rows hold, in UTF-8 order of name. */
export function logicalModels(result: CheckResult): LogicalModel[] {
  if (result.diagnostics.length > 0) throw new Error("The schema has errors; check it first");
  const out: LogicalModel[] = [];
  for (const model of result.models) {
    if (model.name === "Person" || model.rows === "fixed") continue;
    const fields: LogicalField[] = [];
    const keyFields: LogicalField[] = model.key.map((k) => {
      if (k === "id") return { name: "id", type: "Text", arity: "one", kind: "value", ordered: false };
      const f = model.fields.find((x) => x.name === k)!;
      return { name: k, type: f.type, arity: "one", kind: VALUE_TYPES.has(f.type) ? "value" : "reference", ordered: false };
    });
    for (const f of model.fields) {
      if (model.key.includes(f.name)) continue;
      if (VALUE_TYPES.has(f.type)) {
        fields.push({ name: f.name, type: f.type, arity: f.arity, kind: "value", ordered: f.ordered });
      } else if (f.origin === "end") {
        fields.push({ name: f.name, type: f.type, arity: "one", kind: "reference", ordered: false });
      } else if (holding(result, model, f.name) === "here") {
        fields.push({ name: f.name, type: f.type, arity: f.arity, kind: f.arity === "many" ? "members" : "reference", ordered: f.ordered });
      }
    }
    out.push({ name: model.name, key: model.key, keyFields, fields, ...(model.path ? { path: model.path } : {}) });
  }
  return out.sort((a, b) => compareText(a.name, b.name));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Sorts and dedupes a set's members by their canonical JSON. */
function asSet(values: LogicalValue[]): LogicalValue[] {
  const byText = new Map(values.map((v) => [JSON.stringify(v), v]));
  return [...byText.keys()].sort(compareText).map((k) => byText.get(k)!);
}

export function compareLogicalRows(a: Pick<LogicalRow, "key">, b: Pick<LogicalRow, "key">): number {
  return compareText(JSON.stringify(a.key), JSON.stringify(b.key));
}

class Converter {
  readonly models = new Map<string, LogicalModel>();
  readonly resolved = new Map<string, ResolvedModel>();
  readonly tables = new Map<string, Table>();

  constructor(
    readonly result: CheckResult,
    readonly layout: Table[],
  ) {
    for (const m of logicalModels(result)) this.models.set(m.name, m);
    for (const m of result.models) this.resolved.set(m.name, m);
    for (const t of layout) if (!t.ends) this.tables.set(t.stores, t);
  }

  /** The column names a record uses for `target`'s key, beside the field names the logical key uses. */
  private keyColumns(target: string): { field: string; column: string }[] {
    const table = this.tables.get(target);
    const model = this.models.get(target);
    if (!table || !model) return [{ field: "id", column: "id" }];
    return model.key.map((k) => {
      const columns = table.fields.find((f) => f.name === k)?.columns ?? [k];
      if (columns.length !== 1) throw new Error(`\`${target}.${k}\` refers to a key of several fields, which logical collections don't hold yet`);
      return { field: k, column: columns[0]! };
    });
  }

  /** A record's reference (one value, or an object of key columns) as a logical key value. */
  referenceIn(target: string, value: unknown): LogicalValue {
    if (!this.tables.has(target)) return value as LogicalValue;
    const columns = this.keyColumns(target);
    if (columns.length === 1) return value as LogicalValue;
    if (!isObject(value)) return value as LogicalValue;
    return columns.map(({ field, column }) => [field, value[column] as LogicalValue]);
  }

  /** A logical key value as a record's reference. */
  referenceOut(target: string, value: LogicalValue): unknown {
    if (!this.tables.has(target)) return value;
    const columns = this.keyColumns(target);
    if (columns.length === 1 || !Array.isArray(value)) return value;
    const pairs = new Map(value.map((p) => (Array.isArray(p) ? [p[0] as string, p[1]] : ["", p])));
    return Object.fromEntries(columns.map(({ field, column }) => [column, pairs.get(field) ?? null]));
  }

  /** A record's key as the value a reference to it holds: one field's value, or the pairs. */
  keyValue(model: LogicalModel, record: StoredRecord): LogicalValue {
    const key = this.keyOf(model, record);
    return key.length === 1 ? key[0]![1] : key;
  }

  keyOf(model: LogicalModel, record: StoredRecord): [string, LogicalValue][] {
    return model.keyFields.map((f) => [f.name, f.kind === "reference" ? this.referenceIn(f.type, record[f.name]) : (record[f.name] as LogicalValue)]);
  }
}

/** Reads a timestamp column's value as RFC 3339 UTC with milliseconds, or null. */
function timestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || value === "") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export interface FromRowsOptions {
  /** The time given to rows that store no `created` or `modified`, in RFC 3339 UTC. */
  now: string;
}

/**
 * The logical tables that rows of `layout` (a `layoutOf` result) hold. Rows a
 * store doesn't time get `options.now`. Values are taken as the store gives
 * them; validating them against the schema is the caller's.
 */
export function logicalFromRows(result: CheckResult, layout: Table[], rows: RowsByTable, options: FromRowsOptions): LogicalTables {
  const c = new Converter(result, layout);
  const records = recordsFromRows(layout, rows, { timestamps: true });
  // Each n:m connection's pairs, from whichever end a store carries them on,
  // as members by "Model.field" and the row's key value text.
  const members = new Map<string, Map<string, LogicalValue[]>>();
  const add = (id: string, key: LogicalValue, member: LogicalValue) => {
    if (!members.has(id)) members.set(id, new Map());
    const byKey = members.get(id)!;
    const text = JSON.stringify(key);
    byKey.set(text, [...(byKey.get(text) ?? []), member]);
  };
  for (const conn of result.connections) {
    if (conn.a.arity !== "many" || conn.b.arity !== "many") continue;
    for (const [end, other] of [[conn.a, conn.b], [conn.b, conn.a]] as const) {
      const model = c.models.get(end.model);
      if (!model) continue;
      for (const record of records[end.model] ?? []) {
        const list = record[end.field];
        if (!Array.isArray(list)) continue;
        const self = c.keyValue(model, record);
        for (const item of list) {
          const member = c.referenceIn(other.model, item);
          add(`${end.model}.${end.field}`, self, member);
          add(`${other.model}.${other.field}`, member, self);
        }
      }
    }
  }
  // An ordered end of a connection model: its rows, in position order, are the members.
  for (const conn of result.models) {
    const model = c.models.get(conn.name);
    if (!model) continue;
    for (const end of conn.ends.filter((e) => e.ordered)) {
      const position = `${end.field}_position`;
      const ordered = [...(records[conn.name] ?? [])].sort((x, y) => Number(x[position]) - Number(y[position]));
      for (const record of ordered) {
        add(`${end.model}.${end.field}`, c.referenceIn(end.model, record[end.as]), c.keyValue(model, record));
      }
    }
  }
  const out: LogicalTables = {};
  for (const model of c.models.values()) {
    const rowsOut: LogicalRow[] = [];
    for (const record of records[model.name] ?? []) {
      const key = c.keyOf(model, record);
      const keyText = JSON.stringify(c.keyValue(model, record));
      const fields: Record<string, LogicalValue> = {};
      for (const f of model.fields) {
        let value: unknown = record[f.name];
        if (f.kind === "members") {
          // The row's own array keeps its order; otherwise the pairs the other end carries.
          value = Array.isArray(value) ? value.map((v) => c.referenceIn(f.type, v)) : (members.get(`${model.name}.${f.name}`)?.get(keyText) ?? []);
          if (f.ordered) value = [...new Map((value as LogicalValue[]).map((v) => [JSON.stringify(v), v])).values()];
        } else if (f.kind === "reference") {
          value = value === undefined || value === null ? value : c.referenceIn(f.type, value);
        }
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          if (value.length === 0) continue;
          fields[f.name] = f.ordered ? (value as LogicalValue[]) : asSet(value as LogicalValue[]);
        } else {
          fields[f.name] = value as LogicalValue;
        }
      }
      const created = timestamp(record.created) ?? options.now;
      const modified = timestamp(record.modified) ?? created;
      rowsOut.push({ key, fields, created, modified });
    }
    out[model.name] = rowsOut.sort(compareLogicalRows);
  }
  return out;
}

/**
 * The rows of `layout`'s tables that hold `tables`. Every n:m connection gets
 * its arrays on both ends first, so any layout can store it; timestamps go to
 * the `created` and `modified` columns.
 */
export function rowsFromLogical(result: CheckResult, layout: Table[], tables: LogicalTables): RowsByTable {
  const c = new Converter(result, layout);
  const records: RecordsByModel = {};
  const byKey = new Map<string, Map<string, StoredRecord>>();
  for (const model of c.models.values()) {
    const list: StoredRecord[] = [];
    const index = new Map<string, StoredRecord>();
    for (const row of tables[model.name] ?? []) {
      const record: StoredRecord = {};
      for (const [name, value] of row.key) {
        const f = model.keyFields.find((k) => k.name === name);
        record[name] = f?.kind === "reference" ? c.referenceOut(f.type, value) : value;
      }
      for (const f of model.fields) {
        const value = row.fields[f.name];
        if (value === undefined) continue;
        if (f.kind === "reference") record[f.name] = c.referenceOut(f.type, value);
        else if (f.kind === "members") record[f.name] = (value as LogicalValue[]).map((v) => c.referenceOut(f.type, v));
        else record[f.name] = value;
      }
      record.created = row.created;
      record.modified = row.modified;
      list.push(record);
      index.set(JSON.stringify(row.key.length === 1 ? row.key[0]![1] : row.key), record);
    }
    records[model.name] = list;
    byKey.set(model.name, index);
  }
  // The derived end of each n:m connection, so a layout carrying it there can store it.
  for (const conn of result.connections) {
    if (conn.a.arity !== "many" || conn.b.arity !== "many") continue;
    for (const [end, other] of [[conn.a, conn.b], [conn.b, conn.a]] as const) {
      const model = c.models.get(end.model);
      if (!model || !model.fields.some((f) => f.name === end.field && f.kind === "members")) continue;
      const others = byKey.get(other.model);
      if (!others) continue;
      for (const record of others.values()) record[other.field] ??= [];
      for (const row of tables[end.model] ?? []) {
        const self = c.referenceOut(end.model, row.key.length === 1 ? row.key[0]![1] : row.key);
        for (const member of (row.fields[end.field] as LogicalValue[] | undefined) ?? []) {
          (others.get(JSON.stringify(member))?.[other.field] as unknown[] | undefined)?.push(self);
        }
      }
    }
  }
  // An ordered end of a connection model: positions on its rows, from the holder's sequence.
  for (const conn of result.models) {
    for (const end of conn.ends.filter((e) => e.ordered)) {
      const rows = byKey.get(conn.name);
      if (!rows) continue;
      for (const holder of tables[end.model] ?? []) {
        ((holder.fields[end.field] as LogicalValue[] | undefined) ?? []).forEach((member, i) => {
          const record = rows.get(JSON.stringify(member));
          if (record) record[`${end.field}_position`] = i;
        });
      }
    }
  }
  return rowsFromRecords(layout, records);
}
