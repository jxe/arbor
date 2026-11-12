// Running a mutation (spec 1.5 §4): its facts, read against the rows as they were, become one
// set of row writes. Every line reads the state from before the mutation, so lines are
// gathered first and applied together; the first public error, in the order lines are
// written, ends the mutation and writes nothing. Two facts that can't both hold are a
// `conflict`.

import type { Line, MutationDecl } from "./ast.ts";
import { Action, BeetleError, equal, Evaluator, identity, truthy, type Value } from "./eval.ts";
import { canonical, derivedID, EnumValue, OverlayStore, Row, Store, StoreRefusal, type RowData } from "./store.ts";
import type { RowsByTable } from "@ovst/usl";

type Env = Map<string, Value>;

/** A fact gathered from a mutation's lines. */
type Fact =
  | { kind: "row"; model: string; fields: Record<string, Value>; row: Row; inserts: boolean }
  | { kind: "not"; model: string; fields: Record<string, Value> }
  | { kind: "set"; row: Row; field: string; value: Value };

export interface MutationOptions {
  /** The mutation's identity: new rows' ids derive from it, so an exact retry makes the same rows. */
  mutationID: string;
}

export interface MutationOutcome {
  /** Each bound collection's rows afterwards, by schema path; only collections it changed. Read whole on demand. */
  readonly rows: Record<string, RowsByTable>;
  /** Each changed collection's store before and its writes over it, by schema path: what row operations come from. */
  changed: Record<string, { before: Store; after: OverlayStore }>;
  /** The rows it wrote, by table: each one's key. */
  writes: Record<string, unknown[]>;
  /** Of those, the rows it deleted, by table. */
  deleted: Record<string, unknown[]>;
}

const ERROR_TEXT: Record<string, string> = {
  unauthorized: "Sign in to do this",
  forbidden: "You may not do this",
  missing: "Not found",
  invalid: "The input is not valid",
  conflict: "This conflicts with the current rows",
};

/** Runs the mutation `name` with `input` against the evaluator's rows. Throws {@link BeetleError}. */
export function runMutation(evaluator: Evaluator, name: string, input: unknown, options: MutationOptions): MutationOutcome {
  const entry = evaluator.checker.mutations.get(name);
  if (!entry) throw new BeetleError("missing", `There is no mutation ${name}`);
  const run = new MutationRun(evaluator, options);
  run.lines(entry.decl.body, evaluator.bind(entry.decl.params, input), 0);
  return run.apply();
}

class MutationRun {
  readonly facts: Fact[] = [];
  /** Counts new rows, shared with called mutations, so each gets its own id. */
  counter = { inserted: 0 };

  constructor(readonly ev: Evaluator, readonly options: MutationOptions) {}

  lines(lines: Line[], env: Env, depth: number): void {
    if (depth > 32) throw new BeetleError("invalid", "Mutations call each other too deeply");
    for (const line of lines) {
      switch (line.kind) {
        case "comment": break;
        case "if":
          if (truthy(this.ev.expr(line.condition, env))) this.lines(line.body, new Map(env), depth);
          break;
        case "for":
          for (const e of this.ev.matches(line.bindings, line.where, [], undefined, env)) this.lines(line.body, e, depth);
          break;
        case "error":
          throw new BeetleError(line.code, line.message ?? ERROR_TEXT[line.code]!);
        case "set": {
          const row = this.ev.expr(line.target.object, env);
          if (row === null) break;
          if (!(row instanceof Row)) throw new BeetleError("invalid", `${line.target.name} is set on something that isn't a row`);
          this.facts.push({ kind: "set", row, field: line.target.name, value: this.ev.expr(line.value, env) });
          break;
        }
        case "fact": {
          const call = line.call;
          const args: Record<string, Value> = {};
          const mutation = this.ev.checker.mutations.get(call.callee);
          if (mutation && !this.ev.checker.models.has(call.callee)) {
            call.args.forEach((a, i) => { args[a.name ?? mutation.decl.params[i]?.name ?? String(i)] = this.ev.expr(a.value, env); });
            // A called mutation's names are its own file's.
            const run = mutation.from === this.ev.checker.source.path ? this : this.called(mutation.from);
            run.lines(mutation.decl.body, run.params(mutation.decl, args), depth + 1);
            break;
          }
          for (const a of call.args) args[a.name ?? ""] = this.ev.expr(a.value, env);
          if (line.negated) {
            this.facts.push({ kind: "not", model: call.callee, fields: args });
            break;
          }
          const fact = this.rowFact(call.callee, args);
          this.facts.push(fact);
          if (line.name) env.set(line.name, fact.row);
          break;
        }
      }
    }
  }

