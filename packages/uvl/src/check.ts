// The checker (spec 4.1): resolves every use, model, field and path against the bound USL
// schemas, types parameters, finds what each element expands by, and reports source spans.
// For each view it produces the plan (plan.ts) and for each mutation its write set.

import { compileUsl, IMPLICIT_FIELDS, VALUE_TYPES, type CheckResult as UslResult, type ResolvedModel } from "@ovst/usl";
import type {
  Arg, Attribute, Binding, Declaration, Diagnostic, Element, Expr, MutationDecl, Param, RuleDecl, Span,
  Statement, TextPart, TypeRef, ViewDecl, ViewFile,
} from "./ast.ts";
import { parseView } from "./parse.ts";
import { pageSource, type PageSource } from "./blocks.ts";
import { ElementPlanner, type ElementPlan, type PlanExpr } from "./plan.ts";

// ---------------------------------------------------------------- types

export type Ty =
  | { k: "any"; many?: boolean }
  | { k: "value"; t: string; many?: boolean }
  | { k: "enum"; name: string; many?: boolean }
  /** Rows of a model; `#page` is a page or child node, `#any` a row with no schema. */
  | { k: "row"; model: string; many?: boolean; optional?: boolean }
  | { k: "null" }
  | { k: "list"; of: Ty }
  | { k: "record" }
  | { k: "element" }
  | { k: "action" };

const ANY: Ty = { k: "any" };
const BOOL: Ty = { k: "value", t: "Bool" };
const TEXT: Ty = { k: "value", t: "Text" };
const INT: Ty = { k: "value", t: "Int" };
const NUMBER: Ty = { k: "value", t: "Number" };
const DATE: Ty = { k: "value", t: "Date" };

export function describe(t: Ty): string {
  const many = "many" in t && t.many ? " (many)" : "";
  switch (t.k) {
    case "any": return "a value";
    case "value": return `${t.t}${many}`;
    case "enum": return `${t.name}${many}`;
    case "row": return t.model === "#page" ? `a page${many}` : t.model === "#any" ? `a row${many}` : `${t.model}${many}`;
    case "null": return "null";
    case "list": return "a list";
    case "record": return "a record";
    case "element": return "an element";
    case "action": return "an action";
  }
}

// ---------------------------------------------------------------- models

export interface FieldInfo {
  name: string;
  type: string;
  arity: "one" | "optional" | "many";
  ordered: boolean;
  implicit: boolean;
}

export interface ModelInfo {
  name: string;
  kind: "data" | "enum" | "person";
  key: string[];
  fields: Map<string, FieldInfo>;
  /** A connection model's ends: the field each gives it, and the model it points at. */
  ends: { as: string; model: string }[];
  values: string[];
  schema: string;
}

function modelsOf(path: string, result: UslResult): ModelInfo[] {
  const models: ModelInfo[] = [];
  const person: ModelInfo = { name: "Person", kind: "person", key: ["id"], fields: new Map(), ends: [], values: [], schema: path };
  const implicit = (): Map<string, FieldInfo> =>
    new Map(IMPLICIT_FIELDS.map((name) => [name, { name, type: name === "id" ? "Text" : "Date", arity: "one", ordered: false, implicit: true }]));
  for (const m of result.models as ResolvedModel[]) {
    if (m.name === "Person") {
      for (const f of m.fields) person.fields.set(f.name, { name: f.name, type: f.type, arity: f.arity, ordered: f.ordered, implicit: false });
      continue;
    }
    const fields = m.rows === "fixed" ? new Map<string, FieldInfo>() : implicit();
    for (const f of m.fields) fields.set(f.name, { name: f.name, type: f.type, arity: f.arity, ordered: f.ordered, implicit: false });
    models.push({
      name: m.name,
      kind: m.rows === "fixed" ? "enum" : "data",
      key: m.key,
      fields,
      ends: m.ends.map((e) => ({ as: e.as, model: e.model })),
      values: m.rows === "fixed" ? m.schemaRows.map((r) => r.name) : [],
      schema: path,
    });
  }
  // Connections give Person fields even when the schema doesn't list Person as a model.
  for (const c of result.connections) {
    for (const [end, other] of [[c.a, c.b], [c.b, c.a]] as const) {
      if (end.model === "Person" && !person.fields.has(end.field)) {
        person.fields.set(end.field, { name: end.field, type: other.model, arity: end.arity, ordered: end.ordered, implicit: false });
      }
    }
  }
  return [...models, person];
}

// ---------------------------------------------------------------- results

export interface CheckedParam {
  name: string;
  type: string;
  arity: "one" | "optional" | "many";
}

export interface CheckedView {
  /** Empty for a `.view` file's unnamed view; `#n` for a page's n-th unnamed view. */
  name: string;
  params: CheckedParam[];
  state: { name: string; kind: "state" | "keep" }[];
  events: string[];
  plan: ElementPlan | null;
}

export interface Write {
  op: "insert" | "update" | "delete" | "upsert" | "append" | "remove" | "reorder";
  model: string;
  /** For append, remove and reorder: the relationship, as Model.field. */
  relationship?: string;
  fields?: string[];
}

export interface CheckedMutation {
  name: string;
  params: CheckedParam[];
  rowAction?: { model: string; op: string };
  /** Every row operation it can make, its `do` mutations' included, deduplicated. */
  writes: Write[];
  /** The models its guards, conditions and values read. */
  reads: string[];
}

export interface ViewCheck {
  diagnostics: Diagnostic[];
  views: CheckedView[];
  rules: { name: string; arity: number }[];
  mutations: CheckedMutation[];
  /** The sources and schemas this one uses, as logical paths, in use order. */
  uses: string[];
  /** The models it can read, by name, with the schema each comes from. */
  models: Record<string, string>;
}

export interface CheckOptions {
  /** The source's logical path in its tree, such as `/Profile.view` or `/Today.md`. */
  path: string;
  /** Reads another file of the tree by logical path; `undefined` when there is none. */
  read?: (path: string) => string | undefined;
  /** The UI language's element types. When given, any other type that isn't a view is an error. */
  uiTypes?: readonly string[];
}

export const BUILTIN_NAMES = ["me", "community", "page", "now", "today"] as const;
export const BUILTIN_FUNCTIONS = ["count", "exists", "sum", "min", "max", "lower", "upper", "trim", "length", "set"] as const;
const ROW_OPS = ["create", "edit", "delete", "move"];
const LANGUAGE_ATTRIBUTES = new Set(["for", "where", "orderBy", "limit", "fallback", "key", "slot"]);

// ---------------------------------------------------------------- paths

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function resolvePath(from: string, path: string): string {
  if (path.startsWith("overstory:")) return path;
  const parts = path.startsWith("/") ? [] : dirname(from).split("/").filter(Boolean);
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

/** The name a `.view` file's unnamed view takes when used: its node's name, if that is a name. */
function nodeName(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.view$/, "").replace(/\/_index$/, "");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(base) ? base : null;
}

// ---------------------------------------------------------------- sources

interface Declared {
  views: Map<string, { decl: ViewDecl; from: string }>;
  rules: Map<string, { decls: RuleDecl[]; from: string }>;
  mutations: Map<string, { decl: MutationDecl; from: string }>;
  unnamed: ViewDecl | null;
}

