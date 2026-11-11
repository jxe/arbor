// A view's plan (spec 4.1 §10.2): every read in it, found from the source alone. Each
// element that reads gets an ElementPlan, nested as the elements are, so a child's reads
// run once per match of its ancestors. Rules are expanded in place. Conditions and
// orderings that read state are split off for the client, which evaluates them over the
// rows the host returns.

import type { Element, Expr, TextPart } from "./ast.ts";
import type { Checker } from "./check.ts";

/** An expression in a plan: the source's expression with every name resolved. */
export type PlanExpr =
  | { name: string }
  | { param: string }
  | { state: string }
  | { builtin: string }
  | { model: string }
  | { path: PlanExpr; fields: string[] }
  | { value: string | number | boolean | null }
  | { text: (string | PlanExpr)[] }
  | { list: PlanExpr[] }
  | { record: Record<string, PlanExpr> }
  | { op: string; args: PlanExpr[] }
  | { call: string; args: PlanExpr[] }
  | { call: string; over: { name: string; source: PlanExpr }; where: PlanExpr[] }
  | { action: string; args: Record<string, PlanExpr> }
  | { set: string; value: PlanExpr }
  | { element: string };

export interface OrderPlan {
  value: PlanExpr;
  desc: boolean;
}

export interface ElementPlan {
  type: string;
  /** Where the element starts, `line:column`. */
  at: string;
  for?: { name: string; source: PlanExpr }[];
  /** Conditions the host evaluates. */
  where?: PlanExpr[];
  /** Conditions that read state, which the client evaluates. */
  clientWhere?: PlanExpr[];
  orderBy?: OrderPlan[];
  clientOrderBy?: OrderPlan[];
  limit?: PlanExpr;
  /** The names the element appears once per distinct combination of. */
  expandsBy?: string[];
  /** Paths and aggregates its attributes and text read. */
  reads?: PlanExpr[];
  /** A named view drawn here, whose plan joins this one with these arguments. */
  draws?: { view: string; from: string; args: Record<string, PlanExpr> };
  fallback?: ElementPlan;
  children?: ElementPlan[];
}

type Kind = "param" | "binding" | "state" | "keep" | "let" | "builtin" | "rule-arg";

interface Env {
  kinds: Map<string, Kind>;
  /** A rule's parameters, replaced by the arguments of the call being expanded. */
  subst: Map<string, PlanExpr>;
  depth: number;
}

const LANGUAGE = new Set(["for", "where", "orderBy", "limit", "fallback", "key", "slot"]);
const AGGREGATES = new Set(["count", "exists", "sum", "min", "max"]);

export class ElementPlanner {
  constructor(private readonly checker: Checker) {}

  /** The plan of a view's element; `scope` holds its parameters and state. */
  element(el: Element, scope: { get(name: string): { kind: string } | undefined }, names: string[] = []): ElementPlan | null {
    const kinds = new Map<string, Kind>();
    for (const name of names) kinds.set(name, "binding");
    const env: Env = { kinds, subst: new Map(), depth: 0 };
    const lookup = (name: string): Kind | undefined => {
      const own = env.kinds.get(name);
      if (own) return own;
      const k = scope.get(name)?.kind;
      return k as Kind | undefined;
    };
    return this.plan(el, env, lookup)[0] ?? null;
  }