  /** A run of another file's mutation, gathering into this run's facts and ids. */
  private called(path: string): MutationRun {
    const run = new MutationRun(this.ev.fileOf(path), this.options);
    (run as { facts: Fact[] }).facts = this.facts;
    run.counter = this.counter;
    return run;
  }

  /** A called mutation's parameters from its arguments: rows stay rows, keys become rows. */
  private params(decl: MutationDecl, args: Record<string, Value>): Env {
    const env: Env = new Map();
    for (const p of decl.params) {
      const v = args[p.name] ?? null;
      const type = p.type?.name;
      const model = type ? this.ev.checker.models.get(type) : undefined;
      env.set(p.name, model && model.kind !== "enum" && v !== null && !(v instanceof Row) && !Array.isArray(v) ? this.ev.resolveRow(type!, v) : v);
    }
    return env;
  }

  private store(model: string): Store {
    const store = this.ev.storeOf(model);
    if (!store || !store.schema.tableOf(model)) throw new BeetleError("invalid", `${model} is not a table of a bound collection`);
    return store;
  }

  /** `Table(field: value, …)`: the row its key names, or a new one when the key is left to the mutation. */
  private rowFact(model: string, fields: Record<string, Value>): Extract<Fact, { kind: "row" }> {
    const store = this.store(model);
    const table = store.schema.tableOf(model)!;
    const key = store.schema.keyOf(table);
    const data: RowData = {};
    for (const [field, value] of Object.entries(fields)) Object.assign(data, this.columns(store, model, field, value) ?? {});
    const missing = key.filter((k) => data[k] === undefined || data[k] === null);
    let inserts = false;
    if (missing.length) {
      if (missing.length !== 1 || missing[0] !== "id") throw new BeetleError("invalid", `${model} needs ${missing.join(", ")} to name a row`);
      data.id = derivedID(`${this.options.mutationID}\0${++this.counter.inserted}`);
      inserts = true;
    }
    const existing = store.match(table, key, key.map((k) => data[k]))[0];
    const row = existing ? new Row(existing.model, existing.table, existing.key, { ...existing.data, ...data }) : new Row(model, table, key, data);
    return { kind: "row", model, fields, row, inserts };
  }

  /** The stored columns a field's value goes in, or undefined for a to-many connection, written after. */
  columns(store: Store, model: string, field: string, value: Value): RowData | undefined {
    const place = store.schema.place(model, field);
    switch (place.kind) {
      case "column": return { [place.column]: cell(value) };
      case "reference": return { [place.columns[0]!]: value instanceof Row ? (value.keyValue as string) : value instanceof EnumValue ? value.name : cell(value) };
      case "relationship": {
        const r = place.relationship;
        // Only a reference this row stores; the other side of a 1:1 is written through its rows.
        const stored = store.schema.byModel.get(model)?.fields.some((f) => f.name === field);
        if (r.cardinality === "many" || !r.direct || !stored) return undefined;
        const out: RowData = {};
        for (const p of r.direct) {
          if (value === null) out[p.source] = null;
          else if (value instanceof Row) out[p.source] = value.data[p.target] ?? null;
          else if (r.direct.length === 1) out[p.source] = cell(value);
          else out[p.source] = (cell(value) as Record<string, unknown> | null)?.[p.target] ?? null;
        }
        return out;
      }
      case "none": throw new BeetleError("invalid", `${model} has no field ${field}`);
    }
  }

