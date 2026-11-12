// The evaluator (spec 1.5 §3): a view over a collection's rows into its view tree, and a
// data view into its JSON. It walks the checked source, so it means what the checker
// checked: rules expand where they are called, names come from `for`, parameters and state,
// and an element expands once per distinct combination of the names it uses (§3.5).
//
// Values are null, booleans, numbers, text, rows (`Row`), enum values (`EnumValue`), lists
// (a path through a to-many field is a list of distinct values), records and actions.
// Nulls have no third truth value: `null == null` holds, any other comparison with null
// doesn't, and a path through null is null (§3.4).

import type { Attribute, Binding, Child, DataRecord, Element, Expr, OrderTerm, Param, TextPart, ViewDecl } from "./ast.ts";
import { ruleCondition } from "./plan.ts";
import { translateWhere, type LeafValue } from "./sql.ts";
import { bindingShape, comprehensionShape, ReadShape, viewShapes, type ViewShapes } from "./shape.ts";
import { compileProgram, type Checker, type Program } from "./check.ts";
import { canonical, compareRows, EnumValue, Row, Store, StoreSchema, type PersonFields, type PrefetchRead, type RowQuery } from "./store.ts";
import type { RowsByTable } from "@ovst/usl";

/** A mutation call or a `set` an attribute or event holds, which a client runs. */
export class Action {
  /** `from` is the logical path of the file that declares the mutation. */
  constructor(readonly name: string, readonly args: Record<string, Value>, readonly kind: "mutation" | "set" = "mutation", readonly from?: string) {}
}

export type Value = null | boolean | number | string | Row | EnumValue | Action | Value[] | { [name: string]: Value };

/** A drawn element: plain data (§3.1). */
export interface ViewNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<ViewNode | string>;
  key: string | null;
}

/** A failure the caller may see, with one of the public codes (§4.2). */
export class BeetleError extends Error {
  constructor(readonly code: "unauthorized" | "forbidden" | "missing" | "invalid" | "conflict", message: string) {
    super(message);
    this.name = "BeetleError";
  }
}

/** Who is asking and when: what `me`, `now`, `today`, `page` and `community` mean. */
export interface EvalContext {
  /** The caller's profile id, or null for an anonymous reader. */
  me: string | null;
  now?: Date;
  page?: Record<string, unknown> | null;
  community?: string | null;
  /** A person's fields beyond their id (name, handle…), as the caller may read them. */
  person?: PersonFields;
}

/** A bound collection's rows, by its schema's logical path. */
export type BoundRows = Record<string, RowsByTable>;

type Env = Map<string, Value>;

const LANGUAGE = new Set(["for", "where", "if", "orderBy", "group", "limit", "fallback", "key", "slot"]);
const isRecord = (v: Value): v is { [name: string]: Value } =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Row) && !(v instanceof EnumValue) && !(v instanceof Action);

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** What tells two values apart: rows by table and key, enum values by name. */
export function identity(v: Value): string {
  if (v instanceof Row) return `row:${v.model}:${v.keyText}`;
  if (v instanceof EnumValue) return `enum:${v.name}`;
  if (Array.isArray(v)) return `[${v.map(identity).join(",")}]`;
  if (isRecord(v)) return canonical(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, identity(x)])));
  if (v instanceof Action) return `action:${v.name}:${identity(v.args)}`;
  return canonical(v);
}

function distinct(values: Value[]): Value[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const id = identity(v);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Equality with the spec's nulls: rows equal their keys, enum values their names. */
export function equal(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (a instanceof Row && b instanceof Row) return a.model === b.model && a.keyText === b.keyText;
  if (a instanceof Row) return identity(a.keyValue as Value) === identity(b);
  if (b instanceof Row) return equal(b, a);
  if (a instanceof EnumValue) return b instanceof EnumValue ? a.name === b.name : a.name === b;
  if (b instanceof EnumValue) return equal(b, a);
  if (typeof a === "object" || typeof b === "object") return identity(a) === identity(b);
  return a === b;
}

function compare(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  const x = a instanceof EnumValue ? a.name : a instanceof Row ? a.keyText : a;
  const y = b instanceof EnumValue ? b.name : b instanceof Row ? b.keyText : b;
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "string" && typeof y === "string") return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === "boolean" && typeof y === "boolean") return Number(x) - Number(y);
  return null;
}

/** Ordering for `orderBy`: nulls last, then by value. */
function orderOf(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const first = (v: Value) => (Array.isArray(v) ? v[0] ?? null : v);
  return compare(first(a), first(b)) ?? 0;
}

function contains(set: Value, x: Value): boolean {
  if (set === null) return false;
  if (Array.isArray(set)) return set.some((m) => equal(m, x));
  if (typeof set === "string" && typeof x === "string") return set.includes(x);
  return equal(set, x);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function addTime(date: string, ms: number): string {
  const t = Date.parse(DATE_ONLY.test(date) ? `${date}T00:00:00Z` : date) + ms;
  const iso = new Date(t).toISOString();
  return DATE_ONLY.test(date) ? iso.slice(0, 10) : iso;
}

/** Text for a value drawn in text: rows by their key, enum values by name. */
export function display(v: Value): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.map(display).join(", ");
  if (v instanceof Row) return v.model === "Person" && typeof v.data.name === "string" ? v.data.name : display(v.keyValue as Value);
  if (v instanceof EnumValue) return v.name;
  if (v instanceof Action) return "";
  if (typeof v === "object") return JSON.stringify(toJSON(v));
  return String(v);
}

/** A value as a data view returns it: a row as its key, an enum value as its name. */
export function toJSON(v: Value): unknown {
  if (v instanceof Row) return v.keyValue ?? null;
  if (v instanceof EnumValue) return v.name;
  if (v instanceof Action) return v.kind === "set" ? { set: v.name, value: toJSON(v.args.value ?? null) } : { action: v.name, from: v.from ?? null, args: toJSON(v.args) };
  if (Array.isArray(v)) return v.map(toJSON);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJSON(x)]));
  return v;
}

