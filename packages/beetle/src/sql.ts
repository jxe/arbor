// Beetle conditions as SQL (spec 1.5 §3.2): a `for`'s `where` over one table, translated
// so a SQL store can narrow the rows it reads. The evaluator still applies every
// condition to what comes back, so a translation only has to keep every row Beetle would
// keep. Each condition is translated twice over: `sup`, true of every row Beetle keeps
// (it may keep more), and `sub`, true only of rows Beetle keeps (it may keep fewer). Where
// the two are the same the translation is exact, and only an exact `where` lets a store
// apply the `for`'s ordering and limit too.
//
// Values the condition doesn't take from the row (parameters, `me`, an outer row's
// fields) are leaves: the caller says what each is, and they are written into the SQL as
// values (or, for a read nested in an outer row's statement, as that row's columns). A
// condition is a template with a marker for the row's alias and one for each leaf, so the
// same read asked twice has the same text and values.

import type { Expr } from "./ast.ts";
import type { Checker } from "./check.ts";
import { ruleCondition } from "./plan.ts";
import { PERSON_RELATION, type Relationship, type Table } from "@ovst/usl";
import type { StoreSchema } from "./store.ts";

/** Marks the row's alias in a condition's template. */
export const SELF = "\u0002";
const LEAF = "\u0001";

/** What a value is known to be, as far as comparing it in SQL goes. */
export type SQLType = "number" | "text" | "date" | "bool" | "null" | "array" | `row:${string}` | `enum:${string}` | "any";

/** A leaf's value as the SQL gets it: a value, or (nested in an outer row's read) one of that row's columns. */
export type LeafValue =
  | { value: unknown; type: SQLType }
  | { outer: string; type: SQLType; truthy?: boolean };

/** A condition over one table's rows: a template, and its leaves' values in order. */
export interface Condition {
  template: string;
  leaves: LeafValue[];
}

export interface TranslateContext {
  schema: StoreSchema;
  rules: Checker["rules"];
  /** The model the row is of, and the name it's bound to. */
  model: string;
  self: string;
  /** Every name the `for` binds: an expression using one isn't a leaf. */
  bound: ReadonlySet<string>;
  /** A value the condition doesn't take from the row, or null when it can't be known. */
  leaf(e: Expr): LeafValue | null;
  /** The same for a whole condition that doesn't use the row: true or false, as 1 or 0. */
  leafCondition(e: Expr): LeafValue | null;
}

interface Translation {
  sup: string;
  sub: string;
}

const UNKNOWN: Translation = { sup: "1", sub: "0" };
const exact = (sql: string): Translation => ({ sup: sql, sub: sql });
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A text literal in SQL. */
export function sqlText(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** A leaf's value in SQL: flags as 1/0, lists as JSON text. */
export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return sqlText(value);
  return sqlText(JSON.stringify(value));
}

/** A condition's SQL with the row's alias and its leaves in place. */
export function renderCondition(template: string, alias: string, leaf: (index: number) => string): string {
  return template.replaceAll(SELF, alias).replace(/\u0001(\d+)\u0001/g, (_, i: string) => leaf(Number(i)));
}

/** What Beetle counts as true, for a value of a known type, as a SQL condition that is never null, or null when unknown. */
export function truthyCondition(sql: string, type: SQLType): string | null {
  const t = truthySQL(sql, type);
  return t.sup === t.sub ? t.sup : null;
}

/** What Beetle counts as true, for a value of a known type, as a SQL condition that is never null. */
function truthySQL(sql: string, type: SQLType): Translation {
  switch (type) {
    case "bool": case "number": return exact(`coalesce(${sql}, 0) != 0`);
    case "text": case "date": return exact(`coalesce(${sql}, '') != ''`);
    case "array": return exact(`coalesce(json_array_length(${sql}), 0) > 0`);
    case "null": return exact("0");
    case "any": return UNKNOWN;
    default: return exact(`${sql} is not null`);
  }
}

/** The type of values a column holds. */
function columnType(table: Table, column: string): SQLType | null {
  const c = table.columns.find((x) => x.name === column);
  if (!c) return null;
  if (c.array) return "array";
  switch (c.type) {
    case "int": case "number": case "position": return "number";
    case "bool": return "bool";
    case "date": case "timestamp": return "date";
    case "text": return "text";
  }
}