  private plan(el: Element, env: Env, lookup: (name: string) => Kind | undefined): ElementPlan[] {
    const get = (name: string) => el.attributes.find((a) => a.name === name)?.value;
    const result: ElementPlan = { type: el.type, at: `${el.span.line}:${el.span.column}` };
    const fallback = get("fallback");
    if (fallback?.kind === "expr" && fallback.expr.kind === "element") {
      const planned = this.plan(fallback.expr.element, env, lookup);
      if (planned.length) result.fallback = planned.length === 1 ? planned[0]! : { type: fallback.expr.element.type, at: "", children: planned };
    }
    const inner: Env = { ...env, kinds: new Map(env.kinds) };
    const introduced: string[] = [];
    const forValue = get("for");
    if (forValue?.kind === "for") {
      result.for = forValue.bindings.map((b) => {
        const source = this.expr(b.source, inner, lookup);
        inner.kinds.set(b.name, "binding");
        introduced.push(b.name);
        return { name: b.name, source };
      });
    }
    const innerLookup = (name: string) => inner.kinds.get(name) ?? lookup(name);
    const readsState = (e: Expr) => this.readsState(e, innerLookup, inner);
    const where = get("where");
    if (where?.kind === "where") {
      const host = where.conditions.filter((c) => !readsState(c));
      const client = where.conditions.filter(readsState);
      if (host.length) result.where = host.map((c) => this.expr(c, inner, innerLookup));
      if (client.length) result.clientWhere = client.map((c) => this.expr(c, inner, innerLookup));
    }
    const order = get("orderBy");
    if (order?.kind === "orderBy") {
      const host = order.terms.filter((t) => !readsState(t.value));
      const client = order.terms.filter((t) => readsState(t.value));
      if (host.length) result.orderBy = host.map((t) => ({ value: this.expr(t.value, inner, innerLookup), desc: t.desc }));
      if (client.length) result.clientOrderBy = client.map((t) => ({ value: this.expr(t.value, inner, innerLookup), desc: t.desc }));
    }
    const limit = get("limit");
    if (limit?.kind === "expr") result.limit = this.expr(limit.expr, inner, innerLookup);
    if (introduced.length) {
      const used = new Set<string>();
      const collect = (e: Expr) => this.names(e, used);
      for (const a of el.attributes) {
        if (LANGUAGE.has(a.name) && a.name !== "key") continue;
        if (a.value.kind === "expr") collect(a.value.expr);
        if (a.value.kind === "text") collect(a.value.text);
      }
      for (const child of el.children ?? []) this.childNames(child, used);
      const expandsBy = introduced.filter((n) => used.has(n));
      if (expandsBy.length) result.expandsBy = expandsBy;
    }
    const view = this.checker.views.get(el.type);
    const reads: PlanExpr[] = [];
    const seen = new Set<string>();
    const addRead = (p: PlanExpr) => {
      const key = JSON.stringify(p);
      if (!seen.has(key)) {
        seen.add(key);
        reads.push(p);
      }
    };
    if (view) {
      const args: Record<string, PlanExpr> = {};
      for (const a of el.attributes) {
        if (LANGUAGE.has(a.name)) continue;
        args[a.name] = a.value.kind === "expr" ? this.expr(a.value.expr, inner, innerLookup) : a.value.kind === "text" ? this.expr(a.value.text, inner, innerLookup) : { value: true };
      }
      result.draws = { view: el.type, from: view.from, args };
    } else {
      for (const a of el.attributes) {
        if (LANGUAGE.has(a.name) && a.name !== "key") continue;
        if (a.value.kind === "expr") this.reads(this.expr(a.value.expr, inner, innerLookup), addRead);
        if (a.value.kind === "text") this.reads(this.expr(a.value.text, inner, innerLookup), addRead);
      }
    }
    const children: ElementPlan[] = [];
    for (const child of el.children ?? []) {
      if (child.kind === "element") children.push(...this.plan(child.element, inner, innerLookup));
      else if (child.kind === "text") for (const p of child.parts) if (typeof p !== "string") this.reads(this.expr(p, inner, innerLookup), addRead);
    }
    if (reads.length) result.reads = reads;
    if (children.length) result.children = children;
    const meaningful = result.for || result.where || result.clientWhere || result.orderBy || result.clientOrderBy
      || result.limit || result.reads || result.draws || result.fallback;
    // An element that reads nothing itself is left out, and its children take its place.
    return meaningful ? [result] : children;
  }

  private childNames(child: NonNullable<Element["children"]>[number], used: Set<string>): void {
    if (child.kind === "text") for (const p of child.parts) if (typeof p !== "string") this.names(p, used);
    if (child.kind === "element") {
      for (const a of child.element.attributes) {
        const v = a.value;
        if (v.kind === "expr") this.names(v.expr, used);
        else if (v.kind === "text") this.names(v.text, used);
        else if (v.kind === "for") v.bindings.forEach((b) => this.names(b.source, used));
        else if (v.kind === "where") v.conditions.forEach((c) => this.names(c, used));
        else if (v.kind === "orderBy") v.terms.forEach((t) => this.names(t.value, used));
      }
      for (const c of child.element.children ?? []) this.childNames(c, used);
    }
  }

  private names(e: Expr, used: Set<string>): void {
    const visit = (x: Expr): void => {
      switch (x.kind) {
        case "name": used.add(x.name); break;
        case "template": x.parts.forEach((p) => typeof p !== "string" && visit(p)); break;
        case "list": x.items.forEach(visit); break;
        case "record": x.entries.forEach((y) => visit(y.value)); break;
        case "field": visit(x.object); break;
        case "call": x.args.forEach((a) => visit(a.value)); break;
        case "unary": visit(x.operand); break;
        case "binary": visit(x.left); visit(x.right); break;
        case "choice": visit(x.test); visit(x.then); visit(x.otherwise); break;
        case "comprehension": visit(x.binding.source); x.where.forEach(visit); break;
        case "element": for (const c of x.element.children ?? []) this.childNames(c, used); break;
        default: break;
      }
    };
    visit(e);
  }

