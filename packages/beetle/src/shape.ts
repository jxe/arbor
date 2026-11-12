// What a view reads from a row (spec 1.5 §3): the fields it follows from a bound row, as a
// tree, found from the source alone. A store that can read a row's relationships in the
// same statement as the row (the SQLite store) uses it to answer a whole `for`, and every
// relationship the view follows from it, at once. It is only a hint: a store answers the
// same without it, and a read it leaves out is made when the evaluator asks.

import type { Attribute, Binding, DataRecord, Element, Expr, ViewDecl } from "./ast.ts";
import type { Checker } from "./check.ts";
import { ruleCondition } from "./plan.ts";

/** One side of a condition in a correlated read. */
export type ConditionSide =
  /** A field of the row being read. */
  | { self: string }
  /** The outer row (`field` absent) or one of its fields. */
  | { outer: true; field?: string }
  | { literal: string | number | boolean | null }
  /** Anything else: a parameter, a call, another row. */
  | { other: true };

/**
 * A `for` over a table nested where an outer row is bound, whose conditions compare the
 * table's fields with that row's fields or with literals. A store can read it inside the
 * outer row's statement, one answer per outer row (a correlated subquery).
 */
export interface CorrelatedRead {
  model: string;
  /** Each `==`/`!=` condition, as the evaluator splits `and`. */
  conditions: Array<{ op: "==" | "!="; left: ConditionSide; right: ConditionSide }>;
  /** True when some condition isn't a comparison: then the evaluator keeps no ordering or limit. */
  partial: boolean;
  order: Array<{ field: string | null; desc: boolean }>;
  limit: number | null;
  /** True when the `for` binds more than one name, so the evaluator keeps no ordering or limit. */
  joined: boolean;
  shape: ReadShape;
  /** The binding it is read for, so a view walked twice adds it once. */
  binding: Binding;
}

/** The fields read from a row, each with what is read from the rows it reaches. */
export class ReadShape {
  readonly fields = new Map<string, ReadShape>();
  /** Reads of other tables made once per row, narrowed by its fields. */
  readonly correlated: CorrelatedRead[] = [];

  child(name: string): ReadShape {
    let c = this.fields.get(name);
    if (!c) this.fields.set(name, (c = new ReadShape()));
    return c;
  }

  get empty(): boolean {
    return this.fields.size === 0 && this.correlated.length === 0;
  }
}

type Aliases = ReadonlyMap<string, ReadShape>;

/** A `for`'s conditions, ordering and limit. */
interface Filter {
  where: Expr[];
  order: Array<{ value: Expr; desc: boolean }>;
  limit: Expr | null;
}

function filterOf(attributes: Attribute[]): Filter {
  const get = (name: string) => attributes.find((a) => a.name === name)?.value;
  const where = get("where"), order = get("orderBy"), limit = get("limit");
  return {
    where: where?.kind === "where" ? where.conditions : [],
    order: order?.kind === "orderBy" ? order.terms : [],
    limit: limit?.kind === "expr" ? limit.expr : null,
  };
}

const MAX_DEPTH = 8;

class Walker {
  /** Views and rules already being walked with these shapes, so recursion ends. */
  private readonly active = new Set<unknown>();
  private depth = 0;

  /**
   * With `tables`, every binding over a whole table shares one shape per table, so one
   * read of the table serves every place the view ranges over it.
   */
  constructor(private readonly checker: Checker, private readonly tables?: Map<string, ReadShape>) {}

  private tableShape(e: Expr, aliases: Aliases): ReadShape | null {
    if (!this.tables || e.kind !== "name" || aliases.has(e.name) || this.checker.models.get(e.name)?.kind !== "data") return null;
    let shape = this.tables.get(e.name);
    if (!shape) this.tables.set(e.name, (shape = new ReadShape()));
    return shape;
  }

  /** The shape a field chain rooted at a bound name reaches, or null. */
  private chain(e: Expr, aliases: Aliases): ReadShape | null {
    if (e.kind === "name") return aliases.get(e.name) ?? null;
    if (e.kind === "field") {
      const object = this.chain(e.object, aliases);
      return object ? object.child(e.name) : null;
    }
    return null;
  }