  /** Applies the gathered facts to a copy of the rows. */
  apply(): MutationOutcome {
    const after = new Map<Store, OverlayStore>();
    const copy = (s: Store) => {
      let c = after.get(s);
      if (!c) after.set(s, (c = new OverlayStore(s)));
      return c;
    };
    const writes: Record<string, unknown[]> = {};
    const removed: Record<string, unknown[]> = {};
    const wrote = (table: string, key: unknown, deleted = false) => {
      for (const into of deleted ? [writes, removed] : [writes]) {
        const list = (into[table] ??= []);
        if (!list.some((k) => canonical(k) === canonical(key))) list.push(key);
      }
    };
    // Per row: the columns facts give it, and the to-many connections they write.
    type Pending = { store: Store; row: Row; exists: boolean; columns: RowData; links: Map<string, Value>; fields: Set<string> };
    const pending = new Map<string, Pending>();
    const conflict = (message: string) => new BeetleError("conflict", message);
    const pendingOf = (store: Store, row: Row, exists: boolean): Pending => {
      const id = `${row.table}\0${row.keyText}`;
      let p = pending.get(id);
      if (!p) pending.set(id, (p = { store, row, exists, columns: {}, links: new Map(), fields: new Set() }));
      return p;
    };
    const give = (p: Pending, field: string, value: Value) => {
      const columns = this.columns(p.store, p.row.model, field, value);
      if (columns) {
        for (const [c, v] of Object.entries(columns)) {
          if (c in p.columns && canonical(p.columns[c]) !== canonical(v)) throw conflict(`Two facts give ${p.row.model}.${field} different values`);
          p.columns[c] = v;
        }
      } else {
        if (p.links.has(field) && identity(p.links.get(field)!) !== identity(value)) throw conflict(`Two facts give ${p.row.model}.${field} different values`);
        p.links.set(field, value);
      }
      p.fields.add(field);
    };
    const deleted = new Map<string, { store: Store; row: Row }>();
    for (const fact of this.facts) {
      if (fact.kind === "row") {
        const store = this.store(fact.model);
        const exists = store.match(fact.row.table, fact.row.key, fact.row.key.map((k) => fact.row.data[k]))[0] !== undefined;
        const p = pendingOf(store, fact.row, exists);
        for (const [field, value] of Object.entries(fact.fields)) give(p, field, value);
      } else if (fact.kind === "set") {
        if (fact.row.model === "Person") throw new BeetleError("invalid", "A person's own fields aren't written by mutations");
        if (["id", "created", "modified"].includes(fact.field)) throw new BeetleError("invalid", `A mutation can't write ${fact.field}`);
        const store = this.store(fact.row.model);
        const exists = store.match(fact.row.table, fact.row.key, fact.row.key.map((k) => fact.row.data[k]))[0] !== undefined;
        give(pendingOf(store, fact.row, exists), fact.field, fact.value);
      } else {
        const store = this.store(fact.model);
        for (const row of this.candidates(store, fact.model, fact.fields)) {
          if (Object.entries(fact.fields).every(([f, v]) => equal(this.ev.field(row, f), v))) deleted.set(`${row.table}\0${row.keyText}`, { store, row });
        }
      }
    }
    for (const id of deleted.keys()) if (pending.has(id)) throw conflict("A row must both exist and not exist");
    try {
      for (const { store, row } of deleted.values()) {
        const c = copy(store);
        c.delete(c.match(row.table, row.key, row.key.map((k) => row.data[k])));
        wrote(row.table, row.keyValue, true);
      }
      for (const p of pending.values()) {
        const c = copy(p.store);
        const table = p.row.table;
        const keyValues = p.row.key.map((k) => p.row.data[k]);
        const existing = c.match(table, p.row.key, keyValues)[0];
        if (existing) {
          const changed = Object.fromEntries(Object.entries(p.columns).filter(([col, v]) => canonical(existing.data[col] ?? null) !== canonical(v ?? null)));
          if (Object.keys(changed).length) {
            c.update(existing, changed);
            wrote(table, existing.keyValue);
          }
        } else if (p.exists) {
          continue; // deleted by a cascade: nothing to write to
        } else {
          const data: RowData = { ...Object.fromEntries(p.row.key.map((k) => [k, p.row.data[k]])), ...this.defaults(p.row.model, p.fields, c), ...p.columns };
          this.appendPositions(c, table, data);
          const row = c.insert(table, data);
          wrote(table, row.keyValue);
        }
      }
      for (const p of pending.values()) {
        const c = copy(p.store);
        const row = c.match(p.row.table, p.row.key, p.row.key.map((k) => p.row.data[k]))[0];
        if (!row) continue;
        for (const [field, value] of p.links) this.link(c, row, field, value, wrote);
      }
    } catch (error) {
      if (error instanceof StoreRefusal) throw new BeetleError(error.code, error.message);
      throw error;
    }
    const changed: MutationOutcome["changed"] = {};
    for (const [path, store] of this.ev.stores) {
      const c = after.get(store);
      if (c) changed[path] = { before: store, after: c };
    }
    return {
      get rows() { return Object.fromEntries(Object.entries(changed).map(([path, c]) => [path, c.after.data()])); },
      changed,
      writes,
      deleted: removed,
    };
  }