/** Whether Beetle's `==` on values of these types is SQL's `is`. */
function sameKind(a: SQLType, b: SQLType): boolean {
  if (a === "null" || b === "null") return true;
  if (a === b) return a !== "array" && a !== "any";
  const textual = (t: SQLType) => t === "text" || t === "date" || t.startsWith("enum:") || t.startsWith("row:");
  // A row equals its key, an enum value its name; two rows only rows of one model.
  if (a.startsWith("row:") && b.startsWith("row:")) return false;
  if (a.startsWith("enum:") && b.startsWith("enum:")) return false;
  return textual(a) && textual(b);
}

class Translator {
  readonly leaves: LeafValue[] = [];
  private aliases = 0;
  private depth = 0;
  /** True when a leaf couldn't be known: the translation then holds for no read nested in an outer row. */
  unknownLeaf = false;

  constructor(private readonly ctx: TranslateContext) {}

  private alias(): string {
    return `${SELF}_${++this.aliases}`;
  }

  private names(e: Expr, out: Set<string>): void {
    switch (e.kind) {
      case "name": out.add(e.name); break;
      case "template": e.parts.forEach((p) => typeof p !== "string" && this.names(p, out)); break;
      case "list": e.items.forEach((x) => this.names(x, out)); break;
      case "record": e.entries.forEach((y) => this.names(y.value, out)); break;
      case "field": this.names(e.object, out); break;
      case "call": e.args.forEach((a) => this.names(a.value, out)); break;
      case "unary": this.names(e.operand, out); break;
      case "binary": this.names(e.left, out); this.names(e.right, out); break;
      case "choice": this.names(e.test, out); this.names(e.then, out); this.names(e.otherwise, out); break;
      case "comprehension": this.names(e.binding.source, out); e.where.forEach((c) => this.names(c, out)); break;
      case "element": out.add(this.ctx.self); break; // never a leaf
      default: break;
    }
  }

  private free(e: Expr): boolean {
    const used = new Set<string>();
    this.names(e, used);
    return ![...used].some((n) => this.ctx.bound.has(n));
  }

  private leaf(value: LeafValue): string {
    this.leaves.push(value);
    return `${LEAF}${this.leaves.length - 1}${LEAF}`;
  }

  /** A value the row gives, as SQL and its type, or null when it can't be stated. */
  value(e: Expr): { sql: string; type: SQLType } | null {
    if (this.free(e)) {
      const v = this.ctx.leaf(e);
      if (!v) { this.unknownLeaf = true; return null; }
      return { sql: this.leaf(v), type: v.type };
    }
    const table = this.ctx.schema.byName.get(this.ctx.schema.tableOf(this.ctx.model) ?? "");
    if (!table) return null;
    const self = quote(SELF);
    if (e.kind === "name" && e.name === this.ctx.self) {
      return table.primaryKey.length === 1 ? { sql: `${self}.${quote(table.primaryKey[0]!)}`, type: `row:${this.ctx.model}` } : null;
    }
    if (e.kind === "field" && e.object.kind === "name" && e.object.name === this.ctx.self) {
      const place = this.ctx.schema.place(this.ctx.model, e.name);
      if (place.kind === "column") {
        const type = columnType(table, place.column);
        return type ? { sql: `${self}.${quote(place.column)}`, type } : null;
      }
      if (place.kind === "reference" && place.columns.length === 1) {
        const type: SQLType = place.target === "Person" ? "row:Person" : `enum:${place.target}`;
        return { sql: `${self}.${quote(place.columns[0]!)}`, type };
      }
      if (place.kind === "relationship") {
        const r = place.relationship;
        // A row this one refers to by a column it holds (`item.list`).
        if (r.cardinality !== "many" && r.direct?.length === 1 && r.target !== PERSON_RELATION) {
          const target = this.ctx.schema.byName.get(r.target);
          if (target?.primaryKey.length === 1 && target.primaryKey[0] === r.direct[0]!.target) {
            return { sql: `${self}.${quote(r.direct[0]!.source)}`, type: `row:${target.stores}` };
          }
        }
      }
      return null;
    }
    if (e.kind === "binary") {
      const a = this.value(e.left);
      const b = a ? this.value(e.right) : null;
      if (!a || !b) return null;
      const numeric = (t: SQLType) => t === "number" || t === "null";
      const textual = (t: SQLType) => t === "text" || t === "null";
      switch (e.operator) {
        case "+":
          if (numeric(a.type) && numeric(b.type)) return { sql: `(${a.sql} + ${b.sql})`, type: "number" };
          if (textual(a.type) && textual(b.type) && (a.type === "text" || b.type === "text")) {
            return { sql: `(coalesce(${a.sql}, '') || coalesce(${b.sql}, ''))`, type: "text" };
          }
          return null;
        case "-": case "*":
          return numeric(a.type) && numeric(b.type) ? { sql: `(${a.sql} ${e.operator} ${b.sql})`, type: "number" } : null;
        case "/":
          return numeric(a.type) && numeric(b.type) ? { sql: `(${a.sql} * 1.0 / nullif(${b.sql}, 0))`, type: "number" } : null;
        case "??":
          if (a.type === b.type || b.type === "null") return { sql: `coalesce(${a.sql}, ${b.sql})`, type: a.type };
          if (a.type === "null") return { sql: `coalesce(${a.sql}, ${b.sql})`, type: b.type };
          return null;
        default: return null;
      }
    }
    if (e.kind === "call" && e.callee === "length" && e.args.length === 1) {
      const a = this.value(e.args[0]!.value);
      return a && (a.type === "text" || a.type === "null") ? { sql: `length(${a.sql})`, type: "number" } : null;
    }
    return null;
  }