/** A value as an element's property: a row as `{ row, key }`, an enum value with its fields. */
export function toProp(v: Value): unknown {
  if (v instanceof Row) return { row: v.model, key: v.keyValue ?? null };
  if (v instanceof EnumValue) return { enum: v.enumName, name: v.name, ...v.values };
  if (v instanceof Action) return v.kind === "set" ? { set: v.name, value: toProp(v.args.value ?? null) } : { action: v.name, from: v.from ?? null, args: toProp(v.args) };
  if (Array.isArray(v)) return v.map(toProp);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toProp(x)]));
  return v;
}

export class Evaluator {
  readonly checker: Checker;
  /** Stores by schema path. */
  readonly stores = new Map<string, Store>();
  private now: Date;
  depth = 0;

  /** Evaluators for the other files this one's views, rules and mutations come from, by path. */
  private readonly files: Map<string, Evaluator>;

  constructor(readonly program: Program, rows: BoundRows | Map<string, Store>, readonly context: EvalContext, files?: Map<string, Evaluator>) {
    this.checker = program.checker;
    this.files = files ?? new Map();
    this.files.set(this.checker.source.path, this);
    this.now = context.now ?? new Date();
    if (rows instanceof Map) {
      for (const [path, store] of rows) this.stores.set(path, store);
    } else {
      for (const [path, schema] of this.checker.schemas) {
        this.stores.set(path, new Store(new StoreSchema(schema.result), rows[path] ?? {}, context.person));
      }
    }
  }

  /**
   * The evaluator for the file a view, rule or mutation is declared in: a used file's
   * names are its own, so what it draws and calls resolves there. It shares these rows.
   */
  fileOf(path: string): Evaluator {
    let found = this.files.get(path);
    if (!found) {
      const text = this.checker.options.read?.(path);
      if (text === undefined) throw new BeetleError("missing", `There is no file at ${path}`);
      const program = compileProgram(text, { ...this.checker.options, path });
      const stores = new Map(this.stores);
      for (const [schema, entry] of program.checker.schemas) {
        if (!stores.has(schema)) stores.set(schema, new Store(new StoreSchema(entry.result), {}, this.context.person));
      }
      found = new Evaluator(program, stores, this.context, this.files);
      found.now = this.now;
    }
    return found;
  }

  // ---------------------------------------------------------------- rows

  /** The store a model's rows are in; for Person, the first that has people. */
  storeOf(model: string): Store | undefined {
    const schema = this.checker.models.get(model)?.schema;
    if (schema && this.stores.has(schema)) return this.stores.get(schema);
    return model === "Person" ? this.stores.values().next().value : undefined;
  }

  person(id: string): Row {
    const store = this.stores.values().next().value as Store | undefined;
    return store ? store.person(id) : new Row("Person", "Person", ["id"], { ...(this.context.person?.(id) ?? {}), id });
  }

  /** A table-typed input resolved to its row: from a key, or a row already. */
  resolveRow(model: string, key: unknown, shape?: ReadShape): Row | null {
    if (key instanceof Row) return key;
    if (model === "Person") return typeof key === "string" ? this.person(key) : null;
    return this.storeOf(model)?.find(model, key, shape) ?? null;
  }

  field(v: Value, name: string): Value {
    if (v === null) return null;
    if (Array.isArray(v)) {
      const out: Value[] = [];
      for (const item of v) {
        const x = this.field(item, name);
        if (x === null) continue;
        if (Array.isArray(x)) out.push(...x);
        else out.push(x);
      }
      return distinct(out);
    }
    if (v instanceof EnumValue) return name === "name" ? v.name : ((v.values[name] ?? null) as Value);
    if (isRecord(v)) return v[name] ?? null;
    if (!(v instanceof Row)) return null;
    if (v.model === "Person") {
      for (const store of this.stores.values()) {
        const relationship = store.schema.relationship("Person", name);
        if (relationship) {
          const rows = store.follow(v, relationship);
          return relationship.cardinality === "many" ? rows : rows[0] ?? null;
        }
      }
      return (v.data[name] ?? null) as Value;
    }
    const store = this.storeOf(v.model);
    if (!store) return (v.data[name] ?? null) as Value;
    const place = store.schema.place(v.model, name);
    switch (place.kind) {
      case "column": return (v.data[place.column] ?? null) as Value;
      case "reference": {
        if (place.target === "Person") return typeof v.data[place.columns[0]!] === "string" ? this.person(v.data[place.columns[0]!] as string) : null;
        if (store.schema.enums.has(place.target)) return store.enumValue(place.target, v.data[place.columns[0]!]);
        return null;
      }
      case "relationship": {
        const rows = store.follow(v, place.relationship);
        return place.relationship.cardinality === "many" ? rows : rows[0] ?? null;
      }
      case "none": return (v.data[name] ?? null) as Value;
    }
  }

  /** An enum value written by name. */
  enumValue(name: string): Value {
    const enumName = this.checker.enumOfValue(name);
    if (!enumName) return null;
    for (const store of this.stores.values()) {
      for (const [e, values] of store.schema.enums) {
        if (enumName !== "#value" && e !== enumName) continue;
        const found = values.find((v) => v.name === name);
        if (found) return found;
      }
    }
    return new EnumValue(enumName === "#value" ? "" : enumName, name, {});
  }

  // ---------------------------------------------------------------- expressions

  builtin(name: string): Value | undefined {
    switch (name) {
      case "me": return this.context.me ? this.person(this.context.me) : null;
      case "now": return this.now.toISOString();
      case "today": return this.now.toISOString().slice(0, 10);
      case "page": return (this.context.page ?? null) as Value;
      case "community": return this.context.community ?? null;
      default: return undefined;
    }
  }

  name(name: string, env: Env): Value {
    if (env.has(name)) return env.get(name)!;
    const builtin = this.builtin(name);
    if (builtin !== undefined) return builtin;
    const model = this.checker.models.get(name);
    if (model) {
      if (model.kind === "enum") return [...(this.storeOf(name)?.schema.enums.get(name) ?? [])];
      if (model.kind === "state") return [];
      return [...(this.storeOf(name)?.rows(name) ?? [])];
    }
    const enumValue = this.enumValue(name);
    if (enumValue !== null) return enumValue;
    const mutation = this.checker.mutations.get(name);
    if (mutation) return new Action(name, {}, "mutation", mutation.from);
    return null;
  }

