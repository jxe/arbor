// The checker (spec 1.5): resolves every use, table, field and path against the bound
// schemas and state tables, types parameters, finds what each element expands by, and
// reports source spans. For each view it produces the plan (plan.ts), and for each
// mutation the rows it can write.

import { checkUsl, IMPLICIT_FIELDS, VALUE_TYPES, type CheckResult as UslResult, type ResolvedModel } from "@ovst/usl";
import type {
  Arg, Attribute, Binding, DataRecord, Declaration, Diagnostic, Element, ErrorCode, Expr, Line, MutationDecl, Param,
  RuleDecl, Span, TextPart, TypeRef, ViewDecl, ViewFile,
} from "./ast.ts";
import { parseView } from "./parse.ts";
import { pageSource, type PageSource } from "./blocks.ts";
import { ElementPlanner, type DataPlan, type ElementPlan, type PlanExpr } from "./plan.ts";
import { uslFileOf } from "./schema.ts";

// ---------------------------------------------------------------- types

export type Ty =
  | { k: "any"; many?: boolean }
  | { k: "value"; t: string; many?: boolean }
  /** An enum's values; `#value` is a value name more than one enum has. */
  | { k: "enum"; name: string; many?: boolean }
  /** Rows of a table; `#page` is a page or child node, `#any` a row with no schema. */
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
const DURATION: Ty = { k: "value", t: "Duration" };

const isMany = (t: Ty): boolean => "many" in t && Boolean(t.many);

export function describe(t: Ty): string {
  const many = isMany(t) ? " (many)" : "";
  switch (t.k) {
    case "any": return "a value";
    case "value": return `${t.t}${many}`;
    case "enum": return t.name === "#value" ? "an enum value" : `${t.name}${many}`;
    case "row": return t.model === "#page" ? `a page${many}` : t.model === "#any" ? `a row${many}` : `${t.model}${many}`;
    case "null": return "null";
    case "list": return "a list";
    case "record": return "a record";
    case "element": return "an element";
    case "action": return "an action";
  }
}

// ---------------------------------------------------------------- tables

export interface FieldInfo {
  name: string;
  type: string;
  arity: "one" | "optional" | "many";
  ordered: boolean;
  implicit: boolean;
}

export interface ModelInfo {
  name: string;
  /** `state` is a `my` or `session` table. */
  kind: "data" | "enum" | "person" | "state";
  state?: "my" | "session";
  key: string[];
  fields: Map<string, FieldInfo>;
  /** Fields with a default, which a new row may leave out. */
  defaults: Set<string>;
  /** A connection table's ends: the field each gives it, and the table it points at. */
  ends: { as: string; model: string }[];
  values: string[];
  /** The file that declares it. */
  schema: string;
  span?: Span;
}

const implicitFields = (): Map<string, FieldInfo> =>
  new Map(IMPLICIT_FIELDS.map((name) => [name, { name, type: name === "id" ? "Text" : "Date", arity: "one", ordered: false, implicit: true }]));

function modelsOf(path: string, result: UslResult, defaults: Record<string, Record<string, Expr>>): ModelInfo[] {
  const models: ModelInfo[] = [];
  const person: ModelInfo = { name: "Person", kind: "person", key: ["id"], fields: new Map(), defaults: new Set(), ends: [], values: [], schema: path };
  for (const m of result.models as ResolvedModel[]) {
    if (m.name === "Person") {
      for (const f of m.fields) person.fields.set(f.name, { name: f.name, type: f.type, arity: f.arity, ordered: f.ordered, implicit: false });
      continue;
    }
    const fields = m.rows === "fixed" ? new Map<string, FieldInfo>() : implicitFields();
    for (const f of m.fields) fields.set(f.name, { name: f.name, type: f.type, arity: f.arity, ordered: f.ordered, implicit: false });
    models.push({
      name: m.name,
      kind: m.rows === "fixed" ? "enum" : "data",
      key: m.key,
      fields,
      defaults: new Set(Object.keys(defaults[m.name] ?? {})),
      ends: m.ends.map((e) => ({ as: e.as, model: e.model })),
      values: m.rows === "fixed" ? m.schemaRows.map((r) => r.name) : [],
      schema: path,
    });
  }
  // Connections give Person fields even when the schema doesn't list Person as a table.
  for (const c of result.connections) {
    for (const [end, other] of [[c.a, c.b], [c.b, c.a]] as const) {
      if (end.model === "Person" && !person.fields.has(end.field)) {
        person.fields.set(end.field, { name: end.field, type: other.model, arity: end.arity, ordered: end.ordered, implicit: false });
      }
    }
  }
  return [...models, person];
}

/** The state tables and enums a file that isn't a schema declares. */
function localModels(file: ViewFile, path: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const { decl } of file.declarations) {
    if (decl.kind === "table" && (decl.tableKind === "my" || decl.tableKind === "session")) {
      const fields = implicitFields();
      const defaults = new Set<string>();
      for (const m of decl.members) {
        if (m.kind !== "field") continue;
        fields.set(m.name, { name: m.name, type: m.type, arity: m.arity, ordered: m.modifiers.includes("ordered"), implicit: false });
        if (m.default) defaults.add(m.name);
      }
      models.push({
        name: decl.name, kind: "state", state: decl.tableKind, key: decl.key?.map((k) => k.name) ?? ["id"], fields, defaults,
        ends: [], values: [], schema: path, span: decl.nameSpan,
      });
    } else if (decl.kind === "enum") {
      const fields = new Map<string, FieldInfo>();
      for (const m of decl.members) {
        if (m.kind === "field") fields.set(m.name, { name: m.name, type: m.type, arity: m.arity, ordered: false, implicit: false });
      }
      models.push({
        name: decl.name, kind: "enum", key: ["name"], fields, defaults: new Set(), ends: [],
        values: decl.members.flatMap((m) => (m.kind === "value" ? [m.name] : [])), schema: path, span: decl.nameSpan,
      });
    }
  }
  return models;
}

// ---------------------------------------------------------------- results

export interface CheckedParam {
  name: string;
  type: string;
  arity: "one" | "optional" | "many";
}

export interface CheckedView {
  /** Empty for a `.vad` file's unnamed view; `#n` for a page's n-th unnamed view. */
  name: string;
  params: CheckedParam[];
  state: { name: string; kind: "state" | "keep" }[];
  events: string[];
  plan: ElementPlan | null;
  /** A data view's plan, in place of `plan`. */
  data?: DataPlan;
}

/**
 * A row operation a mutation can make. `upsert` is a fact that gives its table's whole key;
 * `insert` one that leaves the key to the mutation's identity; `update` a field line.
 */