  /**
   * The rows a chain of relationships from the row reaches (`l.items.practice.authors`):
   * SQL tables and conditions that join them, and the final values to compare with.
   */
  private reach(e: Expr): { from: string[]; where: string[]; value: string; type: SQLType } | null {
    const fields: string[] = [];
    let at = e;
    while (at.kind === "field") { fields.unshift(at.name); at = at.object; }
    if (at.kind !== "name" || at.name !== this.ctx.self || !fields.length) return null;
    const schema = this.ctx.schema;
    let table = schema.byName.get(schema.tableOf(this.ctx.model) ?? "");
    if (!table) return null;
    let alias = quote(SELF);
    const from: string[] = [];
    const where: string[] = [];
    let many = false;
    for (const [i, field] of fields.entries()) {
      const place = schema.place(table.stores, field);
      const last = i === fields.length - 1;
      if (place.kind === "relationship") {
        const r: Relationship = place.relationship;
        if (r.cardinality === "many") many = true;
        if (r.direct) {
          const target = schema.byName.get(r.target);
          if (!target) return null;
          const next = quote(this.alias());
          from.push(`${quote(target.name)} as ${next}`);
          where.push(...r.direct.map((p) => `${next}.${quote(p.target)} is ${alias}.${quote(p.source)}`));
          table = target;
          alias = next;
        } else if (r.through) {
          const join = schema.byName.get(r.through.relation);
          if (!join) return null;
          const j = quote(this.alias());
          from.push(`${quote(join.name)} as ${j}`);
          where.push(...r.through.source.map((p) => `${j}.${quote(p.through)} is ${alias}.${quote(p.source)}`));
          if (r.target === PERSON_RELATION) {
            // People are the profile ids the join rows hold.
            if (!last || r.through.target.length !== 1) return null;
            return many ? { from, where, value: `${j}.${quote(r.through.target[0]!.through)}`, type: "row:Person" } : null;
          }
          const target = schema.byName.get(r.target);
          if (!target) return null;
          const next = quote(this.alias());
          from.push(`${quote(target.name)} as ${next}`);
          where.push(...r.through.target.map((p) => `${next}.${quote(p.target)} is ${j}.${quote(p.through)}`));
          table = target;
          alias = next;
        } else return null;
        if (last) {
          if (!many || table.primaryKey.length !== 1) return null;
          return { from, where, value: `${alias}.${quote(table.primaryKey[0]!)}`, type: `row:${table.stores}` };
        }
        continue;
      }
      // The chain ends at a value of the rows it reached.
      if (!last || !many) return null;
      if (place.kind === "column") {
        const type = columnType(table, place.column);
        if (!type || type === "array") return null;
        return { from, where, value: `${alias}.${quote(place.column)}`, type };
      }
      if (place.kind === "reference" && place.columns.length === 1) {
        return { from, where, value: `${alias}.${quote(place.columns[0]!)}`, type: place.target === "Person" ? "row:Person" : `enum:${place.target}` };
      }
      return null;
    }
    return null;
  }