  expr(e: Expr, env: Env): Value {
    switch (e.kind) {
      case "literal": return e.value;
      case "duration": return e.milliseconds;
      case "template": return this.text(e.parts, env);
      case "list": return e.items.map((x) => this.expr(x, env));
      case "record": return Object.fromEntries(e.entries.map((x) => [x.name, this.expr(x.value, env)]));
      case "name": return this.name(e.name, env);
      case "field": return this.field(this.expr(e.object, env), e.name);
      case "unary": {
        const v = this.expr(e.operand, env);
        if (e.operator === "not") return !truthy(v);
        return typeof v === "number" ? -v : null;
      }
      case "choice": return truthy(this.expr(e.test, env)) ? this.expr(e.then, env) : this.expr(e.otherwise, env);
      case "binary": return this.binary(e.operator, e.left, e.right, env);
      case "call": return this.call(e, env);
      case "element": case "comprehension": case "annotated": return null;
    }
  }

  text(parts: TextPart[], env: Env): string {
    return parts.map((p) => (typeof p === "string" ? p : display(this.expr(p, env)))).join("");
  }

  private binary(op: string, left: Expr, right: Expr, env: Env): Value {
    if (op === "and") return truthy(this.expr(left, env)) && truthy(this.expr(right, env));
    if (op === "or") return truthy(this.expr(left, env)) || truthy(this.expr(right, env));
    const a = this.expr(left, env);
    if (op === "??") return a !== null ? a : this.expr(right, env);
    const b = this.expr(right, env);
    switch (op) {
      case "==": return equal(a, b);
      case "!=": return !equal(a, b);
      case "<": { const c = compare(a, b); return c !== null && c < 0; }
      case "<=": { const c = compare(a, b); return c !== null && c <= 0; }
      case ">": { const c = compare(a, b); return c !== null && c > 0; }
      case ">=": { const c = compare(a, b); return c !== null && c >= 0; }
      case "in": case "∈": return contains(b, a);
      case "∉": return !contains(b, a);
      case "excludes": return !contains(a, b);
      case "+": {
        if (Array.isArray(a)) return distinct([...a, ...(Array.isArray(b) ? b : b === null ? [] : [b])]);
        if (typeof a === "number" && typeof b === "number") return a + b;
        if (typeof a === "string" && typeof b === "number" && (DATE_ONLY.test(a) || !Number.isNaN(Date.parse(a)))) return addTime(a, b);
        if (typeof a === "string" || typeof b === "string") return display(a) + display(b);
        return null;
      }
      case "-": {
        if (Array.isArray(a)) return a.filter((m) => !(Array.isArray(b) ? b.some((x) => equal(m, x)) : equal(m, b)));
        if (typeof a === "number" && typeof b === "number") return a - b;
        if (typeof a === "string" && typeof b === "number") return addTime(a, -b);
        if (typeof a === "string" && typeof b === "string") {
          const parse = (d: string) => Date.parse(DATE_ONLY.test(d) ? `${d}T00:00:00Z` : d);
          const x = parse(a), y = parse(b);
          return Number.isNaN(x) || Number.isNaN(y) ? null : x - y;
        }
        return null;
      }
      case "*": return typeof a === "number" && typeof b === "number" ? a * b : null;
      case "/": return typeof a === "number" && typeof b === "number" && b !== 0 ? a / b : null;
    }
    return null;
  }

  /** The values a comprehension or a `for` binding ranges over. */
  members(source: Value): Value[] {
    if (source === null) return [];
    return Array.isArray(source) ? source : [source];
  }

  private call(e: Extract<Expr, { kind: "call" }>, env: Env): Value {
    const first = e.args[0]?.value;
    const aggregate = ["count", "exists", "sum", "min", "max"].includes(e.callee);
    if (aggregate && first?.kind === "comprehension") {
      const matches = this.over(first, env).filter((m) => {
        const inner = new Map(env).set(first.binding.name, m);
        return first.where.every((c) => truthy(this.expr(c, inner)));
      });
      return this.aggregate(e.callee, matches);
    }
    if (aggregate) return this.aggregate(e.callee, first ? this.members(this.expr(first, env)) : []);
    const arg = (i: number) => (e.args[i] ? this.expr(e.args[i]!.value, env) : null);
    switch (e.callee) {
      case "lower": { const v = arg(0); return typeof v === "string" ? v.toLowerCase() : null; }
      case "upper": { const v = arg(0); return typeof v === "string" ? v.toUpperCase() : null; }
      case "trim": { const v = arg(0); return typeof v === "string" ? v.trim() : null; }
      case "length": { const v = arg(0); return typeof v === "string" ? [...v].length : Array.isArray(v) ? v.length : null; }
      case "set": {
        const target = e.args[0]?.value;
        return new Action(target?.kind === "name" ? target.name : "", { value: arg(1) }, "set");
      }
    }
    const rule = this.checker.rules.get(e.callee);
    if (rule) {
      const args = e.args.map((a) => this.expr(a.value, env));
      const owner = this.fileOf(rule.from);
      if (owner.depth > 32) return false;
      owner.depth++;
      try {
        return rule.decls.filter((d) => d.params.length === args.length).some((d) => {
          const inner: Env = new Map(d.params.map((p, i) => [p.name, args[i]!]));
          return truthy(owner.expr(ruleCondition(d), inner));
        });
      } finally {
        owner.depth--;
      }
    }
    const mutation = this.checker.mutations.get(e.callee);
    if (mutation) {
      const args: Record<string, Value> = {};
      e.args.forEach((a, i) => { args[a.name ?? mutation.decl.params[i]?.name ?? String(i)] = this.expr(a.value, env); });
      return new Action(e.callee, args, "mutation", mutation.from);
    }
    return null;
  }

  /** What a comprehension ranges over; a whole table is read at once with what its condition follows. */
  private over(c: Extract<Expr, { kind: "comprehension" }>, env: Env): Value[] {
    const source = c.binding.source;
    if (source.kind === "name" && !env.has(source.name) && this.checker.models.get(source.name)?.kind === "data") {
      const shape = this.tableShape(c.binding, () => comprehensionShape(this.checker, c));
      const rows = shape.empty ? null : this.storeOf(source.name)?.query(source.name, { condition: null, order: [] }, shape);
      if (rows) return [...rows];
    }
    return this.members(this.expr(source, env));
  }