  /** The rows a `not` fact may name: those its stored-column fields match, or every row when a field isn't one. */
  private candidates(store: Store, model: string, fields: Record<string, Value>): readonly Row[] {
    const table = store.schema.tableOf(model)!;
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(fields)) {
      const place = store.schema.place(model, field);
      if (place.kind !== "column" && place.kind !== "reference") return store.rows(model);
      const cells = this.columns(store, model, field, value);
      if (!cells) return store.rows(model);
      for (const [c, v] of Object.entries(cells)) { columns.push(c); values.push(v); }
    }
    return columns.length ? store.match(table, columns, values) : store.rows(model);
  }

  /** The fields a new row isn't given, from their defaults. */
  private defaults(model: string, given: Set<string>, store: Store): RowData {
    const info = this.ev.checker.models.get(model);
    const defaults = info ? this.ev.checker.schemas.get(info.schema)?.defaults[model] ?? {} : {};
    const out: RowData = {};
    for (const [field, expr] of Object.entries(defaults)) {
      if (given.has(field)) continue;
      Object.assign(out, this.columns(store, model, field, this.ev.expr(expr, new Map())) ?? {});
    }
    return out;
  }

  /** A new row on an `ordered` end goes last: its position column is one past the holder's last. */
  private appendPositions(store: Store, table: string, data: RowData): void {
    const t = store.schema.byName.get(table);
    for (const column of t?.columns ?? []) {
      if (column.type !== "position" || data[column.name] !== undefined && data[column.name] !== null) continue;
      const r = store.schema.relationships.find((x) => x.target === table && x.direct && `${x.name}_position` === column.name);
      if (!r?.direct) { data[column.name] = 0; continue; }
      const siblings = store.match(table, r.direct.map((p) => p.target), r.direct.map((p) => data[p.target]));
      data[column.name] = siblings.reduce((max, s) => Math.max(max, Number(s.data[column.name] ?? -1)), -1) + 1;
    }
  }

  /** A to-many connection written as a whole: the far-end rows it reaches, in order for an `ordered` end (§4.1). */
  private link(store: Store, row: Row, field: string, value: Value, wrote: (table: string, key: unknown, deleted?: boolean) => void): void {
    const place = store.schema.place(row.model, field);
    if (place.kind !== "relationship") throw new BeetleError("invalid", `${row.model}.${field} can't be written`);
    const r = place.relationship;
    const values = (Array.isArray(value) ? value : value === null ? [] : [value]);
    const position = store.schema.positionOf(r);
    if (r.through) {
      const through = r.through;
      const targetModel = store.schema.modelOfTable(r.target);
      const desired = values.map((v) => (v instanceof Row ? v : this.ev.resolveRow(targetModel, v)))
        .filter((v): v is Row => v !== null);
      const existing = [...store.match(through.relation, through.source.map((p) => p.through), through.source.map((p) => row.data[p.source] ?? null))];
      const targetKey = (join: Row) => canonical(through.target.map((p) => join.data[p.through] ?? null));
      const wantKey = (t: Row) => canonical(through.target.map((p) => t.data[p.target] ?? null));
      const want = new Map(desired.map((t) => [wantKey(t), t]));
      const gone = existing.filter((j) => !want.has(targetKey(j)));
      if (gone.length) {
        store.delete(gone);
        for (const g of gone) wrote(through.relation, g.keyValue, true);
      }
      const have = new Set(existing.filter((j) => want.has(targetKey(j))).map(targetKey));
      desired.forEach((t, i) => {
        const k = wantKey(t);
        const data: RowData = {
          ...Object.fromEntries(through.source.map((p) => [p.through, row.data[p.source] ?? null])),
          ...Object.fromEntries(through.target.map((p) => [p.through, t.data[p.target] ?? null])),
        };
        if (position) data[position.column] = i;
        if (!have.has(k)) {
          const inserted = store.insert(through.relation, data);
          wrote(through.relation, inserted.keyValue);
          have.add(k);
        } else if (position) {
          const join = store.match(through.relation, Object.keys(data).filter((c) => c !== position.column), Object.entries(data).filter(([c]) => c !== position.column).map(([, v]) => v))[0];
          if (join && Number(join.data[position.column]) !== i) {
            store.update(join, { [position.column]: i });
            wrote(through.relation, join.keyValue);
          }
        }
      });
      return;
    }
    const direct = r.direct!;
    const far = store.schema.farEnd(r.target, direct.length ? this.endAs(store, r) : "");
    if (r.cardinality !== "many" || !far) throw new BeetleError("invalid", `${row.model}.${field} is written through its rows, not as a field`);
    // A connection table keyed by its two ends: the value is the far-end rows.
    const connModel = store.schema.modelOfTable(r.target);
    const farPlace = store.schema.place(connModel, far);
    const farModel = farPlace.kind === "relationship" ? store.schema.modelOfTable(farPlace.relationship.target) : farPlace.kind === "reference" ? farPlace.target : connModel;
    const desired = values.map((v) => (v instanceof Row && v.model === connModel ? this.ev.field(v, far) : v))
      .map((v) => (v instanceof Row ? v : v === null ? null : this.ev.resolveRow(farModel, v)))
      .filter((v): v is Row => v !== null);
    const holder = Object.fromEntries(direct.map((p) => [p.target, row.data[p.source] ?? null]));
    const existing = [...store.match(r.target, Object.keys(holder), Object.values(holder))];
    const farColumns = (target: Row) => this.columns(store, connModel, far, target) ?? {};
    const farKey = (conn: Row) => canonical(Object.keys(farColumns(desired[0] ?? conn)).map((c) => conn.data[c] ?? null));
    const wantKey = (t: Row) => canonical(Object.values(farColumns(t)));
    const want = new Set(desired.map(wantKey));
    const gone = existing.filter((c) => !want.has(farKey(c)));
    if (gone.length) {
      store.delete(gone);
      for (const g of gone) wrote(r.target, g.keyValue);
    }
    desired.forEach((t, i) => {
      const columns = { ...holder, ...farColumns(t) };
      const found = store.match(r.target, Object.keys(columns), Object.values(columns))[0];
      if (!found) {
        const data: RowData = { ...this.defaults(connModel, new Set(), store), ...columns };
        if (position) data[position.column] = i;
        this.appendPositions(store, r.target, data);
        wrote(r.target, store.insert(r.target, data).keyValue);
      } else if (position && Number(found.data[position.column]) !== i) {
        store.update(found, { [position.column]: i });
        wrote(r.target, found.keyValue);
      }
    });
  }

  /** The end field of a connection table that points back at a relationship's source. */
  private endAs(store: Store, r: { source: string; target: string; name: string }): string {
    const model = store.schema.result.models.find((m) => m.name === store.schema.modelOfTable(r.target));
    return model?.ends.find((e) => e.field === r.name && store.schema.tableOf(e.model) === r.source)?.as ?? "";
  }
}

/** A value as a stored cell. */
function cell(v: Value): unknown {
  if (v instanceof Row) return v.keyValue ?? null;
  if (v instanceof EnumValue) return v.name;
  if (v instanceof Action) return null;
  if (Array.isArray(v)) return v.map(cell);
  return v;
}