  /** `a in b`: true when the list `b` holds `a`, or the text `b` contains it. */
  private contains(set: Expr, item: Expr): Translation {
    const chain = this.reach(set);
    if (chain) {
      const a = this.value(item);
      if (!a) return UNKNOWN;
      const sql = `exists (select 1 from ${chain.from.join(", ")} where ${[...chain.where, `${chain.value} is ${a.sql}`].join(" and ")})`;
      if (a.type === "null") return exact("0");
      return sameKind(chain.type, a.type) ? exact(sql) : { sup: sql, sub: "0" };
    }
    const b = this.value(set);
    const a = b ? this.value(item) : null;
    if (!a || !b) return UNKNOWN;
    if (b.type === "array") {
      const sql = `coalesce((select 1 from json_each(${b.sql}) where value is ${a.sql}), 0) = 1`;
      const plain = a.type === "number" || a.type === "text" || a.type === "date" || a.type.startsWith("enum:") || a.type.startsWith("row:");
      return plain ? exact(sql) : { sup: sql, sub: "0" };
    }
    if (b.type === "text" && a.type === "text") return exact(`coalesce(instr(${b.sql}, ${a.sql}), 0) > 0`);
    if (b.type === "null") return exact("0");
    // Anything else contains only itself.
    return this.equals(a, b);
  }

  private equals(a: { sql: string; type: SQLType }, b: { sql: string; type: SQLType }): Translation {
    const sql = `(${a.sql} is ${b.sql})`;
    if (a.type === "any" || b.type === "any") return { sup: sql, sub: "0" };
    return sameKind(a.type, b.type) ? exact(sql) : UNKNOWN;
  }

  /** A condition, as SQL that is never null. */
  condition(e: Expr): Translation {
    if (this.depth > 16) return UNKNOWN;
    if (this.free(e)) {
      const v = this.ctx.leafCondition(e);
      if (!v) { this.unknownLeaf = true; return UNKNOWN; }
      return exact(`(${this.leaf(v)} = 1)`);
    }
    switch (e.kind) {
      case "unary": {
        if (e.operator !== "not") return UNKNOWN;
        const x = this.condition(e.operand);
        return { sup: negate(x.sub), sub: negate(x.sup) };
      }
      case "binary": {
        switch (e.operator) {
          case "and": {
            const a = this.condition(e.left), b = this.condition(e.right);
            return { sup: and(a.sup, b.sup), sub: and(a.sub, b.sub) };
          }
          case "or": {
            const a = this.condition(e.left), b = this.condition(e.right);
            return { sup: or(a.sup, b.sup), sub: or(a.sub, b.sub) };
          }
          case "==": case "!=": {
            const a = this.value(e.left);
            const b = a ? this.value(e.right) : null;
            if (!a || !b) return UNKNOWN;
            const eq = this.equals(a, b);
            return e.operator === "==" ? eq : { sup: negate(eq.sub), sub: negate(eq.sup) };
          }
          case "<": case "<=": case ">": case ">=": {
            const a = this.value(e.left);
            const b = a ? this.value(e.right) : null;
            if (!a || !b) return UNKNOWN;
            const sql = `coalesce(${a.sql} ${e.operator} ${b.sql}, 0)`;
            const kinds = new Set([a.type, b.type]);
            kinds.delete("null");
            if (kinds.size === 0) return exact("0");
            // Numbers, flags and dates (whose text is ASCII) order alike in both.
            const known = [...kinds];
            if (known.length === 1 && (known[0] === "number" || known[0] === "bool" || known[0] === "date")) return exact(sql);
            if (kinds.has("date") && kinds.has("text") && kinds.size === 2) return exact(sql);
            if (kinds.has("any") && known.every((k) => k === "any" || k === "number" || k === "date")) return { sup: sql, sub: "0" };
            return UNKNOWN;
          }
          case "in": case "∈": return this.contains(e.right, e.left);
          case "∉": { const x = this.contains(e.right, e.left); return { sup: negate(x.sub), sub: negate(x.sup) }; }
          case "excludes": { const x = this.contains(e.left, e.right); return { sup: negate(x.sub), sub: negate(x.sup) }; }
          default: break;
        }
        break;
      }
      case "call": {
        const rule = this.ctx.rules.get(e.callee);
        if (rule) {
          const decls = rule.decls.filter((d) => d.params.length === e.args.length);
          if (!decls.length) return exact("0");
          this.depth++;
          try {
            let out: Translation | null = null;
            for (const d of decls) {
              const body = substitute(ruleCondition(d), new Map(d.params.map((p, i) => [p.name, e.args[i]!.value])));
              if (!body) return UNKNOWN;
              const x = this.condition(body);
              out = out ? { sup: or(out.sup, x.sup), sub: or(out.sub, x.sub) } : x;
            }
            return out!;
          } finally {
            this.depth--;
          }
        }
        break;
      }
      default: break;
    }
    // Anything else is true when its value is.
    const v = this.value(e);
    return v ? truthySQL(v.sql, v.type) : UNKNOWN;
  }
}

