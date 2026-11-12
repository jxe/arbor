// What a view reads from a row (spec 1.5 §3): the fields it follows from a bound row, as a
// tree, found from the source alone. A store that can read a row's relationships in the
// same statement as the row (the SQLite store) uses it to answer a whole `for`, and every
// relationship the view follows from it, at once. It is only a hint: a store answers the
// same without it, and a read it leaves out is made when the evaluator asks.

import type { Attribute, Binding, DataRecord, Element, Expr, ViewDecl } from "./ast.ts";
import type { Checker } from "./check.ts";
import { ruleCondition } from "./plan.ts";

/**
 * A `for` over a table nested where an outer row is bound, whose conditions use that row
 * (and no other bound row). A store can read it inside the outer row's statement, one
 * answer per outer row (a correlated subquery), when it can state the conditions in SQL.
 */
export interface CorrelatedRead {
  model: string;
  /** The binding it is read for: its name, and the view adds it once however often it is walked. */
  binding: Binding;
  /** Every name the `for` binds. */
  bound: ReadonlySet<string>;
  /** The outer row's name, as the conditions use it. */
  outer: string;
  where: Expr[];
  order: Array<{ value: Expr; desc: boolean }>;
  limit: Expr | null;
  rules: Checker["rules"];
  shape: ReadShape;
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
  private correlate(b: Binding, bindings: Binding[], filter: Filter, aliases: Aliases): ReadShape | null {
    if (b.source.kind !== "name" || aliases.has(b.source.name) || this.checker.models.get(b.source.name)?.kind !== "data") return null;
    const bound = new Set(bindings.map((x) => x.name));
    const used = new Set<string>();
    const visit = (e: Expr) => namesOf(e, used);
    filter.where.forEach(visit);
    filter.order.forEach((t) => visit(t.value));
    if (filter.limit) visit(filter.limit);
    const outers = [...used].filter((n) => !bound.has(n) && aliases.has(n));
    if (outers.length !== 1) return null;
    const holder = aliases.get(outers[0]!)!;
    const known = holder.correlated.find((r) => r.binding === b);
    if (known) return known.shape;
    const read: CorrelatedRead = {
      model: b.source.name, binding: b, bound, outer: outers[0]!, where: filter.where, order: filter.order, limit: filter.limit,
      rules: this.checker.rules, shape: new ReadShape(),
    };
    holder.correlated.push(read);
    return read.shape;
  }

  /** Bind names that come from chains, for the expressions after them. */
  private bind(bindings: Binding[], aliases: Aliases, filter?: Filter): Map<string, ReadShape> {
    const inner = new Map(aliases);
    for (const [i, b] of bindings.entries()) {
      this.expr(b.source, inner);
      const shape = this.chain(b.source, inner) ?? (i === 0 && filter ? this.correlate(b, bindings, filter, inner) : null) ?? this.tableShape(b.source, inner);
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

/** Every name an expression uses. */
function namesOf(e: Expr, out: Set<string>): void {
  switch (e.kind) {
    case "name": out.add(e.name); break;
    case "template": e.parts.forEach((p) => typeof p !== "string" && namesOf(p, out)); break;
    case "list": e.items.forEach((x) => namesOf(x, out)); break;
    case "record": e.entries.forEach((y) => namesOf(y.value, out)); break;
    case "field": namesOf(e.object, out); break;
    case "call": e.args.forEach((a) => namesOf(a.value, out)); break;
    case "unary": namesOf(e.operand, out); break;
    case "binary": namesOf(e.left, out); namesOf(e.right, out); break;
    case "choice": namesOf(e.test, out); namesOf(e.then, out); namesOf(e.otherwise, out); break;
    case "comprehension": namesOf(e.binding.source, out); e.where.forEach((c) => namesOf(c, out)); break;
    default: break;
  }
}