  private aggregate(name: string, values: Value[]): Value {
    switch (name) {
      case "count": return values.length;
      case "exists": return values.length > 0;
      case "sum": return values.reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
      case "min": case "max": {
        let best: Value = null;
        for (const v of values) {
          if (v === null) continue;
          const c = best === null ? null : compare(v, best);
          if (best === null || (c !== null && (name === "min" ? c < 0 : c > 0))) best = v;
        }
        return best;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- inputs

  /** A view's or mutation's parameters from its input: table-typed ones resolved to rows. */
  bind(params: Param[], input: unknown, env: Env = new Map(), shapes?: ReadonlyMap<string, ReadShape>): Env {
    const given = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    for (const p of params) {
      const raw = given[p.name] ?? null;
      env.set(p.name, this.input(p, raw, shapes?.get(p.name)));
    }
    return env;
  }

  private input(p: Param, raw: unknown, shape?: ReadShape): Value {
    const type = p.type?.name ?? "Text";
    const arity = p.type?.arity ?? "one";
    if (raw === null || raw === undefined) {
      if (arity === "many") return [];
      return null;
    }
    if (arity === "many") {
      if (!Array.isArray(raw)) throw new BeetleError("invalid", `${p.name} takes a list`);
      return raw.map((item) => this.one(p.name, type, item, shape));
    }
    return this.one(p.name, type, raw, shape);
  }

  private one(name: string, type: string, raw: unknown, shape?: ReadShape): Value {
    const model = this.checker.models.get(type);
    if (model && model.kind !== "enum") {
      const row = this.resolveRow(type, raw, shape);
      if (!row) throw new BeetleError("missing", `No ${type} has the key given for ${name}`);
      return row;
    }
    if (model?.kind === "enum") {
      const v = typeof raw === "string" ? this.enumValue(raw) : null;
      if (!(v instanceof EnumValue) || (v.enumName && v.enumName !== type)) throw new BeetleError("invalid", `${name} is not a ${type}`);
      return v;
    }
    switch (type) {
      case "Int": {
        const n = typeof raw === "string" ? Number(raw) : raw;
        if (typeof n !== "number" || !Number.isInteger(n)) throw new BeetleError("invalid", `${name} is not a whole number`);
        return n;
      }
      case "Number": {
        const n = typeof raw === "string" ? Number(raw) : raw;
        if (typeof n !== "number" || Number.isNaN(n)) throw new BeetleError("invalid", `${name} is not a number`);
        return n;
      }
      case "Bool": {
        if (raw === "true" || raw === "false") return raw === "true";
        if (typeof raw !== "boolean") throw new BeetleError("invalid", `${name} is not true or false`);
        return raw;
      }
      case "Date": {
        if (typeof raw !== "string" || Number.isNaN(Date.parse(DATE_ONLY.test(raw) ? `${raw}T00:00:00Z` : raw))) throw new BeetleError("invalid", `${name} is not a date`);
        return raw;
      }
      default:
        if (typeof raw !== "string") throw new BeetleError("invalid", `${name} is not text`);
        return raw;
    }
  }

  // ---------------------------------------------------------------- views

  /** A view of the file, by name (`""` for its unnamed view), evaluated into its tree. */
  view(name: string, input: unknown): ViewNode[] {
    const decl = this.declaredView(name);
    if (!decl) throw new BeetleError("missing", name ? `There is no view ${name}` : "The file has no unnamed view");
    if (decl.data) throw new BeetleError("invalid", `${name} is a data view`);
    return this.withShapes(viewShapes(this.checker, decl), () => {
      this.readAhead(decl, input, this.shapes!);
      return this.drawView(decl, this.bind(decl.params, input, new Map(), this.shapes!.params));
    });
  }

  /** A data view of the file, by name, evaluated into its JSON. */
  data(name: string, input: unknown): unknown {
    const decl = this.declaredView(name);
    if (!decl?.data) throw new BeetleError("missing", `There is no data view ${name}`);
    return this.withShapes(viewShapes(this.checker, decl), () => {
      this.readAhead(decl, input, this.shapes!);
      return this.record(decl.data!, this.bind(decl.params, input, new Map(), this.shapes!.params), null);
    });
  }

  /** What the view being evaluated reads, while it is. */
  private shapes: ViewShapes | null = null;

  private withShapes<T>(shapes: ViewShapes, run: () => T): T {
    const was = this.shapes;
    this.shapes = shapes;
    try {
      return run();
    } finally {
      this.shapes = was;
    }
  }

  /** What a binding over a whole table reads, as the view's shape for the table when there is one. */
  private tableShape(binding: Binding, own: () => ReadShape): ReadShape {
    const source = binding.source;
    return (source.kind === "name" ? this.shapes?.tables.get(source.name) : undefined) ?? own();
  }

  declaredView(name: string): ViewDecl | undefined {
    if (name.startsWith("#")) {
      // A page's n-th unnamed view, counting bare elements as views.
      let n = 0;
      for (const { decl } of this.checker.source.file.declarations) {
        if ((decl.kind === "view" && decl.name === null) || decl.kind === "element") {
          n += 1;
          if (`#${n}` !== name) continue;
          return decl.kind === "view" ? decl : { kind: "view", name: null, nameSpan: decl.span, params: [], lines: [], body: decl.element, span: decl.span };
        }
      }
      return undefined;
    }
    if (name === "") {
      for (const { decl } of this.checker.source.file.declarations) if (decl.kind === "view" && decl.name === null) return decl;
      return undefined;
    }
    return this.checker.views.get(name)?.decl;
  }

  /** A view's body with its state at its initial values. */
  drawView(decl: ViewDecl, env: Env): ViewNode[] {
    if (this.depth > 32) throw new BeetleError("invalid", "Views draw each other too deeply");
    this.depth++;
    try {
      for (const line of decl.lines) if (line.kind === "state" || line.kind === "keep") env.set(line.name, this.expr(line.value, env));
      if (!decl.body) return [];
      const out: ViewNode[] = [];
      this.element(decl.body, env, out);
      return out;
    } finally {
      this.depth--;
    }
  }

  /** The matches of a `for`: one environment per combination its `where` keeps, ordered and cut. */
  matches(bindings: Binding[], where: Expr[], order: OrderTerm[], limit: Expr | undefined, env: Env, shape?: ReadShape): Env[] {
    let envs: Env[] = [env];
    const narrowed = this.narrowed(bindings, where, order, limit, env, shape);
    for (const [i, b] of bindings.entries()) {
      const next: Env[] = [];
      for (const e of envs) for (const m of i === 0 && narrowed ? narrowed.rows : this.members(this.expr(b.source, e))) next.push(new Map(e).set(b.name, m));
      envs = next;
    }
    // A store that answered an exact translation kept exactly the rows the conditions keep.
    if (!narrowed?.exact) envs = envs.filter((e) => where.every((c) => truthy(this.expr(c, e))));
    if (order.length) {
      const keyed = envs.map((e, i) => ({ e, i, keys: order.map((t) => this.expr(t.value, e)) }));
      keyed.sort((x, y) => {
        for (let k = 0; k < order.length; k++) {
          const c = orderOf(x.keys[k]!, y.keys[k]!);
          if (c !== 0) return order[k]!.desc ? -c : c;
        }
        return x.i - y.i;
      });
      envs = keyed.map((k) => k.e);
    }
    if (limit) {
      const n = this.expr(limit, env);
      if (typeof n === "number") envs = envs.slice(0, Math.max(0, Math.floor(n)));
    }
    return envs;
  }

  /**
   * The rows a `for`'s first binding ranges over, narrowed by its store when it binds a
   * table: the conditions and orderings on that row's own columns, stated as a RowQuery.
   * The evaluator still applies every ordering and limit to what comes back, and every
   * condition unless the translation was exact, so a store answering an inexact query only
   * has to return a superset of the matches.
   */
  private narrowed(bindings: Binding[], where: Expr[], order: OrderTerm[], limit: Expr | undefined, env: Env, shape?: ReadShape): { rows: readonly Row[]; exact: boolean } | null {
    const planned = this.rowQuery(bindings, where, order, limit, env);
    if (!planned) return null;
    // With nothing to narrow by, a store still reads the rows at once with what follows from them.
    if (!planned.query.condition && planned.query.limit === undefined && (!shape || shape.empty)) return null;
    const rows = planned.store.query(planned.model, planned.query, shape);
    return rows ? { rows, exact: planned.exact && planned.query.condition !== null } : null;
  }

  /**
   * A `for`'s first binding as a RowQuery over its table: its conditions as SQL where they
   * can be stated, and its ordering and limit when the conditions are exact and the
   * ordering is on the row's own columns. With `env` null, only whether anything narrows
   * it, without evaluating anything.
   */
  private rowQuery(bindings: Binding[], where: Expr[], order: OrderTerm[], limit: Expr | undefined, env: Env | null): { store: Store; model: string; query: RowQuery; narrows: boolean; exact: boolean } | null {
    const first = bindings[0];
    if (!first || first.source.kind !== "name" || env?.has(first.source.name)) return null;
    const model = this.checker.models.get(first.source.name);
    if (!model || model.kind !== "data") return null;
    const store = this.storeOf(first.source.name);
    if (!store) return null;
    const name = first.name;
    const value = (e: Expr): { ok: true; value: Value } | { ok: false } => {
      try {
        return { ok: true, value: this.expr(e, env!) };
      } catch {
        return { ok: false };
      }
    };
    const translated = translateWhere({
      schema: store.schema,
      rules: this.checker.rules,
      model: first.source.name,
      self: name,
      bound: new Set(bindings.map((b) => b.name)),
      leaf: (e) => {
        if (!env) return { value: null, type: "any" };
        const v = value(e);
        return v.ok ? leafOf(v.value) : null;
      },
      leafCondition: (e) => {
        if (!env) return { value: null, type: "any" };
        const v = value(e);
        return v.ok ? { value: truthy(v.value) ? 1 : 0, type: "number" } : null;
      },
    }, where);
    const query: RowQuery = { condition: translated.condition, order: [] };
    if (env && translated.exact && limit && bindings.length === 1) {
      const column = (e: Expr): string | null => {
        if (e.kind !== "field" || e.object.kind !== "name" || e.object.name !== name) return null;
        const place = store.schema.place(first.source.kind === "name" ? first.source.name : "", e.name);
        return place.kind === "column" ? place.column : null;
      };
      const terms = order.map((t) => ({ col: column(t.value), desc: t.desc }));
      const n = this.expr(limit, env);
      if (terms.every((t) => t.col) && typeof n === "number") {
        query.order = terms.map((t) => ({ column: t.col!, desc: t.desc }));
        query.limit = Math.max(0, Math.floor(n));
      }
    }
    // Without values, a condition on the row may still narrow once its leaves are known.
    const usesRow = () => where.some((e) => { const uses = new Set<string>(); exprNames(e, uses); return uses.has(name); });
    const narrows = translated.condition !== null && (env !== null || usesRow()) || !!limit;
    return { store, model: first.source.name, query, narrows, exact: translated.exact && bindings.length === 1 };
  }

  // ---------------------------------------------------------------- reading ahead

  /**
   * Before a view runs, the reads it will make that are known from its source and input
   * alone, asked of each store at once: its table-typed inputs' rows, the people any row
   * names when it ranges over people, every table it ranges over whole (no condition
   * narrows it), and its top-level `for`s, narrowed by their inputs. A SQLite store reads
   * them all in one statement. Anything else is read when the evaluator asks.
   */
  private readAhead(decl: ViewDecl, input: unknown, shapes: ViewShapes): void {
    const reads = new Map<Store, PrefetchRead[]>();
    const add = (store: Store | undefined, read: PrefetchRead) => {
      if (!store) return;
      let list = reads.get(store);
      if (!list) reads.set(store, (list = []));
      list.push(read);
    };
    const given = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    // Inputs: rows by key; other values as the view will see them, for its top-level conditions.
    const env: Env = new Map();
    const unknown = new Set<string>();
    for (const p of decl.params) {
      const type = p.type?.name ?? "Text";
      const model = this.checker.models.get(type);
      const raw = given[p.name] ?? null;
      if (model && model.kind === "data") {
        unknown.add(p.name);
        for (const key of p.type?.arity === "many" && Array.isArray(raw) ? raw : [raw]) {
          if (key === null || (typeof key === "object" && !isRecord(key as Value))) continue;
          add(this.storeOf(type), { kind: "find", model: type, key: key as unknown, shape: shapes.params.get(p.name) });
        }
        continue;
      }
      try {
        env.set(p.name, this.input(p, raw));
      } catch {
        unknown.add(p.name);
      }
    }
    for (const line of decl.lines) if (line.kind === "state" || line.kind === "keep") unknown.add(line.name);
    const wholes = new Set<string>();
    const visited = new Set<unknown>();
    /** Reads a binding makes; true when it binds one row known now, so what's inside it is read as at the top. */
    const binding = (b: Binding, where: Expr[], order: OrderTerm[], limit: Expr | undefined, top: boolean, own: () => ReadShape): boolean => {
      if (b.source.kind !== "name") return false;
      const name = b.source.name;
      if (name === "Person" && !unknown.has(name)) {
        add(this.storeOf("Person"), { kind: "people" });
        // `person in Person where person.id == id`: the one person is known from the input.
        if (!top) return false;
        for (const c of where) {
          if (c.kind !== "binary" || c.operator !== "==") continue;
          const id = (x: Expr) => x.kind === "field" && x.name === "id" && x.object.kind === "name" && x.object.name === b.name;
          const other = id(c.left) ? c.right : id(c.right) ? c.left : null;
          if (!other) continue;
          const uses = new Set<string>();
          exprNames(other, uses);
          if (uses.has(b.name) || [...uses].some((n) => unknown.has(n))) continue;
          try {
            const v = this.expr(other, env);
            if (typeof v === "string") { env.set(b.name, this.person(v)); return true; }
          } catch {
            // Left for the view to find.
          }
        }
        return false;
      }
      const planned = this.rowQuery([b], where, order, limit, null);
      if (!planned) return false;
      const shape = this.tableShape(b, own);
      const whole = () => {
        if (!wholes.has(name)) { wholes.add(name); add(planned.store, { kind: "query", model: name, query: { condition: null, order: [] }, shape }); }
      };
      // At the top, with everything its conditions name known now, it's read as the view will ask.
      if (top) {
        const uses = new Set<string>();
        for (const e of [...where, ...order.map((t) => t.value), ...(limit ? [limit] : [])]) exprNames(e, uses);
        const known = ![...uses].some((n) => unknown.has(n) || (!env.has(n) && n !== b.name && this.checker.models.get(n) === undefined && this.builtin(n) === undefined && !this.checker.rules.has(n) && !this.checker.enumOfValue(n)));
        if (known) {
          try {
            const query = this.rowQuery([b], where, order, limit, env);
            if (query) {
              if (query.query.condition || query.query.limit !== undefined) add(query.store, { kind: "query", model: name, query: query.query, shape });
              else whole();
              return false;
            }
          } catch {
            // Its conditions can't be worked out yet; it's read when the view gets there.
          }
        }
      }
      if (!planned.narrows) whole();
      return false;
    };
    const expr = (e: Expr): void => {
      switch (e.kind) {
        case "comprehension": binding(e.binding, [], [], undefined, false, () => comprehensionShape(this.checker, e)); e.where.forEach(expr); break;
        case "template": e.parts.forEach((p) => typeof p !== "string" && expr(p)); break;
        case "list": e.items.forEach(expr); break;
        case "record": e.entries.forEach((x) => expr(x.value)); break;
        case "field": expr(e.object); break;
        case "call": e.args.forEach((a) => expr(a.value)); break;
        case "unary": expr(e.operand); break;
        case "binary": expr(e.left); expr(e.right); break;
        case "choice": expr(e.test); expr(e.then); expr(e.otherwise); break;
        case "element": element(e.element, false); break;
        default: break;
      }
    };
    const attributes = (attrs: Attribute[]) => {
      for (const a of attrs) {
        const v = a.value;
        if (v.kind === "expr") expr(v.expr);
        else if (v.kind === "text") expr(v.text);
        else if (v.kind === "where" || v.kind === "if") v.conditions.forEach(expr);
        else if (v.kind === "orderBy") v.terms.forEach((t) => expr(t.value));
        else if (v.kind === "for") v.bindings.forEach((b) => expr(b.source));
      }
    };
    const element = (el: Element, top: boolean): void => {
      const get = (name: string) => el.attributes.find((a) => a.name === name)?.value;
      const forValue = get("for");
      let inner = top;
      if (forValue?.kind === "for") {
        const where = get("where"), order = get("orderBy"), limit = get("limit");
        const one = binding(forValue.bindings[0]!, where?.kind === "where" ? where.conditions : [], order?.kind === "orderBy" ? order.terms : [],
          limit?.kind === "expr" ? limit.expr : undefined, top, () => bindingShape(this.checker, el, forValue.bindings[0]!));
        for (const b of forValue.bindings.slice(1)) binding(b, [], [], undefined, false, () => new ReadShape());
        inner = one && forValue.bindings.length === 1;
      }
      attributes(el.attributes);
      for (const child of el.children ?? []) {
        if (child.kind === "element") element(child.element, inner);
        else if (child.kind === "text") child.parts.forEach((p) => typeof p !== "string" && expr(p));
      }
      // A view of this file drawn here: its own whole-table reads.
      const drawn = this.checker.views.get(el.type);
      if (drawn && drawn.from === this.checker.source.path && !visited.has(drawn.decl)) {
        visited.add(drawn.decl);
        if (drawn.decl.body) element(drawn.decl.body, false);
      }
    };
    const record = (r: DataRecord, top: boolean): void => {
      for (const entry of r.entries) {
        if (entry.kind === "value") expr(entry.value);
        else if (entry.kind === "field" && entry.record) record(entry.record, false);
        else if (entry.kind === "record") {
          const get = (name: string) => entry.attributes.find((a) => a.name === name)?.value;
          const forValue = get("for");
          let inner = top;
          if (forValue?.kind === "for") {
            const where = get("where"), order = get("orderBy"), limit = get("limit");
            const one = binding(forValue.bindings[0]!, where?.kind === "where" ? where.conditions : [], order?.kind === "orderBy" ? order.terms : [],
              limit?.kind === "expr" ? limit.expr : undefined, top, () => bindingShape(this.checker, entry, forValue.bindings[0]!));
            inner = one && forValue.bindings.length === 1;
          }
          attributes(entry.attributes);
          record(entry.record, inner);
        }
      }
    };
    for (const line of decl.lines) if (line.kind === "state" || line.kind === "keep") expr(line.value);
    if (decl.body) element(decl.body, true);
    if (decl.data) record(decl.data, true);
    for (const [store, list] of reads) store.prefetch(list);
  }

  private element(el: Element, env: Env, out: Array<ViewNode | string>): void {
    const attr = (name: string) => el.attributes.find((a) => a.name === name)?.value;
    const forValue = attr("for");
    const fallback = () => {
      const f = attr("fallback");
      if (f?.kind === "expr" && f.expr.kind === "element") this.element(f.expr.element, env, out);
    };
    if (forValue?.kind !== "for") {
      const ifValue = attr("if");
      if (ifValue?.kind === "if" && !ifValue.conditions.every((c) => truthy(this.expr(c, env)))) return fallback();
      this.draw(el, env, null, out);
      return;
    }
    const where = attr("where");
    const order = attr("orderBy");
    const limit = attr("limit");
    const envs = this.matches(forValue.bindings, where?.kind === "where" ? where.conditions : [],
      order?.kind === "orderBy" ? order.terms : [], limit?.kind === "expr" ? limit.expr : undefined, env, this.tableShape(forValue.bindings[0]!, () => bindingShape(this.checker, el, forValue.bindings[0]!)));
    if (!envs.length) return fallback();
    const introduced = forValue.bindings.map((b) => b.name);
    const used = new Set<string>();
    usedNames(el, used);
    const expandsBy = introduced.filter((n) => used.has(n));
    const instances: { env: Env; key: string }[] = [];
    const seen = new Set<string>();
    for (const e of envs) {
      const id = expandsBy.map((n) => identity(e.get(n) ?? null)).join("\0");
      if (seen.has(id)) continue;
      seen.add(id);
      instances.push({ env: e, key: canonical(expandsBy.map((n) => keyOf(e.get(n) ?? null))) });
    }
    const group = attr("group");
    if (el.type === "Rows") {
      // One list, a line per match, under a heading per group value (§3.1).
      const lines = (list: typeof instances) => list.map((i) => this.node("#row", {}, el.children ?? [], i.env, i.key));
      const node = this.node("Rows", this.props(el, env), [], env, null);
      node.children = group?.kind === "expr" ? this.groups(group.expr, instances, lines) : lines(instances);
      out.push(node);
      return;
    }
    const draw = (list: typeof instances) => {
      const nodes: Array<ViewNode | string> = [];
      for (const i of list) this.draw(el, i.env, i.key, nodes);
      return nodes;
    };
    if (group?.kind === "expr") out.push(...this.groups(group.expr, instances, draw));
    else out.push(...draw(instances));
  }

  /** Matches grouped by a value: a match is in each group its value reaches, groups in value order. */
  private groups<T extends { env: Env }>(expr: Expr, instances: T[], draw: (list: T[]) => Array<ViewNode | string>): ViewNode[] {
    const groups = new Map<string, { value: Value; list: T[] }>();
    for (const i of instances) {
      const v = this.expr(expr, i.env);
      for (const value of Array.isArray(v) ? (v.length ? v : [null]) : [v]) {
        const id = identity(value);
        const g = groups.get(id) ?? { value, list: [] };
        g.list.push(i);
        groups.set(id, g);
      }
    }
    return [...groups.values()]
      .sort((a, b) => orderOf(a.value, b.value))
      .map((g) => ({ type: "#group", props: { value: toProp(g.value) }, children: draw(g.list), key: identity(g.value) }));
  }

  /** An element once: a declared view drawn in place, or a UI element with its props and children. */
  private draw(el: Element, env: Env, key: string | null, out: Array<ViewNode | string>): void {
    const view = this.checker.views.get(el.type);
    const explicit = el.attributes.find((a) => a.name === "key");
    const ownKey = explicit?.value.kind === "expr" ? canonical(keyOf(this.expr(explicit.value.expr, env))) : key;
    if (view && !view.decl.data) {
      const args: Record<string, Value> = {};
      for (const a of el.attributes) if (!LANGUAGE.has(a.name)) args[a.name] = this.attribute(a, env);
      const inner: Env = new Map();
      for (const p of view.decl.params) inner.set(p.name, this.coerce(p, args[p.name] ?? null));
      for (const node of this.fileOf(view.from).drawView(view.decl, inner)) {
        if (typeof node !== "string" && ownKey !== null && node.key === null) node.key = ownKey;
        const slot = el.attributes.find((a) => a.name === "slot");
        if (slot && typeof node !== "string") node.props.slot = toProp(this.attribute(slot, env));
        out.push(node);
      }
      return;
    }
    out.push(this.node(el.type, this.props(el, env), el.children ?? [], env, ownKey));
  }

  /** An argument drawn into a view's parameter: a key given for a table-typed one becomes its row. */
  private coerce(p: Param, v: Value): Value {
    const type = p.type?.name;
    if (!type || v === null || v instanceof Row || Array.isArray(v)) return v;
    const model = this.checker.models.get(type);
    if (model && model.kind !== "enum") return this.resolveRow(type, v);
    return v;
  }

  private node(type: string, props: Record<string, unknown>, children: Child[], env: Env, key: string | null): ViewNode {
    const out: Array<ViewNode | string> = [];
    for (const child of children) {
      if (child.kind === "comment") continue;
      if (child.kind === "text") {
        const text = this.text(child.parts, env);
        if (text) out.push(text);
      } else this.element(child.element, env, out);
    }
    return { type, props, children: out, key };
  }

  private props(el: Element, env: Env): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const a of el.attributes) {
      if (LANGUAGE.has(a.name) && a.name !== "slot") continue;
      props[a.name] = toProp(this.attribute(a, env));
    }
    return props;
  }

  private attribute(a: Attribute, env: Env): Value {
    switch (a.value.kind) {
      case "expr": return this.expr(a.value.expr, env);
      case "text": return this.text(a.value.text.parts, env);
      case "bare": return true;
      default: return null;
    }
  }

  // ---------------------------------------------------------------- data views

  /** A data view's record, about `about` (the row its bare fields are of), or none at the top. */
  private record(record: DataRecord, env: Env, about: Row | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const entry of record.entries) {
      switch (entry.kind) {
        case "comment": break;
        case "value": out[entry.key] = toJSON(this.expr(entry.value, env)); break;
        case "field": {
          const v = about ? this.field(about, entry.name) : null;
          if (!entry.record) { out[entry.name] = toJSON(v); break; }
          const sub = entry.record;
          if (Array.isArray(v)) out[entry.name] = v.map((x) => this.record(sub, env, x instanceof Row ? x : null));
          else out[entry.name] = v instanceof Row ? this.record(sub, env, v) : null;
          break;
        }
        case "record": {
          const get = (name: string) => entry.attributes.find((a) => a.name === name)?.value;
          const forValue = get("for");
          if (forValue?.kind === "for") {
            const where = get("where"), order = get("orderBy"), limit = get("limit");
            const envs = this.matches(forValue.bindings, where?.kind === "where" ? where.conditions : [],
              order?.kind === "orderBy" ? order.terms : [], limit?.kind === "expr" ? limit.expr : undefined, env, this.tableShape(forValue.bindings[0]!, () => bindingShape(this.checker, entry, forValue.bindings[0]!)));
            const first = forValue.bindings[0]!.name;
            out[entry.key] = envs.map((e) => {
              const row = e.get(first);
              return this.record(entry.record, e, row instanceof Row ? row : null);
            });
            break;
          }
          const ifValue = get("if");
          if (ifValue?.kind === "if" && !ifValue.conditions.every((c) => truthy(this.expr(c, env)))) { out[entry.key] = null; break; }
          out[entry.key] = this.record(entry.record, env, about);
          break;
        }
      }
    }
    return out;
  }
}

