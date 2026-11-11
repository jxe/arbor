// The rows a view reads and a mutation writes (spec 1.5 §3.2, §4): one collection's rows in
// its schema's database layout (USL `layoutOf(…, { store: "database" })`), read along the
// layout's relationships. The same rows are what the host materializes as SQLite, so a plan
// run here and one run as SQL mean the same thing (reading and watching §4.2).
//
// - A row is a `Row`: its table and its stored columns. People are rows of the virtual
//   `Person` table, keyed by profile id, whose other fields come from the caller.
// - An enum value is an `EnumValue`: its name and its schema record (`color` and so on).
// - A to-many read gives distinct rows: in position order for an `ordered` end, otherwise
//   in canonical key order.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  layoutOf,
  relationshipsOf,
  PERSON_RELATION,
  type CheckResult,
  type Relationship,
  type RowsByTable,
  type Table,
} from "@ovst/usl";

export type Cell = unknown;
export type RowData = Record<string, Cell>;

/** One row of a table, or a person. Two rows are the same row when their tables and keys are. */
export class Row {
  constructor(readonly model: string, readonly table: string, readonly key: readonly string[], readonly data: RowData) {}

  /** The key as a reference stores it: the one column's value, or an object of the key columns. */
  get keyValue(): Cell {
    if (this.key.length === 1) return this.data[this.key[0]!];
    return Object.fromEntries(this.key.map((k) => [k, this.data[k]]));
  }

  /** The key as canonical text, to tell rows apart. */
  get keyText(): string {
    return canonical(this.key.map((k) => this.data[k] ?? null));
  }
}

/** A value of an enum: its name and the fields its schema record gives. */
export class EnumValue {
  constructor(readonly enumName: string, readonly name: string, readonly values: Record<string, unknown>) {}
}

/** What a reader knows about a person beyond their profile id: name, handle and so on. */
export type PersonFields = (id: string) => Record<string, unknown> | null;

