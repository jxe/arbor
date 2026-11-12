// A collection's rows read from its SQLite file, in the database layout, as the evaluator
// asks for them: a `for` narrowed by its conditions (and, when they can be stated, its
// ordering and limit), rows by key, and relationships followed by their columns. Nothing
// is read until it is asked for, and each row read once is the same Row after that.
// The in-memory Store is the reference: both answer every view the same.

import type { Database } from "bun:sqlite";
import { PERSON_RELATION, type Column, type Table } from "@ovst/usl";
import { canonical, compareRows, Row, Store, type Cell, type PersonFields, type PrefetchRead, type RowQuery, type StoreSchema } from "../store.ts";
import type { ReadShape } from "../shape.ts";

/** How many relationships deep one statement follows. */
const MAX_NESTING = 4;
/** Reads per statement when a view asks for many at once. */
const BATCH = 100;
/** The prefix of a nested read's key in a row's JSON; no column starts with it. */
const NESTED = "→";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

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

  private select(table: Table, where: string, parameters: unknown[], tail = "", shape?: ReadShape): Row[] {
    if (shape && !shape.empty) {
      // One statement: each row as JSON, with the rows the shape follows from it nested in it.
      const sql = `select ${this.rowJSON(table, "r0", shape, 1)} as row from ${quote(table.name)} as "r0"${where ? ` where ${where}` : ""}${tail}`;
      this.statements.push({ sql, parameters });
      return (this.database.query(sql).all(...(parameters as never[])) as Array<{ row: string }>).map((r) => this.loadJSON(table, JSON.parse(r.row) as Record<string, unknown>));
    }
    const sql = `select * from ${quote(table.name)}${where ? ` where ${where}` : ""}${tail}`;
    this.statements.push({ sql, parameters });
    return (this.database.query(sql).all(...(parameters as never[])) as Record<string, unknown>[]).map((raw) => this.rowOf(table, raw));
  }

  /** The one Row for a table's raw values. */
  private rowOf(table: Table, raw: Record<string, unknown>): Row {
    const columns = new Map(table.columns.map((c) => [c.name, c]));
    const data: Record<string, Cell> = {};
    for (const [name, value] of Object.entries(raw)) if (columns.has(name)) data[name] = loaded(columns.get(name), value);
    const row = new Row(table.stores, table.name, table.primaryKey, data);
    const key = `${table.name}\0${row.keyText}`;
    const known = this.identity.get(key);
    if (known) return known;
    this.identity.set(key, row);
    return row;
  }

  /** The relationship a shape's field follows from rows of `table`, when one statement can read it. */
  private followed(table: Table, field: string) {
    const place = this.schema.place(table.stores, field);
    if (place.kind !== "relationship") return null;
    const r = place.relationship;
    if (r.direct && r.target !== PERSON_RELATION && this.schema.byName.has(r.target)) return r;
    if (r.through && this.schema.byName.has(r.through.relation) && (r.target === PERSON_RELATION || this.schema.byName.has(r.target))) return r;
    return null;
  }

  /** SQL for one row of `table`, aliased `alias`, as a JSON object, with what `shape` follows from it nested. */
  private rowJSON(table: Table, alias: string, shape: ReadShape | undefined, depth: number): string {
    const parts = table.columns.map((c) => `${literal(c.name)}, ${quote(alias)}.${quote(c.name)}`);
    if (shape && depth <= MAX_NESTING) {
      for (const [field, inner] of shape.fields) {
        const r = this.followed(table, field);
        if (!r) continue;
        const b = `r${depth}`;
        let sub: string;
        if (r.direct) {
          const target = this.table(r.target);
          const on = r.direct.map((p) => `${quote(b)}.${quote(p.target)} is ${quote(alias)}.${quote(p.source)}`).join(" and ");
          sub = `select json_group_array(${this.rowJSON(target, b, inner, depth + 1)}) from ${quote(target.name)} as ${quote(b)} where ${on}`;
        } else {
          const through = r.through!;
          const join = this.table(through.relation);
          const on = through.source.map((p) => `${quote(b)}.${quote(p.through)} is ${quote(alias)}.${quote(p.source)}`).join(" and ");
          let far = "null";
          if (r.target !== PERSON_RELATION) {
            const target = this.table(r.target);
            const c = `r${depth}f`;
            const farOn = through.target.map((p) => `${quote(c)}.${quote(p.target)} is ${quote(b)}.${quote(p.through)}`).join(" and ");
            far = `json((select json_group_array(${this.rowJSON(target, c, inner, depth + 1)}) from ${quote(target.name)} as ${quote(c)} where ${farOn}))`;
          }
          sub = `select json_group_array(json_object('join', ${this.rowJSON(join, b, undefined, depth + 1)}, 'far', ${far})) from ${quote(join.name)} as ${quote(b)} where ${on}`;
        }
        parts.push(`${literal(NESTED + field)}, json((${sub}))`);
      }
    }
    return `json_object(${parts.join(", ")})`;
  }

  /** A row read as JSON, and the reads nested in it remembered as their own matches. */
  private loadJSON(table: Table, json: Record<string, unknown>): Row {
    const row = this.rowOf(table, json);
    for (const [name, value] of Object.entries(json)) {
      if (!name.startsWith(NESTED) || !Array.isArray(value)) continue;
      const r = this.followed(table, name.slice(NESTED.length));
      if (!r) continue;
      if (r.direct) {
        const target = this.table(r.target);
        this.remember(target.name, r.direct.map((p) => p.target), r.direct.map((p) => row.data[p.source] ?? null),
          value.map((v) => this.loadJSON(target, v as Record<string, unknown>)));
      } else {
        const through = r.through!;
        const join = this.table(through.relation);
        const joins = (value as Array<{ join: Record<string, unknown>; far: unknown[] | null }>).map((j) => {
          const joinRow = this.rowOf(join, j.join);
          if (r.target !== PERSON_RELATION && Array.isArray(j.far)) {
            const target = this.table(r.target);
            this.remember(target.name, through.target.map((p) => p.target), through.target.map((p) => joinRow.data[p.through] ?? null),
              j.far.map((v) => this.loadJSON(target, v as Record<string, unknown>)));
          }
          return joinRow;
        });
        this.remember(join.name, through.source.map((p) => p.through), through.source.map((p) => row.data[p.source] ?? null), joins);
      }
    }
    return row;
  }

  private matchKey(table: string, columns: readonly string[], values: readonly Cell[]): string {
    return `${table}\0${columns.join("\0")}\0${canonical(values.map((v) => v ?? null))}`;
  }

  /** A match read as part of another statement: the same rows a match of its own would read. */
  private remember(table: string, columns: readonly string[], values: readonly Cell[], rows: Row[]): void {
    const key = this.matchKey(table, columns, values);
    if (!this.found.has(key)) this.found.set(key, rows.sort(compareRows));
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

  override match(table: string, columns: readonly string[], values: readonly Cell[], shape?: ReadShape): readonly Row[] {
    if (table === PERSON_RELATION || this.whole.has(table) || !this.schema.byName.has(table)) return super.match(table, columns, values);
    const key = this.matchKey(table, columns, values);
    let rows = this.found.get(key);
    if (!rows) {
      rows = this.select(this.table(table), columns.map((c) => `${quote(c)} is ?`).join(" and "), values.map(stored), "", shape).sort(compareRows);
      this.found.set(key, rows);
    }
    return rows;
  }

  /** A RowQuery as SQL over its table, and the key its answer is remembered by. */
  private querySQL(table: Table, query: RowQuery): { where: string; parameters: unknown[]; tail: string; key: string } {
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
    return { where, parameters, tail, key: `${table.name}\0?\0${where}\0${canonical(parameters)}\0${tail}` };
  }

  override query(model: string, query: RowQuery, shape?: ReadShape): readonly Row[] | null {
    const name = this.schema.tableOf(model);
    if (!name || name === PERSON_RELATION) return null;
    const table = this.table(name);
    const { where, parameters, tail, key } = this.querySQL(table, query);
    // A query is read once, with what follows from its rows; a later one with another shape reads the rest as asked.
    const known = this.found.get(key);
    if (known) return known;
    const rows = this.select(table, where, parameters, tail, shape).sort(compareRows);
    this.found.set(key, rows);
    return rows;
  }

  /** Every read asked for, in one statement: each one's rows as nested JSON under its own key. */
  override prefetch(reads: readonly PrefetchRead[]): void {
    const parts: string[] = [];
    const parameters: unknown[] = [];
    const after: Array<(value: unknown) => void> = [];
    const rows = (table: Table, where: string, params: unknown[], tail: string, shape: ReadShape | undefined) => {
      parameters.push(...params);
      return `json((select json_group_array(${this.rowJSON(table, "r0", shape, 1)}) from (select * from ${quote(table.name)}${where ? ` where ${where}` : ""}${tail}) as "r0"))`;
    };
    const load = (table: Table, value: unknown) => (Array.isArray(value) ? value : []).map((v) => this.loadJSON(table, v as Record<string, unknown>)).sort(compareRows);
    for (const read of reads) {
      if (read.kind === "people") {
        const union = this.peopleSQL();
        if (!union || this.named) continue;
        parts.push(`json((select json_group_array(id) from (${union})))`);
        after.push((value) => { this.named = new Set((Array.isArray(value) ? value : []).filter((id): id is string => typeof id === "string")); });
        continue;
      }
      const name = this.schema.tableOf(read.model);
      if (!name || name === PERSON_RELATION || !this.schema.byName.has(name)) continue;
      const table = this.table(name);
      if (read.kind === "query") {
        const q = this.querySQL(table, read.query);
        if (this.found.has(q.key)) continue;
        parts.push(rows(table, q.where, q.parameters, q.tail, read.shape));
        after.push((value) => { if (!this.found.has(q.key)) this.found.set(q.key, load(table, value)); });
      } else {
        const columns = this.schema.keyOf(name);
        const values = columns.length === 1 ? [read.key] : columns.map((c) => (read.key as Record<string, Cell> | null)?.[c]);
        if (values.some((v) => v !== null && v !== undefined && typeof v === "object")) continue;
        const key = this.matchKey(name, columns, values);
        if (this.found.has(key)) continue;
        parts.push(rows(table, columns.map((c) => `${quote(c)} is ?`).join(" and "), values.map(stored), "", read.shape));
        after.push((value) => { if (!this.found.has(key)) this.found.set(key, load(table, value)); });
      }
    }
    if (!parts.length) return;
    // SQLite caps a function's arguments (127 by default): a very large view takes more than one statement.
    const params = parameters.slice();
    for (let start = 0; start < parts.length; start += BATCH) {
      const batch = parts.slice(start, start + BATCH);
      const count = batch.reduce((n, part) => n + (part.match(/\?/g)?.length ?? 0), 0);
      const sql = `select json_array(${batch.join(", ")}) as reads`;
      const bound = params.splice(0, count);
      this.statements.push({ sql, parameters: bound });
      const answer = this.database.query(sql).get(...(bound as never[])) as { reads: string };
      (JSON.parse(answer.reads) as unknown[]).forEach((value, i) => after[start + i]!(value));
    }
  }

  /** The people any row names, once read. */
  private named: Set<string> | null = null;

  private peopleSQL(): string | null {
    const parts = this.schema.layout.flatMap((t) => t.columns.filter((c) => c.profile).map((c) => `select ${quote(c.name)} as id from ${quote(t.name)}`));
    return parts.length ? parts.join(" union ") : null;
  }

  /** The profile ids any row names, in one statement over every profile column. */
  protected override peopleNamed(): Set<string> {
    if (this.named) return this.named;
    const sql = this.peopleSQL();
    if (!sql) return (this.named = new Set());
    this.statements.push({ sql, parameters: [] });
    return (this.named = new Set((this.database.query(sql).all() as Array<{ id: unknown }>).flatMap((r) => (typeof r.id === "string" ? [r.id] : []))));
  }

  /** A copy in memory, for a mutation to write to: it reads every table. */
  override clone(): Store {
    const rows = Object.fromEntries(this.schema.layout.map((t) => [t.name, this.rowsOf(t.name).map((r) => ({ ...r.data }))]));
    return new Store(this.schema, rows, this.personFields);
  }
}