function negate(sql: string): string {
  if (sql === "1") return "0";
  if (sql === "0") return "1";
  return `not (${sql})`;
}

function and(a: string, b: string): string {
  if (a === "0" || b === "0") return "0";
  if (a === "1") return b;
  if (b === "1") return a;
  return `(${a} and ${b})`;
}

function or(a: string, b: string): string {
  if (a === "1" || b === "1") return "1";
  if (a === "0") return b;
  if (b === "0") return a;
  return `(${a} or ${b})`;
}

/** A rule's condition with its parameters replaced by the call's arguments, or null when names could be captured. */
function substitute(e: Expr, args: ReadonlyMap<string, Expr>): Expr | null {
  const go = (x: Expr): Expr | null => {
    switch (x.kind) {
      case "name": return args.get(x.name) ?? x;
      case "field": { const o = go(x.object); return o && { ...x, object: o }; }
      case "unary": { const o = go(x.operand); return o && { ...x, operand: o }; }
      case "binary": { const l = go(x.left), r = go(x.right); return l && r && { ...x, left: l, right: r }; }
      case "choice": { const t = go(x.test), a = go(x.then), b = go(x.otherwise); return t && a && b && { ...x, test: t, then: a, otherwise: b }; }
      case "call": {
        const out = x.args.map((a) => go(a.value));
        return out.every(Boolean) ? { ...x, args: x.args.map((a, i) => ({ ...a, value: out[i]! })) } : null;
      }
      case "list": { const items = x.items.map(go); return items.every(Boolean) ? { ...x, items: items as Expr[] } : null; }
      case "template": {
        const parts = x.parts.map((p) => (typeof p === "string" ? p : go(p)));
        return parts.every((p) => p !== null) ? { ...x, parts: parts as typeof x.parts } : null;
      }
      case "literal": case "duration": return x;
      // A comprehension or record binds or nests names of its own: left to the evaluator.
      default: return null;
    }
  };
  return go(e);
}

/**
 * A `for`'s conditions as one SQL condition over its table, or null when none narrows it.
 * `exact` says every condition was translated exactly, so the store may also order and
 * cut what it reads. `unknownLeaf` says some value couldn't be known.
 */
export function translateWhere(ctx: TranslateContext, conditions: readonly Expr[]): { condition: Condition | null; exact: boolean; unknownLeaf: boolean } {
  const t = new Translator(ctx);
  const conjuncts: Expr[] = [];
  const split = (e: Expr) => { if (e.kind === "binary" && e.operator === "and") { split(e.left); split(e.right); } else conjuncts.push(e); };
  conditions.forEach(split);
  let sup = "1";
  let isExact = true;
  for (const c of conjuncts) {
    const x = t.condition(c);
    if (x.sup !== x.sub) isExact = false;
    sup = and(sup, x.sup);
  }
  if (sup === "1") return { condition: null, exact: isExact, unknownLeaf: t.unknownLeaf };
  return { condition: { template: sup, leaves: t.leaves }, exact: isExact, unknownLeaf: t.unknownLeaf };
}