  private readsState(e: Expr, lookup: (name: string) => Kind | undefined, env: Env): boolean {
    let found = false;
    const visit = (x: Expr): void => {
      if (found) return;
      switch (x.kind) {
        case "name": {
          const kind = lookup(x.name);
          if (kind === "state" || kind === "keep") found = true;
          break;
        }
        case "template": x.parts.forEach((p) => typeof p !== "string" && visit(p)); break;
        case "list": x.items.forEach(visit); break;
        case "record": x.entries.forEach((y) => visit(y.value)); break;
        case "field": visit(x.object); break;
        case "call": x.args.forEach((a) => visit(a.value)); break;
        case "unary": visit(x.operand); break;
        case "binary": visit(x.left); visit(x.right); break;
        case "choice": visit(x.test); visit(x.then); visit(x.otherwise); break;
        case "comprehension": visit(x.binding.source); x.where.forEach(visit); break;
        default: break;
      }
    };
    visit(e);
    void env;
    return found;
  }

  /** Adds the paths and aggregates in `p` to `add`. */
  private reads(p: PlanExpr, add: (p: PlanExpr) => void): void {
    if ("path" in p) return add(p);
    if ("call" in p && AGGREGATES.has(p.call)) return add(p);
    if ("text" in p) return p.text.forEach((x) => typeof x !== "string" && this.reads(x, add));
    if ("list" in p) return p.list.forEach((x) => this.reads(x, add));
    if ("record" in p) return Object.values(p.record).forEach((x) => this.reads(x, add));
    if ("op" in p) return p.args.forEach((x) => this.reads(x, add));
    if ("call" in p && "args" in p) return p.args.forEach((x) => this.reads(x, add));
    if ("action" in p) return Object.values(p.args).forEach((x) => this.reads(x, add));
    if ("set" in p) return this.reads(p.value, add);
  }

  expr(e: Expr, env: Env, lookup: (name: string) => Kind | undefined): PlanExpr {
    switch (e.kind) {
      case "literal": return { value: e.value };
      case "template": return { text: e.parts.map((p: TextPart) => (typeof p === "string" ? p : this.expr(p, env, lookup))) };
      case "list": return { list: e.items.map((x) => this.expr(x, env, lookup)) };
      case "record": return { record: Object.fromEntries(e.entries.map((x) => [x.name, this.expr(x.value, env, lookup)])) };
      case "element": return { element: e.element.type };
      case "name": {
        const sub = env.subst.get(e.name);
        if (sub) return sub;
        const kind = lookup(e.name);
        if (kind === "param") return { param: e.name };
        if (kind === "state" || kind === "keep") return { state: e.name };
        if (kind) return { name: e.name };
        if (["me", "community", "page", "now", "today"].includes(e.name)) return { builtin: e.name };
        if (this.checker.models.has(e.name)) return { model: e.name };
        if (this.checker.mutations.has(e.name)) return { action: e.name, args: {} };
        return { name: e.name };
      }
      case "field": {
        const object = this.expr(e.object, env, lookup);
        if ("path" in object) return { path: object.path, fields: [...object.fields, e.name] };
        return { path: object, fields: [e.name] };
      }
      case "unary": return { op: e.operator, args: [this.expr(e.operand, env, lookup)] };
      case "binary": return { op: e.operator, args: [this.expr(e.left, env, lookup), this.expr(e.right, env, lookup)] };
      case "choice": return { op: "?:", args: [this.expr(e.test, env, lookup), this.expr(e.then, env, lookup), this.expr(e.otherwise, env, lookup)] };
      case "comprehension": return { value: null };
      case "call": {
        const first = e.args[0]?.value;
        if (AGGREGATES.has(e.callee) && first?.kind === "comprehension") {
          const inner: Env = { ...env, kinds: new Map(env.kinds).set(first.binding.name, "binding") };
          const innerLookup = (name: string) => inner.kinds.get(name) ?? lookup(name);
          return {
            call: e.callee,
            over: { name: first.binding.name, source: this.expr(first.binding.source, env, lookup) },
            where: first.where.map((c) => this.expr(c, inner, innerLookup)),
          };
        }
        if (e.callee === "set") {
          const target = e.args[0]?.value;
          return { set: target?.kind === "name" ? target.name : "", value: e.args[1] ? this.expr(e.args[1].value, env, lookup) : { value: null } };
        }
        const rule = this.checker.rules.get(e.callee);
        if (rule && env.depth < 32) {
          const args = e.args.map((a) => this.expr(a.value, env, lookup));
          const alternatives = rule.decls.filter((d) => d.params.length === args.length).map((d) => {
            const subst = new Map(d.params.map((p, i) => [p.name, args[i]!]));
            return this.expr(d.body, { kinds: new Map(), subst, depth: env.depth + 1 }, () => undefined);
          });
          return alternatives.length === 1 ? alternatives[0]! : { op: "or", args: alternatives };
        }
        const mutation = this.checker.mutations.get(e.callee);
        if (mutation) {
          const args: Record<string, PlanExpr> = {};
          e.args.forEach((a, i) => {
            const name = a.name ?? mutation.decl.params[i]?.name ?? String(i);
            args[name] = this.expr(a.value, env, lookup);
          });
          return { action: e.callee, args };
        }
        return { call: e.callee, args: e.args.map((a) => this.expr(a.value, env, lookup)) };
      }
    }
  }
}
