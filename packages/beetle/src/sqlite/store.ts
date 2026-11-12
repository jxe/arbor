// A collection's rows read from its SQLite file, in the database layout, as the evaluator
// asks for them: a `for` narrowed by its conditions (and, when they can be stated, its
// ordering and limit), rows by key, and relationships followed by their columns. Nothing
// is read until it is asked for, and each row read once is the same Row after that.
// The in-memory Store is the reference: both answer every view the same.

import type { Database } from "bun:sqlite";
import { PERSON_RELATION, type Column, type Table } from "@ovst/usl";
import { canonical, compareRows, Row, Store, type Cell, type PersonFields, type RowQuery, type StoreSchema } from "../store.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A value as the layout stores it in SQLite: flags as 0/1. */
function stored(value: Cell): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** A stored value as the row holds it: flags as booleans, value arrays from their JSON text. */
function loaded(column: Column | undefined, value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (column?.type === "bool" && typeof value === "number") return value !== 0;
  if (column?.array && typeof value === "string") return JSON.parse(value);
  return value;
}

export class SQLiteStore extends Store {
  private readonly whole = new Map<string, Row[]>();
  private readonly identity = new Map<string, Row>();
  private readonly found = new Map<string, Row[]>();
  /** Every statement this store ran, for tests and for whoever wants to see the reads. */
  readonly statements: Array<{ sql: string; parameters: unknown[] }> = [];

  /**
   * `database` is open on the collection's file; reads made while a transaction is open
   * on it see one snapshot.
   */
  constructor(schema: StoreSchema, private readonly database: Database, personFields: PersonFields = () => null) {
    super(schema, {}, personFields);
  }

  private table(name: string): Table {
    const t = this.schema.byName.get(name);
    if (!t) throw new Error(`No table ${name}`);
    return t;
  }

  private select(table: Table, where: string, parameters: unknown[], tail = ""): Row[] {
    const sql = `select * from ${quote(table.name)}${where ? ` where ${where}` : ""}${tail}`;
    this.statements.push({ sql, parameters });
    const columns = new Map(table.columns.map((c) => [c.name, c]));
    return (this.database.query(sql).all(...(parameters as never[])) as Record<string, unknown>[]).map((raw) => {
      const data: Record<string, Cell> = {};
      for (const [name, value] of Object.entries(raw)) data[name] = loaded(columns.get(name), value);
      const row = new Row(table.stores, table.name, table.primaryKey, data);
      const key = `${table.name}\0${row.keyText}`;
      const known = this.identity.get(key);
      if (known) return known;
      this.identity.set(key, row);
      return row;
    });
  }

  override rowsOf(table: string): readonly Row[] {
    let rows = this.whole.get(table);
    if (!rows) {
      if (!this.schema.byName.has(table)) return [];
      rows = this.select(this.table(table), "", []).sort(compareRows);
      this.whole.set(table, rows);
    }
    return rows;
  }

  override match(table: string, columns: readonly string[], values: readonly Cell[]): readonly Row[] {
    if (table === PERSON_RELATION || this.whole.has(table) || !this.schema.byName.has(table)) return super.match(table, columns, values);
    const key = `${table}\0${columns.join("\0")}\0${canonical(values.map((v) => v ?? null))}`;
    let rows = this.found.get(key);
    if (!rows) {
      rows = this.select(this.table(table), columns.map((c) => `${quote(c)} is ?`).join(" and "), values.map(stored)).sort(compareRows);
      this.found.set(key, rows);
    }
    return rows;
  }

  override query(model: string, query: RowQuery): readonly Row[] | null {
    const name = this.schema.tableOf(model);
    if (!name || name === PERSON_RELATION) return null;
    const table = this.table(name);
    const where = query.where.map((c) => `${quote(c.column)} ${c.op === "=" ? "is" : "is not"} ?`).join(" and ");
    const parameters = query.where.map((c) => stored(c.value));
    // The evaluator's order: nulls last ascending (first descending), ties in key order. A
    // key of text columns sorts as its canonical text does, so only then can the limit hold.
    const text = table.primaryKey.every((k) => table.columns.find((c) => c.name === k)?.type === "text");
    let tail = "";
    if (query.limit !== undefined && text) {
      const terms = query.order.map((o) => `(${quote(o.column)} is null)${o.desc ? " desc" : ""}, ${quote(o.column)}${o.desc ? " desc" : ""}`);
      terms.push(...table.primaryKey.map((k) => quote(k)));
      tail = ` order by ${terms.join(", ")} limit ${query.limit}`;
    }
    return this.select(table, where, parameters, tail).sort(compareRows);
  }

  /** A copy in memory, for a mutation to write to: it reads every table. */
  override clone(): Store {
    const rows = Object.fromEntries(this.schema.layout.map((t) => [t.name, this.rowsOf(t.name).map((r) => ({ ...r.data }))]));
    return new Store(this.schema, rows, this.personFields);
  }
}