interface Loaded {
  path: string;
  file: ViewFile;
  diagnostics: Diagnostic[];
  /** For a page: which of its declarations each block holds. */
  blocks?: PageSource["blocks"];
}

function declaredIn(file: ViewFile, path: string): Declared {
  const declared: Declared = { views: new Map(), rules: new Map(), mutations: new Map(), unnamed: null };
  for (const { decl } of file.declarations) {
    if (decl.kind === "view") {
      if (decl.name === null) declared.unnamed ??= decl;
      else if (!declared.views.has(decl.name)) declared.views.set(decl.name, { decl, from: path });
    } else if (decl.kind === "rule") {
      const entry = declared.rules.get(decl.name) ?? { decls: [], from: path };
      entry.decls.push(decl);
      declared.rules.set(decl.name, entry);
    } else if (decl.kind === "mutation" && !declared.mutations.has(decl.name)) {
      declared.mutations.set(decl.name, { decl, from: path });
    }
  }
  return declared;
}

function load(path: string, text: string): Loaded {
  if (path.endsWith(".md")) {
    const page = pageSource(text);
    return { path, file: page.file, diagnostics: page.diagnostics, blocks: page.blocks };
  }
  const parsed = parseView(text);
  return { path, file: parsed.file, diagnostics: parsed.diagnostics };
}

// ---------------------------------------------------------------- the checker

interface Name {
  ty: Ty;
  kind: "param" | "binding" | "state" | "keep" | "let" | "builtin";
}

class Scope {
  private readonly names = new Map<string, Name>();
  constructor(readonly parent?: Scope) {}
  get(name: string): Name | undefined {
    return this.names.get(name) ?? this.parent?.get(name);
  }
  set(name: string, value: Name): void {
    this.names.set(name, value);
  }
  child(): Scope {
    return new Scope(this);
  }
}

interface Context {
  /** Inside a mutation: `now` and `today` are allowed. */
  mutation: boolean;
  /** An attribute or event value: mutation calls and `set` are allowed. */
  action: boolean;
  /** The models read, for a mutation's reads. */
  reads?: Set<string>;
}

export class Checker {
  readonly diagnostics: Diagnostic[] = [];
  readonly models = new Map<string, ModelInfo>();
  private readonly ambiguousModels = new Set<string>();
  readonly views = new Map<string, { decl: ViewDecl; from: string }>();
  readonly rules = new Map<string, { decls: RuleDecl[]; from: string }>();
  readonly mutations = new Map<string, { decl: MutationDecl; from: string }>();
  private readonly uses: string[] = [];
  private readonly writesMemo = new Map<string, Write[]>();
  readonly planner: ElementPlanner;

  constructor(readonly source: Loaded, readonly options: CheckOptions) {
    this.planner = new ElementPlanner(this);
  }

  error(code: string, message: string, span: Span | undefined, path?: string): void {
    const at = span ?? { line: 1, column: 1, endLine: 1, endColumn: 1 };
    this.diagnostics.push({ code, message, ...at, ...(path && path !== this.source.path ? { path } : {}) });
  }

  // ---------------------------------------------------------------- binding

  private bindSchema(path: string, span: Span | undefined): void {
    if (this.uses.includes(path)) return;
    const text = this.options.read?.(path);
    if (text === undefined) {
      this.error("use-not-found", `There is no schema at ${path}`, span);
      return;
    }
    this.uses.push(path);
    const result = compileUsl(text);
    if (result.diagnostics.length) {
      this.error("schema-invalid", `${path} doesn't check (${result.diagnostics[0]!.code}: ${result.diagnostics[0]!.message})`, span);
    }
    for (const model of modelsOf(path, result)) {
      const existing = this.models.get(model.name);
      if (existing && model.kind === "person" && existing.kind === "person") {
        for (const [name, field] of model.fields) if (!existing.fields.has(name)) existing.fields.set(name, field);
      } else if (existing) this.ambiguousModels.add(model.name);
      else this.models.set(model.name, model);
    }
  }

  /** The nearest ancestor collection schema, `schema.usl` in the source's folder or above. */
  private bindAncestorSchema(): void {
    let dir = dirname(this.source.path);
    for (;;) {
      const path = (dir === "/" ? "" : dir) + "/schema.usl";
      if (this.options.read?.(path) !== undefined) {
        this.bindSchema(path, undefined);
        return;
      }
      if (dir === "/") return;
      dir = dirname(dir);
    }
  }

  private bindUses(): void {
    const own = declaredIn(this.source.file, this.source.path);
    const offered = new Map<string, { kind: "view" | "rule" | "mutation"; from: string }>();
    const offer = (name: string, kind: "view" | "rule" | "mutation", from: string, span: Span) => {
      if (own.views.has(name) || own.rules.has(name) || own.mutations.has(name)) return; // shadowed
      const previous = offered.get(name);
      if (previous && previous.from !== from) {
        this.error("ambiguous-use", `${name} is available from both ${previous.from} and ${from}; leave one out or rename it with a pick list`, span);
        return;
      }
      offered.set(name, { kind, from });
    };
    for (const { decl } of this.source.file.declarations) {
      if (decl.kind !== "use") continue;
      const path = resolvePath(this.source.path, decl.path);
      if (path.endsWith(".usl")) {
        if (decl.picks) this.error("pick-from-schema", "A schema's models are all bound; a pick list is for views, rules and mutations", decl.span);
        this.bindSchema(path, decl.span);
        continue;
      }
      if (path === this.source.path) {
        this.error("use-cycle", "A source can't use itself", decl.span);
        continue;
      }
      if (!path.endsWith(".view") && !path.endsWith(".md")) {
        this.error("use-not-found", `${decl.path} is neither a .view file, a page nor a .usl schema`, decl.span);
        continue;
      }
      const text = this.options.read?.(path);
      if (text === undefined) {
        this.error("use-not-found", `There is no source at ${path}`, decl.span);
        continue;
      }
      if (this.usesTransitively(path, new Set([this.source.path]))) {
        this.error("use-cycle", `${path} uses this source, directly or through others`, decl.span);
        continue;
      }
      this.uses.push(path);
      const used = load(path, text);
      const declared = declaredIn(used.file, path);
      const unnamedName = path.endsWith(".view") ? nodeName(path) : null;
      const add = (name: string, as: string) => {
        if (name === "view") {
          if (!declared.unnamed || !path.endsWith(".view")) return false;
          offer(as, "view", path, decl.span);
          this.views.set(as, { decl: declared.unnamed, from: path });
          return true;
        }
        const view = declared.views.get(name);
        const rule = declared.rules.get(name);
        const mutation = declared.mutations.get(name);
        if (view) this.views.set(as, view);
        if (rule) this.rules.set(as, rule);
        if (mutation) this.mutations.set(as, mutation);
        if (view || rule || mutation) offer(as, view ? "view" : rule ? "rule" : "mutation", path, decl.span);
        return Boolean(view || rule || mutation);
      };
      if (decl.picks) {
        for (const pick of decl.picks) {
          if (!add(pick.name, pick.as ?? pick.name)) {
            this.error("unknown-pick", pick.name === "view" ? `${path} has no unnamed view` : `${path} declares no ${pick.name}`, pick.span);
          } else if (pick.name === "view" && !pick.as) {
            this.error("unknown-pick", "Name the unnamed view: (view as Name)", pick.span);
          }
        }
      } else {
        for (const name of declared.views.keys()) add(name, name);
        for (const name of declared.rules.keys()) add(name, name);
        for (const name of declared.mutations.keys()) add(name, name);
        if (declared.unnamed && unnamedName) add("view", unnamedName);
      }
      // A used source's own schemas bind its models here too.
      for (const { decl: inner } of used.file.declarations) {
        if (inner.kind === "use" && inner.path.endsWith(".usl")) this.bindSchema(resolvePath(path, inner.path), decl.span);
      }
    }
    for (const [name, entry] of own.views) this.views.set(name, entry);
    for (const [name, entry] of own.rules) this.rules.set(name, entry);
    for (const [name, entry] of own.mutations) this.mutations.set(name, entry);
  }

