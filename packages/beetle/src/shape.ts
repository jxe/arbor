// What a view reads from a row (spec 1.5 §3): the fields it follows from a bound row, as a
// tree, found from the source alone. A store that can read a row's relationships in the
// same statement as the row (the SQLite store) uses it to answer a whole `for`, and every
// relationship the view follows from it, at once. It is only a hint: a store answers the
// same without it, and a read it leaves out is made when the evaluator asks.

import type { Attribute, Binding, DataRecord, Element, Expr, ViewDecl } from "./ast.ts";
import type { Checker } from "./check.ts";
import { ruleCondition } from "./plan.ts";

/** The fields read from a row, each with what is read from the rows it reaches. */
export class ReadShape {
  readonly fields = new Map<string, ReadShape>();

  child(name: string): ReadShape {
    let c = this.fields.get(name);
    if (!c) this.fields.set(name, (c = new ReadShape()));
    return c;
  }

  get empty(): boolean {
    return this.fields.size === 0;
  }
}

type Aliases = ReadonlyMap<string, ReadShape>;

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

  /** Bind names that come from chains, for the expressions after them. */
  private bind(bindings: Binding[], aliases: Aliases): Map<string, ReadShape> {
    const inner = new Map(aliases);
    for (const b of bindings) {
      this.expr(b.source, inner);
      const shape = this.chain(b.source, inner) ?? this.tableShape(b.source, inner);
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
    const inner = forValue?.kind === "for" ? this.bind(forValue.bindings, aliases) : aliases;
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
          const inner = bindings.length ? this.bind(bindings, aliases) : aliases;
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