/** A value as part of an element's key: a row by its key. */
function keyOf(v: Value): unknown {
  if (v instanceof Row) return v.keyValue ?? null;
  if (v instanceof EnumValue) return v.name;
  return toJSON(v);
}

/** The names an element uses: in its attributes (not `for`, `where` and the other language ones, but `key`), its text, and anywhere among its children. */
export function usedNames(el: Element, used: Set<string>): void {
  for (const a of el.attributes) {
    if (LANGUAGE.has(a.name) && a.name !== "key") continue;
    attributeNames(a, used);
  }
  for (const child of el.children ?? []) childNames(child, used);
}

function childNames(child: Child, used: Set<string>): void {
  if (child.kind === "text") for (const p of child.parts) if (typeof p !== "string") exprNames(p, used);
  if (child.kind === "element") {
    for (const a of child.element.attributes) attributeNames(a, used);
    for (const c of child.element.children ?? []) childNames(c, used);
  }
}

function attributeNames(a: Attribute, used: Set<string>): void {
  const v = a.value;
  if (v.kind === "expr") exprNames(v.expr, used);
  else if (v.kind === "text") exprNames(v.text, used);
  else if (v.kind === "for") v.bindings.forEach((b) => exprNames(b.source, used));
  else if (v.kind === "where" || v.kind === "if") v.conditions.forEach((c) => exprNames(c, used));
  else if (v.kind === "orderBy") v.terms.forEach((t) => exprNames(t.value, used));
}