  private usesTransitively(path: string, seen: Set<string>): boolean {
    if (seen.has(path)) return true;
    const text = this.options.read?.(path);
    if (text === undefined) return false;
    const next = new Set(seen).add(path);
    for (const { decl } of load(path, text).file.declarations) {
      if (decl.kind !== "use" || decl.path.endsWith(".usl")) continue;
      const target = resolvePath(path, decl.path);
      if (target === this.source.path || (!seen.has(target) && this.usesTransitively(target, next))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- names and types

  model(name: string, span?: Span): ModelInfo | undefined {
    if (this.ambiguousModels.has(name)) {
      this.error("ambiguous-model", `${name} is declared by more than one bound schema`, span);
      return undefined;
    }
    return this.models.get(name);
  }

  private typeOfRef(ref: TypeRef | undefined): Ty {
    if (!ref) return TEXT;
    const many = ref.arity === "many";
    const optional = ref.arity === "optional";
    if ((VALUE_TYPES as readonly string[]).includes(ref.name)) return { k: "value", t: ref.name, many };
    const model = this.model(ref.name, ref.span);
    if (!model) {
      if (!this.ambiguousModels.has(ref.name)) this.error("unknown-type", `${ref.name} is neither a value type nor a model of a bound schema`, ref.span);
      return { k: "any", many };
    }
    if (model.kind === "enum") return { k: "enum", name: model.name, many };
    return { k: "row", model: model.name, many, optional };
  }

  private fieldType(field: FieldInfo, many: boolean): Ty {
    const fieldMany = many || field.arity === "many";
    if ((VALUE_TYPES as readonly string[]).includes(field.type)) return { k: "value", t: field.type, many: fieldMany };
    const model = this.models.get(field.type);
    if (field.type === "Person") return { k: "row", model: "Person", many: fieldMany, optional: field.arity === "optional" };
    if (model?.kind === "enum") return { k: "enum", name: model.name, many: fieldMany };
    return { k: "row", model: field.type, many: fieldMany, optional: field.arity === "optional" };
  }

  /** The field `name` of rows typed `t`, or undefined after reporting why there isn't one. */
  field(t: Ty, name: string, span: Span): Ty {
    const many = "many" in t && Boolean(t.many);
    if (t.k === "any") return { k: "any", many };
    if (t.k === "row") {
      if (t.model === "#page") return name === "children" ? { k: "row", model: "#page", many: true } : { k: "any", many };
      if (t.model === "#any") return { k: "any", many };
      const model = this.models.get(t.model);
      if (!model) return { k: "any", many };
      const field = model.fields.get(name);
      if (field) return this.fieldType(field, many);
      // A profile's own properties (name, handle, …) aren't in any schema.
      if (model.kind === "person") return { k: "value", t: "Text", many };
      this.error("unknown-field", `${model.name} has no field ${name}`, span);
      return { k: "any", many };
    }
    this.error("not-a-row", `${describe(t)} has no fields, so it has no ${name}`, span);
    return ANY;
  }

  lookup(name: string, scope: Scope): Name | undefined {
    return scope.get(name);
  }

  /** The type of `e`, reporting what doesn't resolve. */
  typeOf(e: Expr, scope: Scope, ctx: Context): Ty {
    switch (e.kind) {
      case "literal":
        if (e.value === null) return { k: "null" };
        if (typeof e.value === "string") return TEXT;
        if (typeof e.value === "boolean") return BOOL;
        return Number.isInteger(e.value) ? INT : NUMBER;
      case "template":
        for (const part of e.parts) if (typeof part !== "string") this.typeOf(part, scope, { ...ctx, action: false });
        return TEXT;
      case "list": {
        const items = e.items.map((item) => this.typeOf(item, scope, ctx));
        return { k: "list", of: items[0] ?? ANY };
      }
      case "record":
        for (const entry of e.entries) this.typeOf(entry.value, scope, ctx);
        return { k: "record" };
      case "element":
        this.checkElement(e.element, scope, ctx.mutation);
        return { k: "element" };
      case "comprehension":
        this.error("syntax", "`name in source where …` is an argument of count or exists", e.span);
        return ANY;
      case "name": return this.nameType(e, scope, ctx);
      case "field": {
        const object = this.typeOf(e.object, scope, ctx);
        if (object.k === "row" && ctx.reads && !object.model.startsWith("#")) ctx.reads.add(object.model);
        return this.field(object, e.name, e.nameSpan);
      }
      case "call": return this.callType(e, scope, ctx);
      case "unary": {
        const operand = this.typeOf(e.operand, scope, ctx);
        return e.operator === "not" ? BOOL : operand;
      }
      case "choice": {
        this.condition(e.test, scope, ctx);
        const then = this.typeOf(e.then, scope, ctx);
        this.typeOf(e.otherwise, scope, ctx);
        return then;
      }
      case "binary": return this.binaryType(e, scope, ctx);
    }
  }

  private nameType(e: Extract<Expr, { kind: "name" }>, scope: Scope, ctx: Context): Ty {
    const bound = scope.get(e.name);
    if (bound) return bound.ty;
    switch (e.name) {
      case "me": return { k: "row", model: "Person", optional: true };
      case "community": return { k: "row", model: "#any" };
      case "page": return { k: "row", model: "#page" };
      case "now":
      case "today":
        if (!ctx.mutation) this.error("no-clock", `${e.name} is known only to a mutation's runner; a view has no clock`, e.span);
        return DATE;
    }
    if (this.models.has(e.name) || this.ambiguousModels.has(e.name)) {
      const model = this.model(e.name, e.span);
      if (!model) return { k: "any", many: true };
      if (ctx.reads) ctx.reads.add(model.name);
      return model.kind === "enum" ? { k: "enum", name: model.name, many: true } : { k: "row", model: model.name, many: true };
    }
    if (this.mutations.has(e.name)) {
      if (!ctx.action) this.error("not-a-value", `${e.name} is a mutation; call it in an action`, e.span);
      return { k: "action" };
    }
    if (this.views.has(e.name)) {
      this.error("not-a-value", `${e.name} is a view; draw it as <${e.name} … /> or link to its address`, e.span);
      return ANY;
    }
    if (this.rules.has(e.name)) {
      this.error("not-a-value", `${e.name} is a rule; call it with its arguments`, e.span);
      return BOOL;
    }
    this.error("unknown-name", `Nothing named ${e.name} is in scope`, e.span);
    return ANY;
  }

  private collectionArgument(arg: Arg | undefined, scope: Scope, ctx: Context): { ty: Ty; scope: Scope } {
    if (!arg) return { ty: ANY, scope };
    if (arg.value.kind === "comprehension") {
      const inner = scope.child();
      const source = this.bindingType(arg.value.binding, scope, inner, ctx);
      inner.set(arg.value.binding.name, { ty: source, kind: "binding" });
      for (const condition of arg.value.where) this.condition(condition, inner, ctx);
      return { ty: { ...source, many: true } as Ty, scope: inner };
    }
    const ty = this.typeOf(arg.value, scope, ctx);
    return { ty, scope };
  }

  private callType(e: Extract<Expr, { kind: "call" }>, scope: Scope, ctx: Context): Ty {
    const plain = () => e.args.forEach((a) => a.value.kind !== "comprehension" && this.typeOf(a.value, scope, ctx));
    const arity = (n: number) => {
      if (e.args.length !== n) this.error("arguments", `${e.callee} takes ${n} argument${n === 1 ? "" : "s"}`, e.span);
    };
    switch (e.callee) {
      case "count":
      case "exists":
      case "sum":
      case "min":
      case "max": {
        arity(1);
        const { ty } = this.collectionArgument(e.args[0], scope, ctx);
        if (e.callee === "exists" && e.args[0]?.value.kind !== "comprehension") {
          this.error("arguments", "exists takes `name in source where …`", e.span);
        }
        if (ty.k !== "any" && !("many" in ty && ty.many) && ty.k !== "list") {
          this.error("not-a-collection", `${e.callee} needs rows or values, and ${describe(ty)} is one`, e.args[0]?.value.span);
        }
        if (e.callee === "count") return INT;
        if (e.callee === "exists") return BOOL;
        return e.callee === "sum" ? NUMBER : ty.k === "value" ? { k: "value", t: ty.t } : ANY;
      }
      case "lower":
      case "upper":
      case "trim":
        arity(1);
        plain();
        return TEXT;
      case "length":
        arity(1);
        plain();
        return INT;
      case "set": {
        if (!ctx.action) this.error("not-a-value", "set(…) is an action; it belongs in an action attribute", e.span);
        arity(2);
        const target = e.args[0]?.value;
        const bound = target?.kind === "name" ? scope.get(target.name) : undefined;
        if (!bound || (bound.kind !== "state" && bound.kind !== "keep")) {
          this.error("set-target", "set's first argument names a state or keep value of this view", target?.span ?? e.span);
        }
        if (e.args[1]) this.typeOf(e.args[1].value, scope, { ...ctx, action: false });
        return { k: "action" };
      }
    }
    const rule = this.rules.get(e.callee);
    if (rule) {
      if (!rule.decls.some((d) => d.params.length === e.args.length)) {
        this.error("arguments", `${e.callee} takes ${[...new Set(rule.decls.map((d) => d.params.length))].join(" or ")} arguments`, e.span);
      }
      for (const arg of e.args) {
        if (arg.name) this.error("arguments", "A rule's arguments are positional", arg.nameSpan);
        this.typeOf(arg.value, scope, { ...ctx, action: false });
      }
      return BOOL;
    }
    const mutation = this.mutations.get(e.callee);
    if (mutation) {
      if (!ctx.action) this.error("not-a-value", `${e.callee} is a mutation; call it in an action or with do`, e.calleeSpan);
      this.mutationArguments(e, mutation.decl, scope, ctx);
      return { k: "action" };
    }
    if (this.views.has(e.callee)) {
      this.error("not-a-value", `${e.callee} is a view; draw it as <${e.callee} … /> or link to its address`, e.calleeSpan);
      plain();
      return ANY;
    }
    this.error("unknown-function", `There is no rule, mutation or built-in function named ${e.callee}`, e.calleeSpan);
    plain();
    return ANY;
  }

  private mutationArguments(e: Extract<Expr, { kind: "call" }>, decl: MutationDecl, scope: Scope, ctx: Context): void {
    let position = 0;
    for (const arg of e.args) {
      const param = arg.name ? decl.params.find((p) => p.name === arg.name) : decl.params[position++];
      if (!param) {
        this.error("arguments", arg.name ? `${decl.name} has no parameter ${arg.name}` : `${decl.name} takes ${decl.params.length} arguments`, arg.nameSpan ?? arg.value.span);
      }
      const ty = this.typeOf(arg.value, scope, { ...ctx, action: false });
      if (param) this.compatible(this.typeOf2(param.type), ty, arg.value);
    }
  }

  /** A parameter's type, without reporting (it is reported where it is declared). */
  private typeOf2(ref: TypeRef | undefined): Ty {
    if (!ref) return TEXT;
    const many = ref.arity === "many";
    if ((VALUE_TYPES as readonly string[]).includes(ref.name)) return { k: "value", t: ref.name, many };
    const model = this.models.get(ref.name);
    if (!model) return ANY;
    if (model.kind === "enum") return { k: "enum", name: model.name, many };
    return { k: "row", model: model.name, many, optional: ref.arity === "optional" };
  }

  /** Reports a value that can't be what `expected` wants. A key (text) stands for a row. */
  compatible(expected: Ty, actual: Ty, at: Expr): void {
    if (expected.k === "any" || actual.k === "any" || actual.k === "null") return;
    if (expected.k === "row" && actual.k === "row" && !expected.model.startsWith("#") && !actual.model.startsWith("#")) {
      if (expected.model !== actual.model) this.error("type-mismatch", `Expected ${expected.model}, found ${describe(actual)}`, at.span);
      return;
    }
    if (expected.k === "enum") this.enumValue(expected.name, at);
  }

  private enumValue(name: string, at: Expr): void {
    if (at.kind !== "literal" || typeof at.value !== "string") return;
    const model = this.models.get(name);
    if (model && !model.values.includes(at.value)) {
      this.error("enum-value", `${JSON.stringify(at.value)} isn't a ${name}; it is one of ${model.values.join(", ")}`, at.span);
    }
  }

  private binaryType(e: Extract<Expr, { kind: "binary" }>, scope: Scope, ctx: Context): Ty {
    const left = this.typeOf(e.left, scope, ctx);
    const right = this.typeOf(e.right, scope, ctx);
    switch (e.operator) {
      case "and":
      case "or":
        return BOOL;
      case "==":
      case "!=":
      case "<":
      case "<=":
      case ">":
      case ">=":
        if (left.k === "enum") this.enumValue(left.name, e.right);
        if (right.k === "enum") this.enumValue(right.name, e.left);
        if (left.k === "row" && right.k === "row" && !left.model.startsWith("#") && !right.model.startsWith("#") && left.model !== right.model) {
          this.error("type-mismatch", `${describe(left)} and ${describe(right)} are never equal`, e.span);
        }
        return BOOL;
      case "in":
      case "not in": {
        if (right.k === "value" && !right.many && (right.t === "Text" || right.t === "Markdown")) return BOOL;
        if (right.k !== "any" && right.k !== "list" && !("many" in right && right.many)) {
          this.error("not-a-collection", `${describe(right)} holds one value; in needs rows, values or text`, e.right.span);
        } else if (left.k === "row" && right.k === "row" && !left.model.startsWith("#") && !right.model.startsWith("#") && left.model !== right.model) {
          this.error("type-mismatch", `${describe(right)} holds ${right.model} rows, never ${left.model}`, e.span);
        } else if (right.k === "enum") this.enumValue(right.name, e.left);
        return BOOL;
      }
      case "??":
        return left.k === "null" ? right : left;
      case "+":
        if ((left.k === "value" && left.t === "Text") || (right.k === "value" && right.t === "Text")) return TEXT;
        return left.k === "value" ? { k: "value", t: left.t } : ANY;
      default:
        return left.k === "value" && right.k === "value" && left.t === "Int" && right.t === "Int" && e.operator !== "/" ? INT : NUMBER;
    }
  }

  condition(e: Expr, scope: Scope, ctx: Context): void {
    const ty = this.typeOf(e, scope, { ...ctx, action: false });
    if (ty.k === "any" || (ty.k === "value" && ty.t === "Bool" && !ty.many)) return;
    this.error("not-a-condition", `A condition is true or false, and this is ${describe(ty)}`, e.span);
  }

  /** The type of one row of a binding's source. */
  bindingType(b: Binding, outer: Scope, inner: Scope, ctx: Context): Ty {
    if (inner.get(b.name) || outer.get(b.name)) this.error("duplicate-name", `${b.name} is already bound here`, b.nameSpan);
    if ((BUILTIN_NAMES as readonly string[]).includes(b.name)) this.error("builtin-name", `${b.name} is a built-in name`, b.nameSpan);
    const source = this.typeOf(b.source, inner, ctx);
    switch (source.k) {
      case "row": return { k: "row", model: source.model };
      case "value": return { k: "value", t: source.t };
      case "enum": return { k: "enum", name: source.name };
      case "list": return source.of;
      case "any": return ANY;
      default:
        this.error("not-a-source", `${describe(source)} has no rows to range over`, b.source.span);
        return ANY;
    }
  }

  // ---------------------------------------------------------------- elements

  checkElement(el: Element, scope: Scope, inMutation = false): void {
    const ctx: Context = { mutation: inMutation, action: false };
    const seen = new Set<string>();
    for (const a of el.attributes) {
      if (seen.has(a.name)) this.error("duplicate-attribute", `${a.name} is given twice`, a.nameSpan);
      seen.add(a.name);
    }
    const get = (name: string) => el.attributes.find((a) => a.name === name);
    const fallback = get("fallback");
    if (fallback) {
      if (fallback.value.kind !== "expr" || fallback.value.expr.kind !== "element") {
        this.error("fallback-element", "fallback takes an element: fallback={<Text>…</Text>}", fallback.span);
      } else this.checkElement(fallback.value.expr.element, scope, inMutation);
    }
    const inner = scope.child();
    const forAttribute = get("for");
    if (forAttribute?.value.kind === "for") {
      for (const b of forAttribute.value.bindings) inner.set(b.name, { ty: this.bindingType(b, scope, inner, ctx), kind: "binding" });
    }
    const where = get("where");
    if (where?.value.kind === "where") for (const c of where.value.conditions) this.condition(c, inner, ctx);
    const order = get("orderBy");
    if (order?.value.kind === "orderBy") for (const t of order.value.terms) this.typeOf(t.value, inner, ctx);
    const limit = get("limit");
    if (limit) {
      if (limit.value.kind !== "expr") this.error("limit", "limit takes a number: limit={12}", limit.span);
      else {
        const ty = this.typeOf(limit.value.expr, scope, ctx);
        if (ty.k !== "any" && !(ty.k === "value" && (ty.t === "Int" || ty.t === "Number") && !ty.many)) {
          this.error("limit", `limit takes a number, and this is ${describe(ty)}`, limit.value.expr.span);
        }
        const readsState = this.readsState(limit.value.expr, scope)
          || (where?.value.kind === "where" && where.value.conditions.some((c) => this.readsState(c, inner)))
          || (order?.value.kind === "orderBy" && order.value.terms.some((t) => this.readsState(t.value, inner)));
        if (readsState) {
          this.error("limit-reads-state", "The host can't cut what it can't see: a limit's element can't filter or order by state; take the value as a parameter instead", limit.span);
        }
      }
    }
    for (const name of ["key"]) {
      const a = get(name);
      if (a?.value.kind === "expr") this.typeOf(a.value.expr, inner, ctx);
    }
    const slot = get("slot");
    if (slot && slot.value.kind !== "text") this.error("slot", 'slot takes a name in quotes: slot="actions"', slot.span);
    for (const a of el.attributes) {
      if (["for", "where", "orderBy"].includes(a.name) && a.value.kind !== a.name) {
        this.error("syntax", `${a.name} takes {…}`, a.span);
      }
    }
    this.elementType(el, inner, ctx);
    for (const child of el.children ?? []) {
      if (child.kind === "element") this.checkElement(child.element, inner, inMutation);
      else if (child.kind === "text") this.textParts(child.parts, inner, ctx);
    }
  }

  private textParts(parts: TextPart[], scope: Scope, ctx: Context): void {
    for (const part of parts) {
      if (typeof part === "string") continue;
      const ty = this.typeOf(part, scope, ctx);
      if (ty.k === "action" || ty.k === "record") this.error("not-text", `${describe(ty)} can't be shown as text`, part.span);
    }
  }

  private attributeType(a: Attribute, scope: Scope, ctx: Context): Ty {
    switch (a.value.kind) {
      case "bare": return BOOL;
      case "text": return this.typeOf(a.value.text, scope, ctx);
      case "expr": return this.typeOf(a.value.expr, scope, { ...ctx, action: true });
      default:
        this.error("syntax", `${a.name} is only for the language's own attribute`, a.span);
        return ANY;
    }
  }

  private elementType(el: Element, scope: Scope, ctx: Context): void {
    const own = el.attributes.filter((a) => !LANGUAGE_ATTRIBUTES.has(a.name));
    const view = this.views.get(el.type);
    if (view) {
      const params = view.decl.params;
      for (const a of own) {
        const param = params.find((p) => p.name === a.name);
        const ty = this.attributeType(a, scope, ctx);
        if (!param) this.error("unknown-attribute", `${el.type} has no parameter ${a.name}`, a.nameSpan);
        else this.compatible(this.typeOf2(param.type), ty, a.value.kind === "expr" ? a.value.expr : a.value.kind === "text" ? a.value.text : { kind: "literal", value: true, span: a.span });
      }
      for (const p of params) {
        if (p.type?.arity === "optional" || p.type?.arity === "many") continue;
        if (!own.some((a) => a.name === p.name)) this.error("missing-attribute", `${el.type} needs ${p.name}`, el.typeSpan);
      }
      return;
    }
    if (!/^[A-Z]/.test(el.type) || (this.options.uiTypes && !this.options.uiTypes.includes(el.type))) {
      this.error("unknown-element", `${el.type} is neither a view in scope nor an element type of the UI language`, el.typeSpan);
    }
    for (const a of own) this.attributeType(a, scope, ctx);
  }

  /** True when `e` reads state: a `state` or `keep` name. */
  readsState(e: Expr, scope: Scope): boolean {
    let found = false;
    walk(e, (x) => {
      if (x.kind === "name") {
        const bound = scope.get(x.name);
        if (bound && (bound.kind === "state" || bound.kind === "keep")) found = true;
      }
    });
    return found;
  }

  // ---------------------------------------------------------------- declarations

  private paramsScope(params: Param[], scope: Scope): void {
    for (const p of params) {
      if (scope.get(p.name)) this.error("duplicate-name", `${p.name} is already a parameter`, p.span);
      if ((BUILTIN_NAMES as readonly string[]).includes(p.name)) this.error("builtin-name", `${p.name} is a built-in name`, p.span);
      scope.set(p.name, { ty: this.typeOfRef(p.type), kind: "param" });
    }
  }

  private checkView(decl: ViewDecl, name: string): CheckedView {
    const scope = new Scope();
    this.paramsScope(decl.params, scope);
    const state: CheckedView["state"] = [];
    const events: string[] = [];
    for (const line of decl.lines) {
      if (line.kind === "on" || line.kind === "every") {
        const ty = this.typeOf(line.action, scope, { mutation: false, action: true });
        if (ty.k !== "action" && ty.k !== "any") this.error("not-an-action", "An event runs an action: a mutation call or set(…)", line.action.span);
        events.push(line.kind === "on" ? `on ${line.event}${line.detail !== undefined ? " " + JSON.stringify(line.detail) : ""}` : `every ${line.text}`);
        continue;
      }
      if (scope.get(line.name)) this.error("duplicate-name", `${line.name} is already declared in this view`, line.nameSpan);
      const ty = this.typeOf(line.value, scope, { mutation: false, action: false });
      scope.set(line.name, { ty: { ...ty, many: false } as Ty, kind: line.kind });
      state.push({ name: line.name, kind: line.kind });
    }
    if (decl.body) this.checkElement(decl.body, scope);
    return {
      name,
      params: decl.params.map((p) => this.param(p)),
      state,
      events,
      plan: decl.body ? this.planner.element(decl.body, scope) : null,
    };
  }

  private param(p: Param): CheckedParam {
    return { name: p.name, type: p.type?.name ?? "Text", arity: p.type?.arity ?? "one" };
  }

  private checkRule(decl: RuleDecl): void {
    const scope = new Scope();
    for (const p of decl.params) {
      if (scope.get(p.name)) this.error("duplicate-name", `${p.name} is already a parameter`, p.span);
      scope.set(p.name, { ty: p.type ? this.typeOfRef(p.type) : ANY, kind: "param" });
    }
    this.condition(decl.body, scope, { mutation: false, action: false });
  }

  private ruleCycles(): void {
    const calls = (decls: RuleDecl[]) => {
      const names = new Set<string>();
      for (const d of decls) walk(d.body, (x) => x.kind === "call" && this.rules.has(x.callee) && names.add(x.callee));
      return names;
    };
    const reported = new Set<string>();
    const visit = (name: string, stack: string[]) => {
      if (stack.includes(name)) {
        if (!reported.has(name)) {
          reported.add(name);
          const decl = this.rules.get(name)!.decls[0]!;
          if (this.rules.get(name)!.from === this.source.path) {
            this.error("rule-recursion", `${name} refers to itself (${[...stack.slice(stack.indexOf(name)), name].join(" → ")})`, decl.nameSpan);
          }
        }
        return;
      }
      for (const next of calls(this.rules.get(name)!.decls)) visit(next, [...stack, name]);
    };
    for (const name of this.rules.keys()) visit(name, []);
  }

  private checkMutation(decl: MutationDecl): CheckedMutation {
    const scope = new Scope();
    this.paramsScope(decl.params, scope);
    const reads = new Set<string>();
    const ctx: Context = { mutation: true, action: false, reads };
    for (const p of decl.params) if (p.type && this.models.has(p.type.name) && this.models.get(p.type.name)!.kind !== "enum") reads.add(p.type.name);
    // Every statement reads the state from before the mutation, so a let name is usable anywhere in it.
    const lets = (list: Statement[]) => {
      for (const s of list) {
        if (s.kind === "insert" && s.name) {
          if (scope.get(s.name)) this.error("duplicate-name", `${s.name} is already declared in this mutation`, s.nameSpan);
          const model = this.models.get(s.model);
          scope.set(s.name, { ty: model ? { k: "row", model: model.name } : ANY, kind: "let" });
        }
        if (s.kind === "when") lets(s.body);
      }
    };
    lets(decl.body);
    if (decl.rowAction) {
      const { model, op, span } = decl.rowAction;
      if (!this.models.get(model) || this.models.get(model)!.kind !== "data") this.error("unknown-model", `${model} is not a model of a bound schema`, span);
      if (!ROW_OPS.includes(op)) this.error("row-action", `A row action is one of ${ROW_OPS.join(", ")}`, span);
      else if (op !== "create" && decl.params[0]?.type?.name !== model) {
        this.error("row-action", `A ${op} action's first parameter is the row: (row: ${model})`, span);
      }
    }
    const returns: Statement[] = [];
    const statements = (list: Statement[], scope: Scope) => {
      const written = new Map<string, Span>();
      for (const s of list) {
        if (s.kind === "comment") continue;
        if (s.kind === "return") returns.push(s);
        const inner = scope.child();
        if (s.for) for (const b of s.for) inner.set(b.name, { ty: this.bindingType(b, scope, inner, ctx), kind: "binding" });
        if (s.where) for (const c of s.where) this.condition(c, inner, ctx);
        if (s.orderBy) for (const t of s.orderBy) this.typeOf(t.value, inner, ctx);
        this.statement(s, inner, ctx, decl);
        if (s.kind === "when") statements(s.body, inner);
        // Two unconditional updates of the same row's field disagree.
        if (s.kind === "update" && !s.where && !s.for && s.target.kind === "name") {
          for (const entry of s.fields.entries) {
            const key = `${s.target.name}.${entry.name}`;
            if (written.has(key)) this.error("conflicting-writes", `${key} is written twice; a mutation's statements all apply together`, entry.nameSpan);
            written.set(key, entry.nameSpan);
          }
        }
      }
    };
    statements(decl.body, scope);
    if (returns.length > 1) this.error("return-twice", "A mutation has one result", returns[1]!.span);
    return {
      name: decl.name,
      params: decl.params.map((p) => this.param(p)),
      ...(decl.rowAction ? { rowAction: { model: decl.rowAction.model, op: decl.rowAction.op } } : {}),
      writes: this.writesOf(decl.name, []),
      reads: [...reads].sort(),
    };
  }

  private rowModel(target: Expr, scope: Scope, ctx: Context, what: string): ModelInfo | undefined {
    const ty = this.typeOf(target, scope, ctx);
    if (ty.k === "any") return undefined;
    if (ty.k !== "row" || ty.many || ty.model.startsWith("#") || this.models.get(ty.model)?.kind !== "data") {
      this.error("not-a-row", `${what} takes one row of a model, and this is ${describe(ty)}`, target.span);
      return undefined;
    }
    return this.models.get(ty.model);
  }

  private recordFields(model: ModelInfo, record: Extract<Expr, { kind: "record" }>, scope: Scope, ctx: Context): void {
    const seen = new Set<string>();
    for (const entry of record.entries) {
      if (seen.has(entry.name)) this.error("duplicate-field", `${entry.name} is given twice`, entry.nameSpan);
      seen.add(entry.name);
      const field = model.fields.get(entry.name);
      const ty = this.typeOf(entry.value, scope, ctx);
      if (!field) {
        this.error("unknown-field", `${model.name} has no field ${entry.name}`, entry.nameSpan);
        continue;
      }
      if (field.implicit) {
        this.error("implicit-field", entry.name === "id" ? "A new row's id comes from the mutation's identity" : `${entry.name} is set by accepted changes, not by mutations`, entry.nameSpan);
        continue;
      }
      const expected = this.fieldType(field, false);
      if (field.arity === "many") {
        if (ty.k === "list") this.compatible(expected, ty.of, entry.value);
      } else this.compatible(expected, ty, entry.value);
    }
  }

  private required(model: ModelInfo, given: Set<string>, span: Span): void {
    for (const field of model.fields.values()) {
      if (field.implicit || field.arity !== "one" || given.has(field.name)) continue;
      this.error("missing-field", `A new ${model.name} needs ${field.name}`, span);
    }
  }

  /** The to-many relationship a path ends in: the model holding the field, and the field. */
  private relationship(path: Expr, scope: Scope, ctx: Context): { owner: string; field: FieldInfo } | undefined {
    if (path.kind !== "field") {
      this.error("not-a-relationship", "Expected a relationship of one row, such as l.items", path.span);
      return undefined;
    }
    const object = this.typeOf(path.object, scope, ctx);
    if (object.k === "any") return undefined;
    if (object.k !== "row" || object.many || object.model.startsWith("#")) {
      this.error("not-a-relationship", `Expected a relationship of one row, and ${describe(object)} is not one row`, path.object.span);
      return undefined;
    }
    const field = this.models.get(object.model)?.fields.get(path.name);
    if (!field) {
      this.field(object, path.name, path.nameSpan);
      return undefined;
    }
    if (field.arity !== "many" || (VALUE_TYPES as readonly string[]).includes(field.type)) {
      this.error("not-a-relationship", `${object.model}.${path.name} isn't a to-many relationship`, path.nameSpan);
      return undefined;
    }
    return { owner: object.model, field };
  }

  /** The row types a relationship's members can be given as: its model, or a connection model's far end. */
  private memberModels(owner: string, field: FieldInfo): string[] {
    const target = this.models.get(field.type);
    if (target && target.ends.length === 2) {
      const far = target.ends.find((e) => e.model !== owner) ?? target.ends[1]!;
      return [field.type, far.model];
    }
    return [field.type];
  }

  private statement(s: Statement, scope: Scope, ctx: Context, decl: MutationDecl): void {
    switch (s.kind) {
      case "require":
        this.condition(s.condition, scope, ctx);
        return;
      case "insert": {
        const model = this.models.get(s.model);
        if (!model || model.kind !== "data") {
          this.error(model ? "not-insertable" : "unknown-model", model ? `${s.model} has no rows to insert` : `${s.model} is not a model of a bound schema`, s.modelSpan);
          for (const e of s.fields.entries) this.typeOf(e.value, scope, ctx);
          return;
        }
        this.recordFields(model, s.fields, scope, ctx);
        this.required(model, new Set(s.fields.entries.map((e) => e.name)), s.modelSpan);
        return;
      }
      case "update": {
        const model = this.rowModel(s.target, scope, ctx, "update");
        if (model) this.recordFields(model, s.fields, scope, ctx);
        else for (const e of s.fields.entries) this.typeOf(e.value, scope, ctx);
        return;
      }
      case "delete":
        this.rowModel(s.target, scope, ctx, "delete");
        return;
      case "upsert": {
        const model = this.models.get(s.model);
        if (!model || model.kind !== "data") {
          this.error("unknown-model", `${s.model} is not a model of a bound schema`, s.modelSpan);
          return;
        }
        const keys = s.key.entries.map((e) => e.name);
        if (keys.length !== model.key.length || !model.key.every((k) => keys.includes(k))) {
          this.error("upsert-key", `An upsert finds its row by ${model.name}'s key: ${model.key.join(", ")}`, s.key.span);
        }
        for (const record of [s.key, s.create, s.update]) this.recordFields(model, record, scope, ctx);
        this.required(model, new Set([...keys, ...s.create.entries.map((e) => e.name)]), s.modelSpan);
        return;
      }
      case "append":
      case "remove": {
        const item = this.typeOf(s.item, scope, ctx);
        const rel = this.relationship(s.path, scope, ctx);
        if (rel && item.k === "row" && !item.model.startsWith("#")) {
          const allowed = this.memberModels(rel.owner, rel.field);
          if (!allowed.includes(item.model)) {
            this.error("type-mismatch", `${rel.owner}.${rel.field.name} holds ${allowed.join(" or ")}, not ${item.model}`, s.item.span);
          }
        }
        return;
      }
      case "reorder": {
        const rel = this.relationship(s.path, scope, ctx);
        if (rel && !rel.field.ordered) this.error("not-ordered", `${rel.owner}.${rel.field.name} isn't ordered`, s.path.span);
        const to = this.typeOf(s.to, scope, ctx);
        if (to.k !== "any" && to.k !== "list" && !("many" in to && to.many)) this.error("not-a-collection", `reorder takes a list, and this is ${describe(to)}`, s.to.span);
        return;
      }
      case "when":
        this.condition(s.condition, scope, ctx);
        return;
      case "do":
        for (const call of s.calls) {
          const mutation = this.mutations.get(call.callee);
          if (!mutation) {
            this.error("unknown-mutation", `There is no mutation named ${call.callee}`, call.calleeSpan);
            continue;
          }
          if (mutation.decl === decl) this.error("do-cycle", "A mutation can't include itself", call.calleeSpan);
          this.mutationArguments(call, mutation.decl, scope, { ...ctx, action: true });
        }
        return;
      case "return":
        for (const e of s.value.entries) this.typeOf(e.value, scope, ctx);
        return;
      case "comment":
        return;
    }
  }

  /** A mutation's writes, its `do` mutations' included. */
  private writesOf(name: string, stack: string[]): Write[] {
    const memo = this.writesMemo.get(name);
    if (memo) return memo;
    const entry = this.mutations.get(name);
    if (!entry || stack.includes(name)) return [];
    const writes: Write[] = [];
    const typeOfRow = (target: Expr, bindings: Map<string, string>): string | undefined => {
      if (target.kind === "name") {
        if (bindings.has(target.name)) return bindings.get(target.name);
        const param = entry.decl.params.find((p) => p.name === target.name);
        if (param?.type) return param.type.name;
      }
      return undefined;
    };
    const lets = new Map<string, string>();
    const collectLets = (list: Statement[]) => list.forEach((s) => {
      if (s.kind === "insert" && s.name) lets.set(s.name, s.model);
      if (s.kind === "when") collectLets(s.body);
    });
    collectLets(entry.decl.body);
    const sourceModel = (source: Expr, bindings: Map<string, string>): string | undefined => {
      if (source.kind === "name" && this.models.has(source.name)) return source.name;
      if (source.kind === "field") {
        const owner = typeOfRow(source.object, bindings) ?? (source.object.kind === "field" ? sourceModel(source.object, bindings) : undefined);
        const field = owner ? this.models.get(owner)?.fields.get(source.name) : undefined;
        return field?.type;
      }
      return typeOfRow(source, bindings);
    };
    const visit = (list: Statement[]) => {
      for (const s of list) {
        const bindings = new Map(lets);
        for (const b of s.for ?? []) {
          const model = sourceModel(b.source, bindings);
          if (model) bindings.set(b.name, model);
        }
        switch (s.kind) {
          case "insert":
            writes.push({ op: "insert", model: s.model, fields: s.fields.entries.map((e) => e.name) });
            break;
          case "update": {
            const model = typeOfRow(s.target, bindings);
            if (model) writes.push({ op: "update", model, fields: s.fields.entries.map((e) => e.name) });
            break;
          }
          case "delete": {
            const model = typeOfRow(s.target, bindings);
            if (model) writes.push({ op: "delete", model });
            break;
          }
          case "upsert":
            writes.push({ op: "upsert", model: s.model, fields: [...new Set([...s.key.entries, ...s.create.entries, ...s.update.entries].map((e) => e.name))] });
            break;
          case "append":
          case "remove":
          case "reorder":
            if (s.path.kind === "field") {
              const owner = typeOfRow(s.path.object, bindings);
              const field = owner ? this.models.get(owner)?.fields.get(s.path.name) : undefined;
              if (owner && field) writes.push({ op: s.kind, model: field.type, relationship: `${owner}.${field.name}` });
            }
            break;
          case "when":
            visit(s.body);
            break;
          case "do":
            for (const call of s.calls) writes.push(...this.writesOf(call.callee, [...stack, name]));
            break;
        }
      }
    };
    visit(entry.decl.body);
    const merged = new Map<string, Write>();
    for (const w of writes) {
      const key = `${w.op} ${w.model} ${w.relationship ?? ""}`;
      const existing = merged.get(key);
      if (existing && w.fields) existing.fields = [...new Set([...(existing.fields ?? []), ...w.fields])].sort();
      else if (!existing) merged.set(key, { ...w, ...(w.fields ? { fields: [...w.fields].sort() } : {}) });
    }
    const result = [...merged.values()].sort((a, b) => `${a.model} ${a.op}`.localeCompare(`${b.model} ${b.op}`));
    this.writesMemo.set(name, result);
    return result;
  }

  // ---------------------------------------------------------------- the source

  run(): ViewCheck {
    this.diagnostics.push(...this.source.diagnostics);
    const file = this.source.file;
    const isPage = this.source.path.endsWith(".md");
    this.bindAncestorSchema();
    this.bindUses();
    const builtins = new Set<string>([...BUILTIN_NAMES, ...BUILTIN_FUNCTIONS]);
    const names = new Map<string, string>();
    const declare = (name: string, kind: string, span: Span) => {
      if (builtins.has(name)) this.error("builtin-name", `${name} is a built-in name`, span);
      const previous = names.get(name);
      if (previous && !(previous === "rule" && kind === "rule")) this.error("duplicate-name", `${name} is already declared as a ${previous}`, span);
      names.set(name, kind);
    };
    let unnamed = 0;
    const views: CheckedView[] = [];
    const mutations: CheckedMutation[] = [];
    const rules: { name: string; arity: number }[] = [];
    for (const { decl } of file.declarations) {
      if (decl.kind === "view" && decl.name !== null) declare(decl.name, "view", decl.nameSpan);
      else if (decl.kind === "rule") {
        declare(decl.name, "rule", decl.nameSpan);
        const decls = this.rules.get(decl.name)?.decls ?? [];
        if (decls.filter((d) => d.params.length === decl.params.length).length > 1 && decls.find((d) => d.params.length === decl.params.length) !== decl) {
          // An alternative of an earlier rule: fine.
        }
      } else if (decl.kind === "mutation") declare(decl.name, "mutation", decl.nameSpan);
    }
    this.ruleCycles();
    for (const { decl } of file.declarations as { decl: Declaration }[]) {
      switch (decl.kind) {
        case "view": {
          let name = decl.name ?? "";
          if (decl.name === null) {
            unnamed += 1;
            if (isPage) name = `#${unnamed}`;
            else if (unnamed > 1) this.error("two-unnamed-views", "A .view file has at most one unnamed view", decl.nameSpan);
          }
          views.push(this.checkView(decl, name));
          break;
        }
        case "element": {
          if (!isPage) {
            this.error("bare-element", "In a .view file an element belongs to a view: view(): <…>", decl.element.typeSpan);
            break;
          }
          unnamed += 1;
          views.push(this.checkView({ kind: "view", name: null, nameSpan: decl.span, params: [], lines: [], body: decl.element, span: decl.span }, `#${unnamed}`));
          break;
        }
        case "rule":
          this.checkRule(decl);
          if (!rules.some((r) => r.name === decl.name && r.arity === decl.params.length)) rules.push({ name: decl.name, arity: decl.params.length });
          break;
        case "mutation":
          mutations.push(this.checkMutation(decl));
          break;
      }
    }
    if (this.source.blocks) {
      for (const block of this.source.blocks) {
        if (block.elements > 1) this.error("two-elements", "A view block holds at most one element on its own", block.span);
      }
    }
    const models: Record<string, string> = {};
    for (const [name, model] of [...this.models].sort(([a], [b]) => a.localeCompare(b))) if (model.kind !== "person") models[name] = model.schema;
    this.diagnostics.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.line - b.line || a.column - b.column);
    return { diagnostics: this.diagnostics, views, rules, mutations, uses: this.uses, models };
  }
}

/** Visits `e` and every expression inside it, elements' attributes and text included. */
export function walk(e: Expr, visit: (e: Expr) => unknown): void {
  visit(e);
  switch (e.kind) {
    case "template": for (const p of e.parts) if (typeof p !== "string") walk(p, visit); break;
    case "list": e.items.forEach((x) => walk(x, visit)); break;
    case "record": e.entries.forEach((x) => walk(x.value, visit)); break;
    case "field": walk(e.object, visit); break;
    case "call": e.args.forEach((a) => walk(a.value, visit)); break;
    case "unary": walk(e.operand, visit); break;
    case "binary": walk(e.left, visit); walk(e.right, visit); break;
    case "choice": walk(e.test, visit); walk(e.then, visit); walk(e.otherwise, visit); break;
    case "comprehension": walk(e.binding.source, visit); e.where.forEach((x) => walk(x, visit)); break;
    case "element": walkElement(e.element, visit); break;
    default: break;
  }
}

export function walkElement(el: Element, visit: (e: Expr) => unknown): void {
  for (const a of el.attributes) {
    const v = a.value;
    if (v.kind === "expr") walk(v.expr, visit);
    else if (v.kind === "text") walk(v.text, visit);
    else if (v.kind === "for") v.bindings.forEach((b) => walk(b.source, visit));
    else if (v.kind === "where") v.conditions.forEach((c) => walk(c, visit));
    else if (v.kind === "orderBy") v.terms.forEach((t) => walk(t.value, visit));
  }
  for (const child of el.children ?? []) {
    if (child.kind === "element") walkElement(child.element, visit);
    else if (child.kind === "text") for (const p of child.parts) if (typeof p !== "string") walk(p, visit);
  }
}

/** Checks a `.view` file's or a page's source. */
export function checkView(text: string, options: CheckOptions): ViewCheck {
  return new Checker(load(options.path, text), options).run();
}

export type { PlanExpr, ElementPlan };