const encoder = new TextEncoder();
function compareBytes(a: string, b: string): number {
  const x = encoder.encode(a), y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Stable JSON with sorted object keys. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const compareRows = (a: Row, b: Row): number => compareBytes(a.keyText, b.keyText);

/** A UUID derived from `seed`, the form new rows' ids take, so a retried mutation makes the same ids. */
export function derivedID(seed: string): string {
  const value = bytesToHex(sha256(new TextEncoder().encode(seed)));
  const variant = ((Number.parseInt(value[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${variant}${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

/** Where a field of a model's rows is: stored columns, or a relationship to other rows. */
export type FieldPlace =
  | { kind: "column"; column: string }
  | { kind: "reference"; columns: string[]; target: string }
  | { kind: "relationship"; relationship: Relationship }
  | { kind: "none" };

/** A collection's schema as the store reads it: its layout, relationships and enums. */
export class StoreSchema {
  readonly layout: Table[];
  readonly relationships: Relationship[];
  /** Tables by the model or connection they store. */
  readonly byModel = new Map<string, Table>();
  readonly byName = new Map<string, Table>();
  /** Enum values by enum name, in schema order. */
  readonly enums = new Map<string, EnumValue[]>();
  private readonly relationshipsBy = new Map<string, Relationship>();

  constructor(readonly result: CheckResult) {
    this.layout = layoutOf(result, { store: "database" });
    this.relationships = relationshipsOf(result, this.layout);
    for (const t of this.layout) {
      this.byModel.set(t.stores, t);
      this.byName.set(t.name, t);
    }
    for (const r of this.relationships) this.relationshipsBy.set(`${r.source}\0${r.name}`, r);
    for (const m of result.models) {
      if (m.rows !== "fixed") continue;
      this.enums.set(m.name, m.schemaRows.map((row) => new EnumValue(m.name, row.name, (row.values ?? {}) as Record<string, unknown>)));
    }
  }

  /** The table name a model's rows are in: `Person` for people. */
  tableOf(model: string): string | undefined {
    return model === "Person" ? PERSON_RELATION : this.byModel.get(model)?.name;
  }

  keyOf(table: string): string[] {
    return table === PERSON_RELATION ? ["id"] : this.byName.get(table)?.primaryKey ?? ["id"];
  }

  modelOfTable(table: string): string {
    return table === PERSON_RELATION ? "Person" : this.byName.get(table)?.stores ?? table;
  }

  relationship(table: string, field: string): Relationship | undefined {
    return this.relationshipsBy.get(`${table}\0${field}`);
  }

  /** Where `field` of `model`'s rows is held. */
  place(model: string, field: string): FieldPlace {
    const table = this.tableOf(model);
    if (!table) return { kind: "none" };
    const relationship = this.relationship(table, field);
    const stored = this.byModel.get(model)?.fields.find((f) => f.name === field);
    if (stored?.target && stored.target !== "Person" && !this.enums.has(stored.target) && relationship) return { kind: "relationship", relationship };
    if (stored?.target) return { kind: "reference", columns: stored.columns, target: stored.target };
    if (stored) return { kind: "column", column: stored.columns[0]! };
    if (relationship) return { kind: "relationship", relationship };
    if (field === "created" || field === "modified" || field === "id") return { kind: "column", column: field };
    return { kind: "none" };
  }

  /** For a many relationship, the column that orders its members, if its end is `ordered`. */
  positionOf(relationship: Relationship): { table: "target" | "through"; column: string } | undefined {
    if (relationship.through) {
      const join = this.byName.get(relationship.through.relation);
      const end = join?.ends?.find((e) => e.field === relationship.name && this.tableOf(e.model) === relationship.source);
      return end?.position ? { table: "through", column: end.position } : undefined;
    }
    const target = this.byName.get(relationship.target);
    const column = `${relationship.name}_position`;
    return target?.columns.some((c) => c.name === column) ? { table: "target", column } : undefined;
  }

  /** A connection table keyed by its two ends: the end that isn't `from`, if `table` is one. */
  farEnd(table: string, from: string): string | undefined {
    const model = this.result.models.find((m) => m.name === this.modelOfTable(table));
    if (!model || model.ends.length !== 2) return undefined;
    const key = this.keyOf(table);
    const ends = model.ends.map((e) => e.as);
    if (key.length !== 2 || !ends.every((e) => key.includes(e))) return undefined;
    return ends.find((e) => e !== from);
  }
}

/** One collection's rows, indexed on demand, and read along the schema's relationships. */
export class Store {
  private readonly tables = new Map<string, Row[]>();
  private readonly indexes = new Map<string, Map<string, Row[]>>();
  private readonly people = new Map<string, Row>();

  constructor(readonly schema: StoreSchema, rows: RowsByTable, readonly personFields: PersonFields = () => null) {
    for (const t of schema.layout) {
      const list = (rows[t.name] ?? []).map((data) => new Row(t.stores, t.name, t.primaryKey, { ...data }));
      this.tables.set(t.name, list.sort(compareRows));
    }
  }

  /** The rows of a table, in canonical key order. */
  rowsOf(table: string): readonly Row[] {
    return this.tables.get(table) ?? [];
  }

  /** The rows of a model's table; for Person, the people any row names. */
  rows(model: string): readonly Row[] {
    if (model === "Person") return this.allPeople();
    const table = this.schema.tableOf(model);
    return table ? this.rowsOf(table) : [];
  }

  /** Every table's rows as plain data, the form `RowsByTable` takes. */
  data(): RowsByTable {
    return Object.fromEntries([...this.tables].map(([name, rows]) => [name, rows.map((r) => ({ ...r.data }))]));
  }

  person(id: string): Row {
    let row = this.people.get(id);
    if (!row) {
      row = new Row("Person", PERSON_RELATION, ["id"], { ...(this.personFields(id) ?? {}), id });
      this.people.set(id, row);
    }
    return row;
  }

  private allPeople(): Row[] {
    const ids = new Set<string>();
    for (const t of this.schema.layout) {
      for (const c of t.columns) if (c.profile) for (const row of this.rowsOf(t.name)) if (typeof row.data[c.name] === "string") ids.add(row.data[c.name] as string);
    }
    return [...ids].map((id) => this.person(id)).sort(compareRows);
  }

  /** The rows of `table` whose `columns` hold `values`. */
  match(table: string, columns: readonly string[], values: readonly Cell[]): readonly Row[] {
    if (table === PERSON_RELATION) {
      const id = values[columns.indexOf("id")];
      return typeof id === "string" ? [this.person(id)] : [];
    }
    const name = `${table}\0${columns.join("\0")}`;
    let index = this.indexes.get(name);
    if (!index) {
      index = new Map();
      for (const row of this.rowsOf(table)) {
        const key = canonical(columns.map((c) => row.data[c] ?? null));
        const list = index.get(key);
        if (list) list.push(row);
        else index.set(key, [row]);
      }
      this.indexes.set(name, index);
    }
    return index.get(canonical(values.map((v) => v ?? null))) ?? [];
  }

  /** The row of a model with this key: one value, or an object of the key columns. */
  find(model: string, key: Cell): Row | null {
    if (model === "Person") return typeof key === "string" ? this.person(key) : null;
    const table = this.schema.tableOf(model);
    if (!table || key === null || key === undefined) return null;
    const columns = this.schema.keyOf(table);
    const values = columns.length === 1 ? [key] : columns.map((c) => (key as Record<string, Cell>)?.[c]);
    return this.match(table, columns, values)[0] ?? null;
  }

  /** The enum value with this name. */
  enumValue(enumName: string, name: unknown): EnumValue | null {
    if (typeof name !== "string") return null;
    return this.schema.enums.get(enumName)?.find((v) => v.name === name) ?? null;
  }

  /** The rows a relationship reaches from `row`, in its order. */
  follow(row: Row, relationship: Relationship): Row[] {
    const source = (c: string) => row.data[c] ?? null;
    if (relationship.direct) {
      const pairs = relationship.direct;
      if (pairs.some((p) => source(p.source) === null)) return [];
      const found = [...this.match(relationship.target, pairs.map((p) => p.target), pairs.map((p) => source(p.source)))];
      const position = this.schema.positionOf(relationship);
      if (position) found.sort((a, b) => Number(a.data[position.column]) - Number(b.data[position.column]) || compareRows(a, b));
      return found;
    }
    const through = relationship.through!;
    const joins = [...this.match(through.relation, through.source.map((p) => p.through), through.source.map((p) => source(p.source)))];
    const position = this.schema.positionOf(relationship);
    if (position) joins.sort((a, b) => Number(a.data[position.column]) - Number(b.data[position.column]) || compareRows(a, b));
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const join of joins) {
      for (const target of this.match(relationship.target, through.target.map((p) => p.target), through.target.map((p) => join.data[p.through] ?? null))) {
        if (seen.has(target.keyText)) continue;
        seen.add(target.keyText);
        out.push(target);
      }
    }
    return position ? out : out.sort(compareRows);
  }

  // ---------------------------------------------------------------- writing

  /** A copy whose writes leave this store as it is. */
  clone(): Store {
    const copy = new Store(this.schema, {}, this.personFields);
    for (const [name, rows] of this.tables) copy.tables.set(name, rows.map((r) => new Row(r.model, r.table, r.key, { ...r.data })));
    return copy;
  }

  private changed(table: string): void {
    for (const name of [...this.indexes.keys()]) if (name.startsWith(`${table}\0`)) this.indexes.delete(name);
    this.tables.get(table)?.sort(compareRows);
  }

  insert(table: string, data: RowData): Row {
    const t = this.schema.byName.get(table)!;
    const row = new Row(t.stores, t.name, t.primaryKey, data);
    this.tables.get(table)!.push(row);
    this.changed(table);
    return row;
  }

  update(row: Row, values: RowData): void {
    const keyBefore = row.keyText;
    Object.assign(row.data, values);
    if (row.keyText !== keyBefore) throw new Error("A row's key can't change");
    this.changed(row.table);
  }

  /** Delete rows, and what refers to them as the layout's foreign keys say: cascade, set null or refuse. */
  delete(rows: readonly Row[]): void {
    const queue = [...rows];
    while (queue.length) {
      const row = queue.shift()!;
      const list = this.tables.get(row.table);
      const at = list?.indexOf(row) ?? -1;
      if (at < 0) continue;
      list!.splice(at, 1);
      this.changed(row.table);
      for (const t of this.schema.layout) {
        for (const fk of t.foreignKeys) {
          if (fk.table !== row.table) continue;
          const referring = this.match(t.name, fk.columns, fk.refColumns.map((c) => row.data[c] ?? null));
          if (!referring.length) continue;
          if (fk.onDelete === "cascade") queue.push(...referring);
          else if (fk.onDelete === "set null") for (const r of [...referring]) this.update(r, Object.fromEntries(fk.columns.map((c) => [c, null])));
          else throw new StoreRefusal("conflict", `${row.model} is still referred to by ${t.stores}`);
        }
      }
    }
  }
}

/** A write the rows can't take, as a public error code. */
export class StoreRefusal extends Error {
  constructor(readonly code: "conflict" | "invalid", message: string) {
    super(message);
    this.name = "StoreRefusal";
  }
}
