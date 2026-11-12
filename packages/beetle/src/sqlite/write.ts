// A mutation's writes as SQL (Performance 007): a store over a connection with a
// transaction open on a collection's database, whose inserts, updates and deletes run as
// statements in that transaction and whose reads see them. It records each row it
// changed, before and after, so the mutation's row operations come from the rows it
// wrote. Whoever opened the transaction commits it when the mutation's update is
// accepted, and rolls it back otherwise. Deletes follow the layout's foreign keys here,
// as the in-memory overlay does, so the connection runs with SQLite's own checks off.

import type { Database } from "bun:sqlite";
import { PERSON_RELATION, type Column, type RowsByTable, type Table } from "@ovst/usl";
import { canonical, compareRows, Row, Store, StoreRefusal, type Cell } from "../store.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A row value as the database layout stores it: flags as 0/1, value arrays as JSON text, an absent array as `[]`. */
function stored(column: Column | undefined, value: Cell): unknown {
  if (value === undefined || value === null) return column?.array && !column.nullable ? "[]" : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/** A stored value as a row holds it. */
function loaded(column: Column | undefined, value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (column?.type === "bool" && typeof value === "number") return value !== 0;
  if (column?.array && typeof value === "string") return JSON.parse(value);
  return value;
}

export type RowEdit = { table: string; before: Row | null; after: Row | null };

export class SQLiteWriteStore extends Store {
  /** Each written row's first and latest state, by table and key text. */
  private readonly written = new Map<string, Map<string, { before: Row | null; after: Row | null }>>();
  /** Times the database filled in on rows this transaction inserted, by table and key text: not the rows' own. */
  private readonly filled = new Map<string, Map<string, string[]>>();
  /** Statements run, for tests. */
  readonly statements: string[] = [];

  /**
   * `base` reads the same rows as they were (people come from it); `database` is a
   * connection of its own on the collection's file, with a write transaction open
   * (`begin immediate`) and `pragma foreign_keys = off`.
   */
  constructor(readonly base: Store, private readonly database: Database) {
    super(base.schema, {}, base.personFields);
  }

  override person(id: string): Row {
    return this.base.person(id);
  }

  override data(): RowsByTable {
    return Object.fromEntries(this.schema.layout.map((t) => [t.name, this.rowsOf(t.name).map((r) => ({ ...r.data }))]));
  }

  private table(name: string): Table {
    const t = this.schema.byName.get(name);
    if (!t) throw new Error(`No table ${name}`);
    return t;
  }

  private rowOf(table: Table, raw: Record<string, unknown>): Row {
    const data: Record<string, Cell> = {};
    for (const column of table.columns) if (column.name in raw) data[column.name] = loaded(column, raw[column.name]);
    const row = new Row(table.stores, table.name, table.primaryKey, data);
    for (const name of this.filled.get(table.name)?.get(row.keyText) ?? []) delete row.data[name];
    return row;
  }

  private select(table: Table, columns: readonly string[], values: readonly Cell[]): Row[] {
    const byName = new Map(table.columns.map((c) => [c.name, c]));
    const where = columns.map((c) => `${quote(c)} is ?`).join(" and ");
    const sql = `select * from ${quote(table.name)}${where ? ` where ${where}` : ""}`;
    this.statements.push(sql);
    const rows = (this.database.query(sql).all(...columns.map((c, i) => storedKey(byName.get(c), values[i])) as never[]) as Record<string, unknown>[]);
    return rows.map((raw) => this.rowOf(table, raw)).sort(compareRows);
  }

  override rowsOf(table: string): readonly Row[] {
    return this.select(this.table(table), [], []);
  }

  override match(table: string, columns: readonly string[], values: readonly Cell[]): readonly Row[] {
    if (table === PERSON_RELATION) return super.match(table, columns, values);
    return this.select(this.table(table), columns, values);
  }

  override query(): null {
    return null;
  }

  override clone(): Store {
    throw new Error("A SQLite write store is written in place");
  }

  /** Note a row's state after a write, keeping the state it had before the first. */
  private note(table: string, keyText: string, before: Row | null, after: Row | null): void {
    let rows = this.written.get(table);
    if (!rows) this.written.set(table, (rows = new Map()));
    const was = rows.get(keyText);
    rows.set(keyText, { before: was ? was.before : before, after });
  }

  private keyOf(table: Table, row: Row | Record<string, Cell>): Cell[] {
    const data = row instanceof Row ? row.data : row;
    return table.primaryKey.map((k) => data[k] ?? null);
  }

  override insert(table: string, data: Record<string, Cell>): Row {
    const t = this.table(table);
    const columns = t.columns.filter((c) => c.name in data || (c.array && !c.nullable));
    const sql = `insert into ${quote(t.name)} (${columns.map((c) => quote(c.name)).join(", ")}) values (${columns.map(() => "?").join(", ")}) returning *`;
    this.statements.push(sql);
    let raw: Record<string, unknown>;
    try {
      raw = this.database.query(sql).get(...columns.map((c) => stored(c, data[c.name])) as never[]) as Record<string, unknown>;
    } catch (error) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(error))) throw new StoreRefusal("conflict", `${t.stores} already has that row`);
      throw error;
    }
    // A time the database filled in isn't the row's: like a row written in memory, it has none until it is stamped.
    const filled = t.columns.filter((c) => c.type === "timestamp" && !(c.name in data)).map((c) => c.name);
    if (filled.length) {
      let rows = this.filled.get(t.name);
      if (!rows) this.filled.set(t.name, (rows = new Map()));
      rows.set(canonical(this.keyOf(t, Object.fromEntries(t.primaryKey.map((k) => [k, loaded(t.columns.find((c) => c.name === k), raw[k])])))), filled);
    }
    const row = this.rowOf(t, raw);
    this.note(t.name, row.keyText, null, row);
    return row;
  }

  override update(row: Row, values: Record<string, Cell>): void {
    const t = this.table(row.table);
    const before = this.select(t, t.primaryKey, this.keyOf(t, row))[0] ?? null;
    if (!before) throw new Error(`${row.model} ${row.keyText} isn't there to update`);
    const after = new Row(row.model, row.table, row.key, { ...before.data, ...values });
    if (after.keyText !== before.keyText) throw new Error("A row's key can't change");
    const set = Object.keys(values).filter((c) => t.columns.some((col) => col.name === c));
    if (set.length) {
      const byName = new Map(t.columns.map((c) => [c.name, c]));
      const sql = `update ${quote(t.name)} set ${set.map((c) => `${quote(c)} = ?`).join(", ")} where ${t.primaryKey.map((k) => `${quote(k)} is ?`).join(" and ")} returning *`;
      this.statements.push(sql);
      const raw = this.database.query(sql).get(...set.map((c) => stored(byName.get(c), values[c])) as never[], ...this.keyOf(t, before).map((v, i) => storedKey(byName.get(t.primaryKey[i]!), v)) as never[]) as Record<string, unknown>;
      this.note(t.name, before.keyText, before, this.rowOf(t, raw));
    }
    Object.assign(row.data, values);
  }

  /** Delete rows, and what refers to them as the layout's foreign keys say: cascade, set null or refuse. */
  override delete(rows: readonly Row[]): void {
    const queue = [...rows];
    while (queue.length) {
      const row = queue.shift()!;
      const t = this.table(row.table);
      const present = this.select(t, t.primaryKey, this.keyOf(t, row))[0];
      if (!present) continue;
      const byName = new Map(t.columns.map((c) => [c.name, c]));
      const sql = `delete from ${quote(t.name)} where ${t.primaryKey.map((k) => `${quote(k)} is ?`).join(" and ")}`;
      this.statements.push(sql);
      this.database.query(sql).run(...this.keyOf(t, present).map((v, i) => storedKey(byName.get(t.primaryKey[i]!), v)) as never[]);
      this.note(t.name, present.keyText, present, null);
      for (const other of this.schema.layout) {
        for (const fk of other.foreignKeys) {
          if (fk.table !== t.name) continue;
          const referring = this.match(other.name, fk.columns, fk.refColumns.map((c) => present.data[c] ?? null));
          if (!referring.length) continue;
          if (fk.onDelete === "cascade") queue.push(...referring);
          else if (fk.onDelete === "set null") for (const r of referring) this.update(r, Object.fromEntries(fk.columns.map((c) => [c, null])));
          else throw new StoreRefusal("conflict", `${row.model} is still referred to by ${other.stores}`);
        }
      }
    }
  }

  /** Each row the writes changed: its state before them (null if new) and after (null if deleted). */
  edits(): RowEdit[] {
    const out: RowEdit[] = [];
    for (const [table, rows] of this.written) {
      for (const { before, after } of rows.values()) {
        if (!before && !after) continue;
        if (before && after && canonical(before.data) === canonical(after.data)) continue;
        out.push({ table, before, after });
      }
    }
    return out;
  }
}

/** A key or match value as SQLite compares it. */
function storedKey(_column: Column | undefined, value: Cell): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}