export interface Write {
  op: "insert" | "upsert" | "update" | "delete";
  table: string;
  fields?: string[];
}

export interface CheckedMutation {
  name: string;
  params: CheckedParam[];
  rowAction?: { model: string; op: string };
  /** Every row operation it can make, its called mutations' included, deduplicated. */
  writes: Write[];
  /** The names its `let` lines give rows, local to the mutation. */
  lets: { name: string; table: string }[];
  /** The public errors it can fail with, its called mutations' included, in order. */
  errors: ErrorCode[];
  /** The tables its conditions and values read. */
  reads: string[];
}

export interface ViewCheck {
  diagnostics: Diagnostic[];
  views: CheckedView[];
  rules: { name: string; arity: number }[];
  mutations: CheckedMutation[];
  /** The files this one uses, as logical paths, in use order, its bound schema included. */
  uses: string[];
  /** The tables and enums it can read, by name: which file declares each, and its kind. */
  tables: Record<string, { from: string; kind: "data" | "enum" | "my" | "session" }>;
}

export interface CheckOptions {
  /** The source's logical path in its tree, such as `/Profile.vad` or `/Today.md`. */
  path: string;
  /** Reads another file of the tree by logical path; `undefined` when there is none. */
  read?: (path: string) => string | undefined;
  /** The UI language's element types. When given, any other type that isn't a view is an error. */
  uiTypes?: readonly string[];
}

export const BUILTIN_NAMES = ["me", "community", "page", "now", "today"] as const;
export const BUILTIN_FUNCTIONS = ["count", "exists", "sum", "min", "max", "lower", "upper", "trim", "length", "set"] as const;
const ROW_OPS = ["create", "edit", "delete", "move"];
const LANGUAGE_ATTRIBUTES = new Set(["for", "where", "if", "orderBy", "group", "limit", "fallback", "key", "slot"]);
const DATA_ATTRIBUTES = new Set(["for", "where", "if", "orderBy", "limit"]);

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

export const isSchemaPath = (path: string): boolean => path === "/schema.vad" || path.endsWith("/schema.vad");