  /**
   * A `for`'s first binding over a table whose conditions name exactly one outer row: read
   * once per outer row, inside that row's own read.
   */
  private correlate(b: Binding, filter: Filter, aliases: Aliases, joined: boolean): ReadShape | null {
    if (b.source.kind !== "name" || aliases.has(b.source.name) || this.checker.models.get(b.source.name)?.kind !== "data") return null;
    const conjuncts: Expr[] = [];
    const split = (e: Expr) => { if (e.kind === "binary" && e.operator === "and") { split(e.left); split(e.right); } else conjuncts.push(e); };
    filter.where.forEach(split);
    let outer: string | null = null;
    const side = (e: Expr): ConditionSide => {
      if (e.kind === "field" && e.object.kind === "name" && e.object.name === b.name) return { self: e.name };
      if (e.kind === "literal") return { literal: e.value };
      const root = e.kind === "name" ? e.name : e.kind === "field" && e.object.kind === "name" ? e.object.name : null;
      if (root && root !== b.name && aliases.has(root) && (outer === null || outer === root)) {
        outer = root;
        return e.kind === "field" ? { outer: true, field: e.name } : { outer: true };
      }
      return { other: true };
    };
    const conditions: CorrelatedRead["conditions"] = [];
    let partial = false;
    for (const c of conjuncts) {
      if (c.kind === "binary" && (c.operator === "==" || c.operator === "!=")) conditions.push({ op: c.operator, left: side(c.left), right: side(c.right) });
      else partial = true;
    }
    if (outer === null) return null;
    const limit = filter.limit?.kind === "literal" && typeof filter.limit.value === "number" ? filter.limit.value : null;
    if (filter.limit && limit === null) partial = true;
    const holder = aliases.get(outer)!;
    const known = holder.correlated.find((r) => r.binding === b);
    if (known) return known.shape;
    const read: CorrelatedRead = {
      model: b.source.name, conditions, partial, joined, limit, shape: new ReadShape(), binding: b,
      order: filter.order.map((t) => ({ field: t.value.kind === "field" && t.value.object.kind === "name" && t.value.object.name === b.name ? t.value.name : null, desc: t.desc })),
    };
    holder.correlated.push(read);
    return read.shape;
  }

  /** Bind names that come from chains, for the expressions after them. */
  private bind(bindings: Binding[], aliases: Aliases, filter?: Filter): Map<string, ReadShape> {
    const inner = new Map(aliases);
    for (const [i, b] of bindings.entries()) {
      this.expr(b.source, inner);
      const shape = this.chain(b.source, inner) ?? (i === 0 && filter ? this.correlate(b, filter, inner, bindings.length > 1) : null) ?? this.tableShape(b.source, inner);
      if (shape) inner.set(b.name, shape);
      else inner.delete(b.name);
    }
    return inner;
  }

  expr(e: Expr, aliases: Aliases): void {
    switch (e.kind) {
      case "field": this.chain(e, aliases) ?? this.expr(e.object, aliases); break;
      case "template": e.parts.forEach((p) => typeof p !== "string" && this.expr(p, aliases)); break;
      case "list": e.items.forEach((x) => this.expr(x, aliases)); break;
      case "record": e.entries.forEach((y) => this.expr(y.value, aliases)); break;
      case "unary": this.expr(e.operand, aliases); break;
      case "binary": this.expr(e.left, aliases); this.expr(e.right, aliases); break;
      case "choice": this.expr(e.test, aliases); this.expr(e.then, aliases); this.expr(e.otherwise, aliases); break;
      case "element": this.element(e.element, aliases); break;
      case "comprehension": {
        const inner = this.bind([e.binding], aliases);
        e.where.forEach((c) => this.expr(c, inner));
        break;
      }
      case "call": {
        e.args.forEach((a) => this.expr(a.value, aliases));
        const rule = this.checker.rules.get(e.callee);
        if (!rule || this.depth >= MAX_DEPTH) break;
        for (const decl of rule.decls) {
          if (decl.params.length !== e.args.length) continue;
          const inner = new Map<string, ReadShape>();
          decl.params.forEach((p, i) => { const s = this.chain(e.args[i]!.value, aliases); if (s) inner.set(p.name, s); });
          if (!inner.size) continue;
          this.nested(decl, () => this.expr(ruleCondition(decl), inner));
        }
        break;
      }
      default: break;
    }
  }

  private nested(key: unknown, walk: () => void): void {
    if (this.active.has(key) || this.depth >= MAX_DEPTH) return;
    this.active.add(key);
    this.depth++;
    try {
      walk();
    } finally {
      this.depth--;
      this.active.delete(key);
    }
  }

  attribute(a: Attribute, aliases: Aliases): void {
    const v = a.value;
    if (v.kind === "expr") this.expr(v.expr, aliases);
    else if (v.kind === "text") this.expr(v.text, aliases);
    else if (v.kind === "where" || v.kind === "if") v.conditions.forEach((c) => this.expr(c, aliases));
    else if (v.kind === "orderBy") v.terms.forEach((t) => this.expr(t.value, aliases));
  }