function exprNames(e: Expr, used: Set<string>): void {
  switch (e.kind) {
    case "name": used.add(e.name); break;
    case "template": e.parts.forEach((p) => typeof p !== "string" && exprNames(p, used)); break;
    case "list": e.items.forEach((x) => exprNames(x, used)); break;
    case "record": e.entries.forEach((y) => exprNames(y.value, used)); break;
    case "field": exprNames(e.object, used); break;
    case "call": e.args.forEach((a) => exprNames(a.value, used)); break;
    case "unary": exprNames(e.operand, used); break;
    case "binary": exprNames(e.left, used); exprNames(e.right, used); break;
    case "choice": exprNames(e.test, used); exprNames(e.then, used); exprNames(e.otherwise, used); break;
    case "comprehension": exprNames(e.binding.source, used); e.where.forEach((c) => exprNames(c, used)); break;
    case "element": usedNames(e.element, used); break;
    default: break;
  }
}

export { compareRows };


/** A value as a condition's leaf: rows by their key, enum values by name, lists as JSON of those. */
export function leafOf(v: Value): LeafValue | null {
  const plain = (x: Value): { ok: true; value: unknown; type: LeafValue["type"] } | { ok: false } => {
    if (x === null) return { ok: true, value: null, type: "null" };
    if (typeof x === "number") return { ok: true, value: x, type: "number" };
    if (typeof x === "string") return { ok: true, value: x, type: "text" };
    if (typeof x === "boolean") return { ok: true, value: x, type: "bool" };
    if (x instanceof Row) {
      const key = x.keyValue;
      return x.key.length === 1 && (typeof key === "string" || typeof key === "number") ? { ok: true, value: key, type: `row:${x.model}` } : { ok: false };
    }
    if (x instanceof EnumValue) return { ok: true, value: x.name, type: `enum:${x.enumName}` };
    return { ok: false };
  };
  if (Array.isArray(v)) {
    if (v.length > 1000) return null;
    const items: unknown[] = [];
    for (const x of v) {
      const p = plain(x);
      if (!p.ok) return null;
      items.push(typeof p.value === "boolean" ? (p.value ? 1 : 0) : p.value);
    }
    return { value: items, type: "array" };
  }
  const p = plain(v);
  return p.ok ? { value: p.value, type: p.type } : null;
}