/** The name a `.vad` file's unnamed view takes when used: its node's name, if that is a name. */
function nodeName(path: string): string | null {
  if (isSchemaPath(path)) return null;
  const base = path.replace(/\.vad$/, "").replace(/\/_index$/, "");
  const name = base.slice(base.lastIndexOf("/") + 1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
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
  /** The tables read, for a mutation's reads. */
  reads?: Set<string>;
}

type Fact = Extract<Line, { kind: "fact" }>;

export class Checker {
  readonly diagnostics: Diagnostic[] = [];
  readonly models = new Map<string, ModelInfo>();
  private readonly ambiguousModels = new Set<string>();
  /** Enum value names, to the enums that have each. */
  private readonly enumValues = new Map<string, string[]>();
  readonly views = new Map<string, { decl: ViewDecl; from: string }>();
  readonly rules = new Map<string, { decls: RuleDecl[]; from: string }>();
  readonly mutations = new Map<string, { decl: MutationDecl; from: string }>();
  private readonly uses: string[] = [];
  private readonly bound = new Set<string>();
  private readonly effectsMemo = new Map<string, { writes: Write[]; errors: ErrorCode[] }>();
  readonly planner: ElementPlanner;
  readonly isSchema: boolean;

  constructor(readonly source: Loaded, readonly options: CheckOptions) {
    this.planner = new ElementPlanner(this);
    this.isSchema = isSchemaPath(source.path);
  }

  error(code: string, message: string, span: Span | undefined, path?: string): void {
    const at = span ?? { line: 1, column: 1, endLine: 1, endColumn: 1 };
    this.diagnostics.push({ code, message, ...at, ...(path && path !== this.source.path ? { path } : {}) });
  }

  // ---------------------------------------------------------------- binding

  private addModel(model: ModelInfo): void {
    const existing = this.models.get(model.name);
    if (existing && model.kind === "person" && existing.kind === "person") {
      for (const [name, field] of model.fields) if (!existing.fields.has(name)) existing.fields.set(name, field);
      return;
    }
    if (existing) {
      if (existing.schema === model.schema) return;
      if (model.schema === this.source.path && model.span) {
        this.error("duplicate-name", `${model.name} is already a table of ${existing.schema}`, model.span);
      } else this.ambiguousModels.add(model.name);
      return;
    }
    this.models.set(model.name, model);
    for (const value of model.values) {
      const enums = this.enumValues.get(value) ?? [];
      if (!enums.includes(model.name)) enums.push(model.name);
      this.enumValues.set(value, enums);
    }
  }

  /** Binds a collection schema's tables; `span` is the `use` that binds it. */
  private bindSchema(path: string, span: Span | undefined): void {
    if (this.bound.has(path)) return;
    this.bound.add(path);
    if (path === this.source.path) {
      const { usl, diagnostics, defaults } = uslFileOf(this.source.file, true);
      const result = checkUsl(usl);
      this.diagnostics.push(...diagnostics, ...result.diagnostics);
      for (const model of modelsOf(path, result, defaults)) this.addModel(model);
      return;
    }
    const text = this.options.read?.(path);
    if (text === undefined) {
      this.error("use-not-found", `There is no schema at ${path}`, span);
      return;
    }
    if (!this.uses.includes(path)) this.uses.push(path);
    const { usl, diagnostics, defaults } = uslFileOf(parseView(text).file, true);
    const result = checkUsl(usl);
    const problems = [...diagnostics, ...result.diagnostics];
    if (problems.length) {
      this.error("schema-invalid", `${path} doesn't check (${problems[0]!.code}: ${problems[0]!.message})`, span);
    }
    for (const model of modelsOf(path, result, defaults)) this.addModel(model);
  }

  /** The nearest collection schema: the source itself, or `schema.vad` in its folder or above. */
  private bindAncestorSchema(): void {
    if (this.isSchema) {
      this.bindSchema(this.source.path, undefined);
      return;
    }
    let dir = dirname(this.source.path);
    for (;;) {
      const path = (dir === "/" ? "" : dir) + "/schema.vad";
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
      if (path === this.source.path) {
        this.error("use-cycle", "A file can't use itself", decl.span);
        continue;
      }
      if (!path.endsWith(".vad") && !path.endsWith(".md")) {
        const hint = path.endsWith(".view") || path.endsWith(".usl") ? `; .view and .usl files are now .vad` : "";
        this.error("use-not-found", `${decl.path} is neither a .vad file nor a page${hint}`, decl.span);
        continue;
      }
      const text = this.options.read?.(path);
      if (text === undefined) {
        this.error("use-not-found", `There is no file at ${path}`, decl.span);
        continue;
      }
      if (this.usesTransitively(path, new Set([this.source.path]))) {
        this.error("use-cycle", `${path} uses this file, directly or through others`, decl.span);
        continue;
      }
      if (!this.uses.includes(path)) this.uses.push(path);
      const used = load(path, text);
      if (isSchemaPath(path)) this.bindSchema(path, decl.span);
      const declared = declaredIn(used.file, path);
      const locals = isSchemaPath(path) ? [] : localModels(used.file, path);
      const unnamedName = path.endsWith(".vad") ? nodeName(path) : null;
      const add = (name: string, as: string) => {
        if (name === "view") {
          if (!declared.unnamed || !path.endsWith(".vad")) return false;
          offer(as, "view", path, decl.span);
          this.views.set(as, { decl: declared.unnamed, from: path });
          return true;
        }
        const view = declared.views.get(name);
        const rule = declared.rules.get(name);
        const mutation = declared.mutations.get(name);
        const table = locals.find((m) => m.name === name) ?? (this.models.get(name)?.schema === path ? this.models.get(name) : undefined);
        if (view) this.views.set(as, view);
        if (rule) this.rules.set(as, rule);
        if (mutation) this.mutations.set(as, mutation);
        if (view || rule || mutation) offer(as, view ? "view" : rule ? "rule" : "mutation", path, decl.span);
        if (table && table.schema === path && locals.includes(table)) {
          if (as !== name) this.error("unknown-pick", "A table keeps its name; it can't be renamed", decl.span);
          this.addModel(table);
        }
        return Boolean(view || rule || mutation || table);
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
        for (const model of locals) this.addModel(model);
        if (declared.unnamed && unnamedName) add("view", unnamedName);
      }
      // A used file's own schemas bind their tables here too.
      for (const { decl: inner } of used.file.declarations) {
        if (inner.kind !== "use") continue;
        const target = resolvePath(path, inner.path);
        if (isSchemaPath(target) && target !== this.source.path) this.bindSchema(target, decl.span);
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
      if (decl.kind !== "use") continue;
      const target = resolvePath(path, decl.path);
      if (target === this.source.path || (!seen.has(target) && this.usesTransitively(target, next))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- the source's own tables

  /** Checks the state tables and enums a file that isn't a schema declares, and every default. */
  private checkOwnTables(): void {
    const isType = (name: string) => (VALUE_TYPES as readonly string[]).includes(name) || this.models.has(name) || name === "Person";
    for (const { decl } of this.source.file.declarations) {
      if (decl.kind !== "table" && decl.kind !== "enum") continue;
      const isState = decl.kind === "table" && (decl.tableKind === "my" || decl.tableKind === "session");
      if (!isState && this.isSchema) {
        // The schema's data tables and enums are checked by the USL checker; only defaults here.
        for (const m of decl.members) if (m.kind === "field" && m.default) this.defaultValue(m.default, m.type);
        continue;
      }
      if (!isState && decl.kind === "table") continue; // reported as data-table-outside-schema
      const seen = new Set<string>();
      for (const m of decl.members) {
        if (m.kind === "field") {
          if (seen.has(m.name)) this.error("duplicate-field", `${m.name} is declared twice`, m.span);
          seen.add(m.name);
          if ((IMPLICIT_FIELDS as readonly string[]).includes(m.name)) {
            this.error("implicit-field", `Every row has ${m.name}; a table can't declare it`, m.span);
          }
          if (!isType(m.type)) this.error("unknown-type", `${m.type} is neither a value type nor a table`, m.span);
          if (m.default) this.defaultValue(m.default, m.type);
        } else if (m.kind === "end") {
          this.error("state-connection", `A state table refers to rows with a field (${m.table.toLowerCase()} ${m.table}), not a connection end`, m.span);
        } else if (m.kind === "seed") {
          this.error("state-seed", "A state table has no seed rows", m.span);
        }
      }
      if (decl.kind === "table") {
        for (const k of decl.key ?? []) {
          if (k.name !== "id" && !seen.has(k.name)) this.error("unknown-field", `${decl.name} has no field ${k.name}`, k.span);
        }
      }
    }
  }

  /** A default is a literal, a duration, an enum value, `me`, `now` or `today` (§2.1). */
  private defaultValue(e: Expr, type: string): void {
    const model = this.models.get(type);
    if (e.kind === "literal" || e.kind === "duration") {
      if (model?.kind === "enum") this.enumValue(model.name, e);
      return;
    }
    if (e.kind === "unary" && e.operator === "-" && e.operand.kind === "literal") return;
    if (e.kind === "name") {
      if (["me", "now", "today"].includes(e.name)) return;
      if (model?.kind === "enum") {
        this.enumValue(model.name, e);
        return;
      }
    }
    this.error("default-value", "A default is a literal, an enum value, me, now or today", e.span);
  }

  // ---------------------------------------------------------------- names and types

  model(name: string, span?: Span): ModelInfo | undefined {
    if (this.ambiguousModels.has(name)) {
      this.error("ambiguous-model", `${name} is declared by more than one bound file`, span);
      return undefined;
    }
    return this.models.get(name);
  }

  /** True when `name` (not shadowed) is a state table. */
  isStateModel(name: string): boolean {
    return this.models.get(name)?.kind === "state";
  }

  /** The enum an unbound name is a value of: its name, `#value` when several have it, or undefined. */
  enumOfValue(name: string): string | undefined {
    const enums = this.enumValues.get(name);
    if (!enums?.length) return undefined;
    return enums.length === 1 ? enums[0] : "#value";
  }

  private typeOfRef(ref: TypeRef | undefined): Ty {
    if (!ref) return TEXT;
    const many = ref.arity === "many";
    const optional = ref.arity === "optional";
    if ((VALUE_TYPES as readonly string[]).includes(ref.name)) return { k: "value", t: ref.name, many };
    const model = this.model(ref.name, ref.span);
    if (!model) {
      if (!this.ambiguousModels.has(ref.name)) this.error("unknown-type", `${ref.name} is neither a value type nor a table of a bound file`, ref.span);
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

  /** The field `name` of rows typed `t`, or `any` after reporting why there isn't one. */
  field(t: Ty, name: string, span: Span): Ty {
    const many = isMany(t);
    if (t.k === "any") return { k: "any", many };
    if (t.k === "row" || t.k === "enum") {
      const modelName = t.k === "row" ? t.model : t.name;
      if (modelName === "#page") return name === "children" ? { k: "row", model: "#page", many: true } : { k: "any", many };
      if (modelName.startsWith("#")) return { k: "any", many };
      const model = this.models.get(modelName);
      if (!model) return { k: "any", many };
      const field = model.fields.get(name);
      if (field) return this.fieldType(field, many);
      if (model.kind === "enum" && name === "name") return { k: "value", t: "Text", many };
      // A profile's own properties (name, handle, …) aren't in any schema.
      if (model.kind === "person") return { k: "value", t: "Text", many };
      this.error("unknown-field", `${model.name} has no field ${name}`, span);
      return { k: "any", many };
    }
    this.error("not-a-row", `${describe(t)} has no fields, so it has no ${name}`, span);
    return ANY;
  }

  /** The type of `e`, reporting what doesn't resolve. */
  typeOf(e: Expr, scope: Scope, ctx: Context): Ty {
    switch (e.kind) {
      case "literal":
        if (e.value === null) return { k: "null" };
        if (typeof e.value === "string") return TEXT;
        if (typeof e.value === "boolean") return BOOL;
        return Number.isInteger(e.value) ? INT : NUMBER;
      case "duration":
        return DURATION;
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

  /** True when nothing a name could name has the name `name`. */
  private unresolved(name: string, scope: Scope): boolean {
    return !scope.get(name) && !(BUILTIN_NAMES as readonly string[]).includes(name) && !this.models.has(name)
      && !this.ambiguousModels.has(name) && !this.enumValues.has(name) && !this.mutations.has(name)
      && !this.views.has(name) && !this.rules.has(name);
  }

  /**
   * The type of `e` where `expected` is wanted. An unknown name where an enum's value is
   * wanted is reported as a value the enum doesn't have.
   */
  valueOf(e: Expr, scope: Scope, ctx: Context, expected: Ty | undefined): Ty {
    if (expected?.k === "enum" && !expected.name.startsWith("#") && e.kind === "name" && /^[A-Z]/.test(e.name) && this.unresolved(e.name, scope)) {
      const model = this.models.get(expected.name);
      this.error("enum-value", `${e.name} isn't a ${expected.name}; it is one of ${model?.values.join(", ") ?? "its values"}`, e.span);
      return { k: "enum", name: expected.name };
    }
    return this.typeOf(e, scope, ctx);
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
    const enumName = this.enumOfValue(e.name);
    if (enumName) return { k: "enum", name: enumName };
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
        if (ty.k !== "any" && !isMany(ty) && ty.k !== "list") {
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
      const decl = rule.decls.find((d) => d.params.length === e.args.length);
      if (!decl) {
        this.error("arguments", `${e.callee} takes ${[...new Set(rule.decls.map((d) => d.params.length))].join(" or ")} arguments`, e.span);
      }
      e.args.forEach((arg, i) => {
        if (arg.name) this.error("arguments", "A rule's arguments are positional", arg.nameSpan);
        const ty = this.typeOf(arg.value, scope, { ...ctx, action: false });
        const param = decl?.params[i];
        if (param?.type) this.compatible(this.paramType(param.type), ty, arg.value);
      });
      return BOOL;
    }
    const mutation = this.mutations.get(e.callee);
    if (mutation) {
      if (!ctx.action) this.error("not-a-value", `${e.callee} is a mutation; call it in an action`, e.calleeSpan);
      this.mutationArguments(e, mutation.decl, scope, ctx);
      return { k: "action" };
    }
    if (this.views.has(e.callee)) {
      this.error("not-a-value", `${e.callee} is a view; draw it as <${e.callee} … /> or link to its address`, e.calleeSpan);
      plain();
      return ANY;
    }
    if (this.models.has(e.callee)) {
      this.error("not-a-value", `${e.callee}(…) is a fact, written as a line of a mutation`, e.calleeSpan);
      plain();
      return ANY;
    }
    this.error("unknown-function", `There is no rule, mutation or built-in function named ${e.callee}`, e.calleeSpan);
    plain();
    return ANY;
  }

  private mutationArguments(e: Extract<Expr, { kind: "call" }>, decl: MutationDecl, scope: Scope, ctx: Context): void {
    let position = 0;
    const given = new Set<string>();
    for (const arg of e.args) {
      const param = arg.name ? decl.params.find((p) => p.name === arg.name) : decl.params[position++];
      if (!param) {
        this.error("arguments", arg.name ? `${decl.name} has no parameter ${arg.name}` : `${decl.name} takes ${decl.params.length} arguments`, arg.nameSpan ?? arg.value.span);
      } else given.add(param.name);
      const ty = this.valueOf(arg.value, scope, { ...ctx, action: false }, param ? this.paramType(param.type) : undefined);
      if (param) this.compatible(this.paramType(param.type), ty, arg.value);
    }
    for (const p of decl.params) {
      if (given.has(p.name) || p.type?.arity === "optional" || p.type?.arity === "many") continue;
      this.error("missing-argument", `${decl.name} needs ${p.name}`, e.calleeSpan);
    }
  }

  /** A parameter's type, without reporting (it is reported where it is declared). */
  private paramType(ref: TypeRef | undefined): Ty {
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

  /** Reports an enum value, quoted or by name, that `name` doesn't have. */
  private enumValue(name: string, at: Expr): void {
    const value = at.kind === "literal" && typeof at.value === "string" ? at.value : at.kind === "name" && this.enumValues.has(at.name) ? at.name : null;
    if (value === null || name.startsWith("#")) return;
    const model = this.models.get(name);
    if (model && !model.values.includes(value)) {
      this.error("enum-value", `${value} isn't a ${name}; it is one of ${model.values.join(", ")}`, at.span);
    }
  }

  private sameRows(left: Ty, right: Ty): boolean {
    return !(left.k === "row" && right.k === "row" && !left.model.startsWith("#") && !right.model.startsWith("#") && left.model !== right.model);
  }

  private membership(collection: Ty, member: Ty, collectionExpr: Expr, memberExpr: Expr, e: Expr, operator: string): void {
    if (collection.k === "value" && !collection.many && (collection.t === "Text" || collection.t === "Markdown")) return;
    if (collection.k !== "any" && collection.k !== "list" && !isMany(collection)) {
      this.error("not-a-collection", `${describe(collection)} holds one value; ${operator} needs rows, values or text`, collectionExpr.span);
    } else if (!this.sameRows(member, collection)) {
      this.error("type-mismatch", `${describe(collection)} holds ${(collection as { model: string }).model} rows, never ${(member as { model: string }).model}`, e.span);
    } else if (collection.k === "enum") this.enumValue(collection.name, memberExpr);
  }

  private binaryType(e: Extract<Expr, { kind: "binary" }>, scope: Scope, ctx: Context): Ty {
    const comparison = ["==", "!=", "in", "∈", "∉", "excludes"].includes(e.operator);
    let left: Ty;
    let right: Ty;
    if (comparison && e.left.kind === "name" && /^[A-Z]/.test(e.left.name) && this.unresolved(e.left.name, scope)) {
      right = this.typeOf(e.right, scope, ctx);
      left = this.valueOf(e.left, scope, ctx, right.k === "enum" ? { k: "enum", name: right.name } : undefined);
    } else {
      left = this.typeOf(e.left, scope, ctx);
      right = this.valueOf(e.right, scope, ctx, comparison && left.k === "enum" ? { k: "enum", name: left.name } : undefined);
    }
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
        if (isMany(left) || isMany(right) || left.k === "list" || right.k === "list") {
          this.error("set-comparison", `A set is compared by membership (in, excludes) or count, not ${e.operator}`, e.span);
          return BOOL;
        }
        if (left.k === "enum") this.enumValue(left.name, e.right);
        if (right.k === "enum") this.enumValue(right.name, e.left);
        if (!this.sameRows(left, right)) this.error("type-mismatch", `${describe(left)} and ${describe(right)} are never equal`, e.span);
        return BOOL;
      case "in":
      case "∈":
      case "∉":
        this.membership(right, left, e.right, e.left, e, e.operator);
        return BOOL;
      case "excludes":
        this.membership(left, right, e.left, e.right, e, e.operator);
        return BOOL;
      case "??":
        return left.k === "null" ? right : left;
      case "+":
      case "-":
        // On a set, + adds a member and - removes one.
        if (isMany(left) || left.k === "list") {
          const member = left.k === "list" ? left.of : ({ ...left, many: false } as Ty);
          const added = isMany(right) ? ({ ...right, many: false } as Ty) : right.k === "list" ? right.of : right;
          if (!this.sameRows(member, added)) this.error("type-mismatch", `${describe(left)} holds ${describe(member)}, not ${describe(added)}`, e.right.span);
          return left;
        }
        if (left.k === "value" && left.t === "Date") return right.k === "value" && right.t === "Date" && e.operator === "-" ? DURATION : DATE;
        if (left.k === "value" && left.t === "Duration" && right.k === "value" && right.t === "Date") return DATE;
        if (e.operator === "+" && ((left.k === "value" && left.t === "Text") || (right.k === "value" && right.t === "Text"))) return TEXT;
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
    if (where && !forAttribute) {
      this.error("where-without-for", "where narrows a for's matches; on an element without for, write if={…}", where.nameSpan);
    }
    if (where?.value.kind === "where") for (const c of where.value.conditions) this.condition(c, inner, ctx);
    const ifAttribute = get("if");
    if (ifAttribute && forAttribute) {
      this.error("if-with-for", "if is for an element without for; narrow a for's matches with where={…}", ifAttribute.nameSpan);
    }
    if (ifAttribute?.value.kind === "if") for (const c of ifAttribute.value.conditions) this.condition(c, inner, ctx);
    const order = get("orderBy");
    if (order?.value.kind === "orderBy") for (const t of order.value.terms) this.typeOf(t.value, inner, ctx);
    const group = get("group");
    if (group) {
      if (!forAttribute) this.error("group-without-for", "group groups a for's matches", group.nameSpan);
      if (group.value.kind !== "expr") this.error("syntax", "group takes {expression}", group.span);
      else this.typeOf(group.value.expr, inner, ctx);
    }
    const limit = get("limit");
    if (limit) {
      if (limit.value.kind !== "expr") this.error("limit", "limit takes a number: limit={12}", limit.span);
      else {
        const ty = this.typeOf(limit.value.expr, scope, ctx);
        if (ty.k !== "any" && !(ty.k === "value" && (ty.t === "Int" || ty.t === "Number") && !ty.many)) {
          this.error("limit", `limit takes a number, and this is ${describe(ty)}`, limit.value.expr.span);
        }
        const readsState = this.readsState(limit.value.expr, scope)
          || (forAttribute?.value.kind === "for" && forAttribute.value.bindings.some((b) => this.readsState(b.source, scope)))
          || (where?.value.kind === "where" && where.value.conditions.some((c) => this.readsState(c, inner)))
          || (order?.value.kind === "orderBy" && order.value.terms.some((t) => this.readsState(t.value, inner)));
        if (readsState) {
          this.error("limit-reads-state", "The host can't cut what it can't see: a limit's element can't filter or order by state; take the value as an input instead", limit.span);
        }
      }
    }
    const key = get("key");
    if (key?.value.kind === "expr") this.typeOf(key.value.expr, inner, ctx);
    const slot = get("slot");
    if (slot && slot.value.kind !== "text") this.error("slot", 'slot takes a name in quotes: slot="actions"', slot.span);
    for (const a of el.attributes) {
      if (["for", "where", "if", "orderBy"].includes(a.name) && a.value.kind !== a.name) {
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
        else this.compatible(this.paramType(param.type), ty, a.value.kind === "expr" ? a.value.expr : a.value.kind === "text" ? a.value.text : { kind: "literal", value: true, span: a.span });
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

  /** True when `e` reads state: a `state` or `keep` name, a state table, or a row of one. */
  readsState(e: Expr, scope: Scope): boolean {
    let found = false;
    walk(e, (x) => {
      if (x.kind !== "name") return;
      const bound = scope.get(x.name);
      if (bound) {
        if (bound.kind === "state" || bound.kind === "keep") found = true;
        else if (bound.ty.k === "row" && this.isStateModel(bound.ty.model)) found = true;
      } else if (this.isStateModel(x.name)) found = true;
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
    if (decl.data) {
      this.checkData(decl.data, scope, null);
      return { name, params: decl.params.map((p) => this.param(p)), state: [], events: [], plan: null, data: this.planner.data(decl.data, scope) };
    }
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

  /** Checks a data view's record; `about` is the row its bare fields are of, or null at the top. */
  private checkData(record: DataRecord, scope: Scope, about: Ty | null): void {
    const ctx: Context = { mutation: false, action: false };
    const keys = new Set<string>();
    for (const entry of record.entries) {
      if (entry.kind === "comment") continue;
      const key = entry.kind === "field" ? entry.name : entry.key;
      const keySpan = entry.kind === "field" ? entry.nameSpan : entry.keySpan;
      if (keys.has(key)) this.error("duplicate-key", `${key} is given twice`, keySpan);
      keys.add(key);
      switch (entry.kind) {
        case "value": {
          const ty = this.typeOf(entry.value, scope, ctx);
          if (ty.k === "action" || ty.k === "element") this.error("not-data", `A data view returns values, and this is ${describe(ty)}`, entry.value.span);
          break;
        }
        case "field": {
          if (!about) {
            this.error("data-entry-key", `The outermost braces are about no row; write ${key}: and a value`, keySpan);
            break;
          }
          const ty = this.field(about, entry.name, entry.nameSpan);
          if (!entry.record) break;
          if (ty.k === "any") this.checkData(entry.record, scope, ty);
          else if (ty.k === "enum" && !ty.name.startsWith("#")) this.checkData(entry.record, scope, { k: "enum", name: ty.name });
          else if (ty.k !== "row" || ty.model.startsWith("#")) {
            this.error("not-a-relationship", `${entry.name} is ${describe(ty)}, not a relationship to follow`, entry.nameSpan);
          } else this.checkData(entry.record, scope, { k: "row", model: ty.model });
          break;
        }
        case "record": {
          const get = (name: string) => entry.attributes.find((a) => a.name === name);
          const seen = new Set<string>();
          for (const a of entry.attributes) {
            if (seen.has(a.name)) this.error("duplicate-attribute", `${a.name} is given twice`, a.nameSpan);
            seen.add(a.name);
            if (!DATA_ATTRIBUTES.has(a.name)) this.error("unknown-attribute", `A data view's record takes for, where, orderBy, limit and if, not ${a.name}`, a.nameSpan);
            else if (a.name !== "limit" && a.value.kind !== a.name) this.error("syntax", `${a.name} takes {…}`, a.span);
            else if (a.name === "limit" && a.value.kind !== "expr") this.error("limit", "limit takes a number: limit={12}", a.span);
          }
          const inner = scope.child();
          let row: Ty | null = about;
          const forAttribute = get("for");
          if (forAttribute?.value.kind === "for") {
            for (const b of forAttribute.value.bindings) {
              row = this.bindingType(b, scope, inner, ctx);
              inner.set(b.name, { ty: row, kind: "binding" });
            }
          }
          const where = get("where");
          if (where && !forAttribute) this.error("where-without-for", "where narrows a for's matches; without for, write if={…}", where.nameSpan);
          if (where?.value.kind === "where") for (const c of where.value.conditions) this.condition(c, inner, ctx);
          const ifAttribute = get("if");
          if (ifAttribute && forAttribute) this.error("if-with-for", "if is for a record without for; narrow a for's matches with where={…}", ifAttribute.nameSpan);
          if (ifAttribute?.value.kind === "if") for (const c of ifAttribute.value.conditions) this.condition(c, inner, ctx);
          const order = get("orderBy");
          if (order?.value.kind === "orderBy") for (const t of order.value.terms) this.typeOf(t.value, inner, ctx);
          const limit = get("limit");
          if (limit?.value.kind === "expr") {
            const ty = this.typeOf(limit.value.expr, scope, ctx);
            if (ty.k !== "any" && !(ty.k === "value" && (ty.t === "Int" || ty.t === "Number") && !ty.many)) {
              this.error("limit", `limit takes a number, and this is ${describe(ty)}`, limit.value.expr.span);
            }
          }
          this.checkData(entry.record, inner, row);
          break;
        }
      }
    }
  }

  private param(p: Param): CheckedParam {
    return { name: p.name, type: p.type?.name ?? "Text", arity: p.type?.arity ?? "one" };
  }

  private checkRule(decl: RuleDecl): void {
    const scope = new Scope();
    this.paramsScope(decl.params, scope);
    for (const line of decl.body) if (line.kind === "condition") this.condition(line.condition, scope, { mutation: false, action: false });
    if (!decl.body.some((line) => line.kind === "condition")) this.error("empty-rule", `${decl.name} has no conditions`, decl.nameSpan);
  }

  private ruleCycles(): void {
    const calls = (decls: RuleDecl[]) => {
      const names = new Set<string>();
      for (const d of decls) {
        for (const line of d.body) {
          if (line.kind === "condition") walk(line.condition, (x) => x.kind === "call" && this.rules.has(x.callee) && names.add(x.callee));
        }
      }
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

  // ---------------------------------------------------------------- mutations

  private checkMutation(decl: MutationDecl): CheckedMutation {
    const scope = new Scope();
    this.paramsScope(decl.params, scope);
    const reads = new Set<string>();
    const ctx: Context = { mutation: true, action: false, reads };
    for (const p of decl.params) {
      const model = p.type ? this.models.get(p.type.name) : undefined;
      if (model && model.kind !== "enum") reads.add(model.name);
    }
    if (decl.rowAction) {
      const { model, op, span } = decl.rowAction;
      if (this.models.get(model)?.kind !== "data") this.error("unknown-model", `${model} is not a table of a bound schema`, span);
      if (!ROW_OPS.includes(op)) this.error("row-action", `A row action is one of ${ROW_OPS.join(", ")}`, span);
      else if (op !== "create" && decl.params[0]?.type?.name !== model) {
        this.error("row-action", `The ${op} action's first parameter is the row: (row ${model})`, span);
      }
    }
    const lets: CheckedMutation["lets"] = [];
    this.lines(decl.body, scope, ctx, decl, null, lets);
    const effects = this.effectsOf(decl.name, []);
    return {
      name: decl.name,
      params: decl.params.map((p) => this.param(p)),
      ...(decl.rowAction ? { rowAction: { model: decl.rowAction.model, op: decl.rowAction.op } } : {}),
      writes: effects.writes,
      lets,
      errors: effects.errors,
      reads: [...reads].sort(),
    };
  }

  /** Checks a block of mutation lines; `block` is the `if` or `for` holding them, if any. */
  private lines(list: Line[], outer: Scope, ctx: Context, decl: MutationDecl, block: "if" | "for" | null, lets: CheckedMutation["lets"]): void {
    const scope = outer.child();
    // Every line reads the rows as they were before the mutation, so a block's let names are
    // usable on any of its lines and in the blocks inside it.
    for (const line of list) {
      if (line.kind !== "fact" || !line.name) continue;
      if (scope.get(line.name)) this.error("duplicate-name", `${line.name} is already declared in this mutation`, line.nameSpan);
      if ((BUILTIN_NAMES as readonly string[]).includes(line.name)) this.error("builtin-name", `${line.name} is a built-in name`, line.nameSpan);
      const model = this.models.get(line.call.callee);
      scope.set(line.name, { ty: model && model.kind !== "enum" ? { k: "row", model: model.name } : ANY, kind: "let" });
      if (model) lets.push({ name: line.name, table: model.name });
    }
    const errors = list.filter((l) => l.kind === "error");
    if (errors.length) {
      if (block !== "if") this.error("error-outside-if", "A public error goes in an if block that says when it applies", errors[0]!.span);
      else if (list.some((l) => l.kind !== "error" && l.kind !== "comment") || errors.length > 1) {
        this.error("error-not-alone", "A block holding an error holds nothing else", errors[0]!.span);
      }
    }
    const written = new Map<string, Span>();
    for (const line of list) {
      switch (line.kind) {
        case "comment":
        case "error":
          break;
        case "if":
          this.condition(line.condition, scope, ctx);
          this.lines(line.body, scope, ctx, decl, "if", lets);
          break;
        case "for": {
          const inner = scope.child();
          for (const b of line.bindings) inner.set(b.name, { ty: this.bindingType(b, scope, inner, ctx), kind: "binding" });
          for (const c of line.where) this.condition(c, inner, ctx);
          this.lines(line.body, inner, ctx, decl, "for", lets);
          break;
        }
        case "set": {
          this.setLine(line, scope, ctx);
          // Two values for one field of one row can't both hold.
          if (line.target.object.kind === "name") {
            const key = `${line.target.object.name}.${line.target.name}`;
            if (written.has(key)) this.error("conflicting-writes", `${key} is given two values; a mutation's lines all hold together`, line.target.span);
            written.set(key, line.target.span);
          }
          break;
        }
        case "fact":
          this.fact(line, scope, ctx, decl);
          break;
      }
    }
  }

  private setLine(line: Extract<Line, { kind: "set" }>, scope: Scope, ctx: Context): void {
    const { target } = line;
    const object = this.typeOf(target.object, scope, ctx);
    const known = object.k === "row" ? this.models.get(object.model)?.fields.get(target.name) : undefined;
    const value = this.valueOf(line.value, scope, ctx, known && known.arity !== "many" ? this.fieldType(known, false) : undefined);
    if (object.k === "any") return;
    const model = object.k === "row" && !object.model.startsWith("#") ? this.models.get(object.model) : undefined;
    if (!model || isMany(object) || (model.kind !== "data" && model.kind !== "state")) {
      this.error("not-a-row", `A field line sets a field of one row, and this is ${describe(object)}`, target.object.span);
      return;
    }
    const field = model.fields.get(target.name);
    if (!field) {
      this.error("unknown-field", `${model.name} has no field ${target.name}`, target.nameSpan);
      return;
    }
    if (field.implicit) {
      this.error("implicit-field", `A mutation can't write ${field.name}`, target.nameSpan);
      return;
    }
    this.fieldValue(model, field, value, line.value);
  }

  /** Reports a value that can't be `field`'s: a many-valued field takes a list or a set. */
  private fieldValue(model: ModelInfo, field: FieldInfo, ty: Ty, at: Expr): void {
    if (field.arity !== "many") {
      if (isMany(ty) || ty.k === "list") this.error("type-mismatch", `${model.name}.${field.name} holds one value, and this is many`, at.span);
      else this.compatible(this.fieldType(field, false), ty, at);
      return;
    }
    const member = ty.k === "list" ? ty.of : isMany(ty) ? ({ ...ty, many: false } as Ty) : null;
    if (!member) {
      if (ty.k !== "any" && ty.k !== "null") this.error("type-mismatch", `${model.name}.${field.name} holds many values; give a list or a set`, at.span);
      return;
    }
    if (member.k === "row" && !member.model.startsWith("#")) {
      const allowed = this.memberModels(model.name, field);
      if (!allowed.includes(member.model)) this.error("type-mismatch", `${model.name}.${field.name} holds ${allowed.join(" or ")}, not ${member.model}`, at.span);
    } else if (ty.k === "list") for (const item of (at.kind === "list" ? at.items : [])) this.compatible(this.fieldType(field, false), member, item);
  }

  /** The rows a to-many field's members can be given as: its table, or a connection table's far end. */
  private memberModels(owner: string, field: FieldInfo): string[] {
    const target = this.models.get(field.type);
    if (target && target.ends.length === 2) {
      const far = target.ends.find((e) => e.model !== owner) ?? target.ends[1]!;
      return [field.type, far.model];
    }
    return [field.type];
  }

  private fact(line: Fact, scope: Scope, ctx: Context, decl: MutationDecl): void {
    const { call } = line;
    const mutation = this.mutations.get(call.callee);
    if (mutation && !this.models.has(call.callee)) {
      if (line.negated) this.error("negated-mutation", "not applies to a row fact; a mutation's facts can't be negated", call.calleeSpan);
      if (line.name) this.error("let-mutation", "let names a row a table fact makes; a mutation call makes none", line.nameSpan);
      if (mutation.decl === decl) this.error("mutation-cycle", "A mutation can't include itself", call.calleeSpan);
      this.mutationArguments(call, mutation.decl, scope, { ...ctx, action: true });
      return;
    }
    const model = this.model(call.callee, call.calleeSpan);
    const checkArgs = () => call.args.forEach((a) => this.typeOf(a.value, scope, ctx));
    if (!model) {
      if (!this.ambiguousModels.has(call.callee)) {
        this.error("unknown-table", `There is no table or mutation named ${call.callee}`, call.calleeSpan);
      }
      checkArgs();
      return;
    }
    if (model.kind !== "data" && model.kind !== "state") {
      this.error("not-writable", model.kind === "enum" ? `${model.name}'s values are written in its declaration` : `${model.name} has no rows a mutation writes`, call.calleeSpan);
      checkArgs();
      return;
    }
    if (ctx.reads) ctx.reads.add(model.name);
    const given = new Set<string>();
    for (const arg of call.args) {
      const named = arg.name ? model.fields.get(arg.name) : undefined;
      const ty = this.valueOf(arg.value, scope, ctx, named && named.arity !== "many" ? this.fieldType(named, false) : undefined);
      if (!arg.name) {
        this.error("fact-argument", `A fact names each field it gives: ${model.name}(field: value, …)`, arg.value.span);
        continue;
      }
      if (given.has(arg.name)) this.error("duplicate-field", `${arg.name} is given twice`, arg.nameSpan);
      given.add(arg.name);
      const field = model.fields.get(arg.name);
      if (!field) {
        this.error("unknown-field", `${model.name} has no field ${arg.name}`, arg.nameSpan);
        continue;
      }
      if (field.implicit && !line.negated) {
        this.error("implicit-field", field.name === "id" ? "A new row's id comes from the mutation's identity" : `${field.name} is set by accepted changes, not by mutations`, arg.nameSpan);
        continue;
      }
      this.fieldValue(model, field, ty, arg.value);
    }
    if (line.negated || call.args.some((a) => !a.name)) return;
    if (factOp(model, given) === null) {
      const rest = model.key.filter((k) => k !== "id");
      this.error("fact-key", `A ${model.name} fact gives its key (${model.key.join(", ")})${model.key.includes("id") ? `, or ${rest.length ? rest.join(", ") : "nothing"} of it for a new row` : ""}`, call.span);
      return;
    }
    for (const field of model.fields.values()) {
      if (field.implicit || field.arity !== "one" || given.has(field.name) || model.defaults.has(field.name)) continue;
      this.error("missing-field", `A new ${model.name} needs ${field.name}, which has no default`, call.calleeSpan);
    }
  }

  /** A mutation's writes and errors, its called mutations' included. */
  private effectsOf(name: string, stack: string[]): { writes: Write[]; errors: ErrorCode[] } {
    const memo = this.effectsMemo.get(name);
    if (memo) return memo;
    const entry = this.mutations.get(name);
    if (!entry || stack.includes(name)) return { writes: [], errors: [] };
    const writes: Write[] = [];
    const errors: ErrorCode[] = [];
    const tables = new Map<string, string>();
    for (const p of entry.decl.params) if (p.type && this.models.has(p.type.name)) tables.set(p.name, p.type.name);
    const tableOf = (e: Expr): string | undefined => {
      if (e.kind === "name") return tables.get(e.name) ?? (this.models.has(e.name) ? e.name : undefined);
      if (e.kind === "field") {
        const owner = tableOf(e.object);
        return owner ? this.models.get(owner)?.fields.get(e.name)?.type : undefined;
      }
      return undefined;
    };
    const visit = (list: Line[]) => {
      for (const line of list) {
        if (line.kind === "fact" && line.name && this.models.has(line.call.callee)) tables.set(line.name, line.call.callee);
      }
      for (const line of list) {
        switch (line.kind) {
          case "error":
            if (!errors.includes(line.code)) errors.push(line.code);
            break;
          case "if":
            visit(line.body);
            break;
          case "for":
            for (const b of line.bindings) {
              const table = tableOf(b.source);
              if (table) tables.set(b.name, table);
            }
            visit(line.body);
            break;
          case "set": {
            const table = tableOf(line.target.object);
            if (table) writes.push({ op: "update", table, fields: [line.target.name] });
            break;
          }
          case "fact": {
            const model = this.models.get(line.call.callee);
            if (model && (model.kind === "data" || model.kind === "state")) {
              const fields = line.call.args.flatMap((a) => (a.name ? [a.name] : []));
              if (line.negated) writes.push({ op: "delete", table: model.name });
              else writes.push({ op: factOp(model, new Set(fields)) ?? "insert", table: model.name, fields });
            } else if (this.mutations.has(line.call.callee)) {
              const called = this.effectsOf(line.call.callee, [...stack, name]);
              writes.push(...called.writes);
              for (const code of called.errors) if (!errors.includes(code)) errors.push(code);
            }
            break;
          }
          default:
            break;
        }
      }
    };
    visit(entry.decl.body);
    const merged = new Map<string, Write>();
    for (const w of writes) {
      const key = `${w.op} ${w.table}`;
      const existing = merged.get(key);
      if (existing && w.fields) existing.fields = [...new Set([...(existing.fields ?? []), ...w.fields])].sort();
      else if (!existing) merged.set(key, { ...w, ...(w.fields ? { fields: [...w.fields].sort() } : {}) });
    }
    const result = { writes: [...merged.values()].sort((a, b) => `${a.table} ${a.op}`.localeCompare(`${b.table} ${b.op}`)), errors };
    this.effectsMemo.set(name, result);
    return result;
  }

  // ---------------------------------------------------------------- the source

  run(): ViewCheck {
    this.diagnostics.push(...this.source.diagnostics);
    const file = this.source.file;
    const isPage = this.source.path.endsWith(".md");
    this.bindAncestorSchema();
    if (!this.isSchema) {
      this.diagnostics.push(...uslFileOf(file, false).diagnostics);
    }
    this.bindUses();
    for (const model of localModels(file, this.source.path)) {
      if (this.isSchema && model.kind === "enum") continue; // already bound with the schema
      this.addModel(model);
    }
    this.checkOwnTables();
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
      else if (decl.kind === "rule") declare(decl.name, "rule", decl.nameSpan);
      else if (decl.kind === "mutation") declare(decl.name, "mutation", decl.nameSpan);
      else if (decl.kind === "table" || decl.kind === "enum") {
        if (names.get(decl.name) === "table") continue; // reported by the table checker
        declare(decl.name, "table", decl.nameSpan);
      }
    }
    this.ruleCycles();
    for (const { decl } of file.declarations as { decl: Declaration }[]) {
      switch (decl.kind) {
        case "view": {
          let name = decl.name ?? "";
          if (decl.name === null) {
            unnamed += 1;
            if (isPage) name = `#${unnamed}`;
            else if (unnamed > 1) this.error("two-unnamed-views", "A .vad file has at most one unnamed view", decl.nameSpan);
          }
          views.push(this.checkView(decl, name));
          break;
        }
        case "element": {
          if (!isPage) {
            this.error("bare-element", "In a .vad file an element belongs to a view: view(): and the element below", decl.element.typeSpan);
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
    const tables: ViewCheck["tables"] = {};
    for (const [name, model] of [...this.models].sort(([a], [b]) => a.localeCompare(b))) {
      if (model.kind === "person") continue;
      tables[name] = { from: model.schema, kind: model.kind === "state" ? model.state! : model.kind };
    }
    this.diagnostics.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.line - b.line || a.column - b.column);
    return { diagnostics: this.diagnostics, views, rules, mutations, uses: this.uses, tables };
  }
}

/**
 * What a positive fact giving `given` does: `upsert` when it gives the table's whole key,
 * `insert` when it gives all of it but `id` (a new row), and `null` when it gives too little.
 */
function factOp(model: ModelInfo, given: Set<string>): "insert" | "upsert" | null {
  if (model.key.every((k) => given.has(k))) return "upsert";
  if (model.key.includes("id") && model.key.every((k) => k === "id" || given.has(k))) return "insert";
  return null;
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
    else if (v.kind === "where" || v.kind === "if") v.conditions.forEach((c) => walk(c, visit));
    else if (v.kind === "orderBy") v.terms.forEach((t) => walk(t.value, visit));
  }
  for (const child of el.children ?? []) {
    if (child.kind === "element") walkElement(child.element, visit);
    else if (child.kind === "text") for (const p of child.parts) if (typeof p !== "string") walk(p, visit);
  }
}

/** Checks a `.vad` file, a collection's `schema.vad`, or a page's view blocks. */
export function checkView(text: string, options: CheckOptions): ViewCheck {
  return new Checker(load(options.path, text), options).run();
}

export type { PlanExpr, ElementPlan };