  /** An element's reads: its `for` binds first, then everything else sees its names. */
  element(el: Element, aliases: Aliases): void {
    const forValue = el.attributes.find((a) => a.name === "for")?.value;
    const inner = forValue?.kind === "for" ? this.bind(forValue.bindings, aliases, filterOf(el.attributes)) : aliases;
    for (const a of el.attributes) if (a.name !== "for") this.attribute(a, a.name === "fallback" ? aliases : inner);
    for (const child of el.children ?? []) {
      if (child.kind === "element") this.element(child.element, inner);
      else if (child.kind === "text") child.parts.forEach((p) => typeof p !== "string" && this.expr(p, inner));
    }
    // A view drawn here reads from its arguments what its own body does from its parameters.
    const view = this.checker.views.get(el.type)?.decl;
    if (view) {
      const params = new Map<string, ReadShape>();
      for (const a of el.attributes) {
        if (a.value.kind !== "expr") continue;
        const s = this.chain(a.value.expr, inner);
        if (s) params.set(a.name, s);
      }
      if (params.size) this.nested(view, () => this.view(view, params));
    }
  }

  view(decl: ViewDecl, aliases: Aliases): void {
    for (const line of decl.lines) if (line.kind === "state" || line.kind === "keep") this.expr(line.value, aliases);
    if (decl.body) this.element(decl.body, aliases);
    if (decl.data) this.record(decl.data, aliases, null);
  }

  /** A data record's reads, `about` being the shape of the row its bare fields are of. */
  record(record: DataRecord, aliases: Aliases, about: ReadShape | null): void {
    for (const entry of record.entries) {
      switch (entry.kind) {
        case "value": this.expr(entry.value, aliases); break;
        case "field": {
          const shape = about?.child(entry.name) ?? null;
          if (entry.record) this.record(entry.record, aliases, shape);
          break;
        }
        case "record": {
          const forValue = entry.attributes.find((a) => a.name === "for")?.value;
          const bindings = forValue?.kind === "for" ? forValue.bindings : [];
          const inner = bindings.length ? this.bind(bindings, aliases, filterOf(entry.attributes)) : aliases;
          for (const a of entry.attributes) if (a.name !== "for") this.attribute(a, inner);
          this.record(entry.record, inner, bindings.length ? inner.get(bindings[0]!.name) ?? null : about);
          break;
        }
        default: break;
      }
    }
  }
}

const elementShapes = new WeakMap<object, ReadShape>();

/**
 * What an element (or a data view's record entry) with a `for` reads from its first
 * binding's rows, everywhere below it.
 */
export function bindingShape(checker: Checker, owner: Element | Extract<DataRecord["entries"][number], { kind: "record" }>, binding: Binding): ReadShape {
  let shape = elementShapes.get(owner);
  if (shape) return shape;
  shape = new ReadShape();
  const walker = new Walker(checker);
  const aliases = new Map([[binding.name, shape]]);
  if ("type" in owner) {
    // The element as though its `for` had bound the row already.
    walker.element({ ...owner, attributes: owner.attributes.filter((a) => a.name !== "for") }, aliases);
  } else {
    for (const a of owner.attributes) if (a.name !== "for") walker.attribute(a, aliases);
    walker.record(owner.record, aliases, shape);
  }
  elementShapes.set(owner, shape);
  return shape;
}

export interface ViewShapes {
  /** What the view reads from each parameter's row. */
  params: Map<string, ReadShape>;
  /** For each table the view ranges over whole (`for l in List`), what it reads from its rows anywhere. */
  tables: Map<string, ReadShape>;
}

const viewShapeCache = new WeakMap<ViewDecl, ViewShapes>();

/** What a view reads, from its parameters and from the tables it ranges over. */
export function viewShapes(checker: Checker, decl: ViewDecl): ViewShapes {
  let shapes = viewShapeCache.get(decl);
  if (shapes) return shapes;
  shapes = { params: new Map(decl.params.map((p) => [p.name, new ReadShape()])), tables: new Map() };
  new Walker(checker, shapes.tables).view(decl, shapes.params);
  viewShapeCache.set(decl, shapes);
  return shapes;
}

/** What a comprehension (`count(l in List where …)`) reads from the rows it ranges over. */
export function comprehensionShape(checker: Checker, e: Extract<Expr, { kind: "comprehension" }>): ReadShape {
  let shape = elementShapes.get(e);
  if (shape) return shape;
  shape = new ReadShape();
  const walker = new Walker(checker);
  const aliases = new Map([[e.binding.name, shape]]);
  e.where.forEach((c) => walker.expr(c, aliases));
  elementShapes.set(e, shape);
  return shape;
}
