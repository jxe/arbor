// A collection's rows read from its SQLite file, in the database layout, as the evaluator
// asks for them: a `for` narrowed by its conditions (and, when they can be stated, its
// ordering and limit), rows by key, and relationships followed by their columns. Nothing
// is read until it is asked for, and each row read once is the same Row after that.
// The in-memory Store is the reference: both answer every view the same.

import type { Database } from "bun:sqlite";
import { PERSON_RELATION, type Column, type Table } from "@ovst/usl";
import { canonical, compareRows, Row, Store, type Cell, type PersonFields, type PrefetchRead, type RowQuery, type StoreSchema } from "../store.ts";
import type { CorrelatedRead, ReadShape } from "../shape.ts";
import type { Expr } from "../ast.ts";
import { renderCondition, sqlValue, translateWhere, truthyCondition, type Condition, type LeafValue, type SQLType } from "../sql.ts";

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
      return (this.database.query(sql).all(...(parameters as never[])) as Array<{ row: string }>).map((r) => this.loadJSON(table, JSON.parse(r.row) as Record<string, unknown>, shape));
    }
    const sql = `select * from ${quote(table.name)} as "r0"${where ? ` where ${where}` : ""}${tail}`;
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
      shape.correlated.forEach((read, k) => {
        const plan = this.correlation(table, read);
        if (!plan) return;
        const c = `${alias}c${k}`;
        const leaf = (i: number) => {
          const l = plan.condition.leaves[i]!;
          if ("value" in l) return sqlValue(l.value);
          const column = `${quote(alias)}.${quote(l.outer)}`;
          return l.truthy ? `(case when ${truthyCondition(column, l.type) ?? "0"} then 1 else 0 end)` : column;
        };
        let where = renderCondition(plan.condition.template, c, leaf);
        if (plan.limit !== undefined) {
          const d = `${c}k`;
          const terms = plan.order.map((o) => `(${quote(d)}.${quote(o.column)} is null)${o.desc ? " desc" : ""}, ${quote(d)}.${quote(o.column)}${o.desc ? " desc" : ""}`);
          terms.push(...plan.target.primaryKey.map((k2) => `${quote(d)}.${quote(k2)}`));
          const key = (as: string) => plan.target.primaryKey.map((k2) => `${quote(as)}.${quote(k2)}`).join(", ");
          where += ` and (${key(c)}) in (select ${key(d)} from ${quote(plan.target.name)} as ${quote(d)} where ${renderCondition(plan.condition.template, d, leaf)} order by ${terms.join(", ")} limit ${plan.limit})`;
        }
        const sub = `select json_group_array(${this.rowJSON(plan.target, c, read.shape, depth + 1)}) from ${quote(plan.target.name)} as ${quote(c)} where ${where}`;
        parts.push(`${literal(`${NESTED}?${k}`)}, json((${sub}))`);
      });
    }
    return `json_object(${parts.join(", ")})`;
  }

  /**
   * A correlated read as the RowQuery the evaluator will ask for once per outer row, with
   * the outer row's columns as its leaves: the same translation of its conditions, and its
   * ordering and limit when it keeps them. Null when a value it uses isn't a literal or
   * the outer row's own column, so the evaluator's read is left for it to make.
   */
  private correlation(outer: Table, read: CorrelatedRead): {
    target: Table;
    condition: Condition;
    order: Array<{ column: string; desc: boolean }>;
    limit?: number;
  } | null {
    const cache = this.correlations.get(read);
    if (cache !== undefined && cache.outer === outer) return cache.plan;
    const plan = this.correlate(outer, read);
    this.correlations.set(read, { outer, plan });
    return plan;
  }

  private readonly correlations = new WeakMap<CorrelatedRead, { outer: Table; plan: ReturnType<SQLiteStore["correlate"]> }>();

  private correlate(outer: Table, read: CorrelatedRead): {
    target: Table;
    condition: Condition;
    order: Array<{ column: string; desc: boolean }>;
    limit?: number;
  } | null {
    const name = this.schema.tableOf(read.model);
    if (!name || !this.schema.byName.has(name)) return null;
    const target = this.table(name);
    const literalLeaf = (e: Expr): { value: unknown; type: SQLType } | null => {
      if (e.kind !== "literal") return null;
      const v = e.value;
      return { value: v, type: v === null ? "null" : typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : "text" };
    };
    /** `outer` or `outer.field`: the column it reads and its type, as the evaluator's value of it would be written. */
    const outerLeaf = (e: Expr): { outer: string; type: SQLType } | null => {
      if (e.kind === "name" && e.name === read.outer) {
        return outer.primaryKey.length === 1 ? { outer: outer.primaryKey[0]!, type: `row:${outer.stores}` } : null;
      }
      if (e.kind !== "field" || e.object.kind !== "name" || e.object.name !== read.outer) return null;
      const place = this.schema.place(outer.stores, e.name);
      if (place.kind === "column") {
        const c = outer.columns.find((x) => x.name === place.column);
        if (!c || c.array) return null;
        const type: SQLType = c.type === "bool" ? "bool" : c.type === "text" ? "text" : c.type === "date" || c.type === "timestamp" ? "date" : "number";
        return { outer: place.column, type };
      }
      if (place.kind === "reference" && place.columns.length === 1) {
        return { outer: place.columns[0]!, type: place.target === "Person" ? "row:Person" : `enum:${place.target}` };
      }
      return null;
    };
    let usesOuter = false;
    const translated = translateWhere({
      schema: this.schema,
      rules: read.rules,
      model: read.model,
      self: read.binding.name,
      bound: read.bound,
      leaf: (e) => {
        const o = outerLeaf(e);
        if (o) { usesOuter = true; return o; }
        return literalLeaf(e);
      },
      leafCondition: (e) => {
        const o = outerLeaf(e);
        if (o) { usesOuter = true; return { ...o, truthy: true }; }
        const l = literalLeaf(e);
        return l ? { value: truthyValue(l.value) ? 1 : 0, type: "number" } : null;
      },
    }, read.where);
    if (translated.unknownLeaf || !translated.condition || !usesOuter) return null;
    const text = target.primaryKey.every((k) => target.columns.find((c) => c.name === k)?.type === "text");
    const limit = read.limit?.kind === "literal" && typeof read.limit.value === "number" ? read.limit.value : null;
    if (translated.exact && limit !== null && read.bound.size === 1 && text) {
      const columns = read.order.map((t) => {
        if (t.value.kind !== "field" || t.value.object.kind !== "name" || t.value.object.name !== read.binding.name) return null;
        const place = this.schema.place(read.model, t.value.name);
        return place.kind === "column" ? { column: place.column, desc: t.desc } : null;
      });
      if (columns.every(Boolean)) return { target, condition: translated.condition, order: columns as Array<{ column: string; desc: boolean }>, limit: Math.max(0, Math.floor(limit)) };
    }
    return { target, condition: translated.condition, order: [] };
  }

  /** A row read as JSON, and the reads nested in it remembered as their own matches. */
  private loadJSON(table: Table, json: Record<string, unknown>, shape: ReadShape | undefined): Row {
    const row = this.rowOf(table, json);
    for (const [name, value] of Object.entries(json)) {
      if (!name.startsWith(NESTED) || !Array.isArray(value)) continue;
      if (name.startsWith(`${NESTED}?`)) {
        const read = shape?.correlated[Number(name.slice(NESTED.length + 1))];
        const plan = read ? this.correlation(table, read) : null;
        if (!read || !plan) continue;
        // The leaves as the evaluator will have them for this row.
        const leaves: LeafValue[] = plan.condition.leaves.map((l) => {
          if ("value" in l) return l;
          const v = row.data[l.outer] ?? null;
          return { value: l.truthy ? (truthyValue(v) ? 1 : 0) : v, type: l.type };
        });
        const query: RowQuery = {
          condition: { template: plan.condition.template, leaves },
          order: plan.order,
          ...(plan.limit !== undefined ? { limit: plan.limit } : {}),
        };
        const key = this.querySQL(plan.target, query).key;
        const rows = value.map((v) => this.loadJSON(plan.target, v as Record<string, unknown>, read.shape)).sort(compareRows);
        if (!this.found.has(key)) this.found.set(key, rows);
        continue;
      }
      const field = name.slice(NESTED.length);
      const inner = shape?.fields.get(field);
      const r = this.followed(table, field);
      if (!r) continue;
      if (r.direct) {
        const target = this.table(r.target);
        this.remember(target.name, r.direct.map((p) => p.target), r.direct.map((p) => row.data[p.source] ?? null),
          value.map((v) => this.loadJSON(target, v as Record<string, unknown>, inner)));
      } else {
        const through = r.through!;
        const join = this.table(through.relation);
        const joins = (value as Array<{ join: Record<string, unknown>; far: unknown[] | null }>).map((j) => {
          const joinRow = this.rowOf(join, j.join);
          if (r.target !== PERSON_RELATION && Array.isArray(j.far)) {
            const target = this.table(r.target);
            this.remember(target.name, through.target.map((p) => p.target), through.target.map((p) => joinRow.data[p.through] ?? null),
              j.far.map((v) => this.loadJSON(target, v as Record<string, unknown>, inner)));
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
  private querySQL(table: Table, query: RowQuery, alias = "r0"): { where: string; parameters: unknown[]; tail: string; key: string } {
    const condition = query.condition;
    const values = condition?.leaves.map((l) => ("value" in l ? l.value : null)) ?? [];
    const where = condition ? renderCondition(condition.template, alias, (i) => sqlValue(values[i])) : "";
    const parameters: unknown[] = [];
    // The evaluator's order: nulls last ascending (first descending), ties in key order. A
    // key of text columns sorts as its canonical text does, so only then can the limit hold.
    const text = table.primaryKey.every((k) => table.columns.find((c) => c.name === k)?.type === "text");
    let tail = "";
    if (query.limit !== undefined && text) {
      const terms = query.order.map((o) => `(${quote(o.column)} is null)${o.desc ? " desc" : ""}, ${quote(o.column)}${o.desc ? " desc" : ""}`);
      terms.push(...table.primaryKey.map((k) => quote(k)));
      tail = ` order by ${terms.join(", ")} limit ${query.limit}`;
    }
    return { where, parameters, tail, key: `${table.name}\0?\0${condition?.template ?? ""}\0${canonical(values)}\0${tail}` };
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
      return `json((select json_group_array(${this.rowJSON(table, "r0", shape, 1)}) from (select * from ${quote(table.name)} as "q"${where ? ` where ${where}` : ""}${tail}) as "r0"))`;
    };
    const load = (table: Table, value: unknown, shape: ReadShape | undefined) => (Array.isArray(value) ? value : []).map((v) => this.loadJSON(table, v as Record<string, unknown>, shape)).sort(compareRows);
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
        const q = this.querySQL(table, read.query, "q");
        if (this.found.has(q.key)) continue;
        parts.push(rows(table, q.where, q.parameters, q.tail, read.shape));
        after.push((value) => { if (!this.found.has(q.key)) this.found.set(q.key, load(table, value, read.shape)); });
      } else {
        const columns = this.schema.keyOf(name);
        const values = columns.length === 1 ? [read.key] : columns.map((c) => (read.key as Record<string, Cell> | null)?.[c]);
        if (values.some((v) => v !== null && v !== undefined && typeof v === "object")) continue;
        const key = this.matchKey(name, columns, values);
        if (this.found.has(key)) continue;
        parts.push(rows(table, columns.map((c) => `${quote(c)} is ?`).join(" and "), values.map(stored), "", read.shape));
        after.push((value) => { if (!this.found.has(key)) this.found.set(key, load(table, value, read.shape)); });
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

/** What Beetle counts as true, for a stored value. */
function truthyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
