// Views (executable documents §4.1, authoring API §3).
//
// A view is ordinary JavaScript over rows. It reaches rows three ways: a model's rows
// through facts (`List.all(l => [facts])`, `List.one(…)`), a relationship by reading it
// (`l.items`), and a relationship narrowed by facts (`p.tags.all(t => [facts])`).
//
// The host learns a view's shape by running it twice:
// 1. The plan pass runs it over stand-in rows that record every read. Each `all`/`one`
//    becomes a root of the plan, each relationship read a nested selection, each field read
//    a selected field, and each fact a predicate. A stand-in is never null and a stand-in
//    relationship has one row.
// 2. The value pass runs it again over the plan's results. A read the plan pass missed (a
//    branch it didn't take) is recorded, the run carries on over stand-ins, and the plan
//    widens and runs again.
//
// Facts compile to the plan IR (`QueryPlan`) that `SQLiteQueryEngine` runs: path facts and
// helper variables become joins, `not` an anti-join, and rules are inlined. Rows from
// enclosing code are bound by scope, so a nested read's matches nest under each outer row.
// A model's read rules are the host's, not the view's: the planner adds them to every read
// of the model, so a view that forgets them, or a forged `missed` path, can't see past them.

import {
  registerSourceMethods,
  type CountExpression,
  type FieldExpression,
  type NodeHandle,
  type OrderExpression,
  type PredicateExpression,
  type QueryHandle,
  type QueryPlan,
  type RelationshipSelection,
  type Selection,
  type SelectionPlan,
  type StandardSchemaV1,
  type ValueExpression,
} from "./authoring.ts";
import { QueryCompileError, QueryInputError, validateQueryInput } from "./query-core.ts";
import type { RelationshipMetadata, ResolvedStorySource, StoreSchema } from "./schema.ts";
import type { SQLiteQueryEngine } from "./sqlite.ts";

// ---------------------------------------------------------------- public types

declare const MODEL: unique symbol;

/** A row's key, branded by its model so a fact can't take a List where it expects a Person. */
export type Key<Model extends string = string> = string & { readonly [MODEL]?: Model };

/** A relationship's rows: an array, narrowed further with facts or a limit. */
export interface Rows<Row> extends ReadonlyArray<Row> {
  all(facts: (row: FactRow<Row>) => Facts): Rows<Row>;
  all<H extends Helpers>(helpers: H, facts: (row: FactRow<Row>, helpers: HelperVars<H>) => Facts): Rows<Row>;
  /** Order in the plan. Only worth it with `take`: otherwise sort in JS. */
  orderBy(order: (row: OrderRow<Row>) => OrderTerm | OrderTerm[]): Rows<Row>;
  take(count: number): Rows<Row>;
}

/** A model's rows, as `node("./data/List").children`. */
export interface Source<Row> {
  readonly __row?: Row;
  all(facts: (row: FactRow<Row>) => Facts): Rows<Row>;
  all<H extends Helpers>(helpers: H, facts: (row: FactRow<Row>, helpers: HelperVars<H>) => Facts): Rows<Row>;
  one(facts: (row: FactRow<Row>) => Facts): Row | null;
  one<H extends Helpers>(helpers: H, facts: (row: FactRow<Row>, helpers: HelperVars<H>) => Facts): Row | null;
}

declare const FACT_BRAND: unique symbol;
/** One clause of a view's facts. */
export interface Fact { readonly [FACT_BRAND]: true }
export type Facts = ReadonlyArray<Fact | Facts>;

type Helpers = Record<string, Source<any>>;
type HelperVars<H extends Helpers> = { readonly [K in keyof H]: FactRow<NonNullable<H[K]["__row"]>> };

type RowLike = { readonly id?: unknown };
type ValueOf<Row> = Row | Key | string | number;

/** A field in facts. */
export interface FactField<Value> {
  is(value: Value | null): Fact;
  contains(text: string): Fact;
}
/** A to-one relationship in facts, which can be followed further (a path fact). */
export type FactOne<Row> = { is(value: ValueOf<Row> | null): Fact } & FactMembers<Row>;
/** A to-many relationship in facts, which can be followed further (a path fact). */
export type FactMany<Row> = { has(value: ValueOf<Row>): Fact } & FactMembers<Row>;
type FactMembers<Row> = {
  readonly [K in keyof Row]-?: NonNullable<Row[K]> extends ReadonlyArray<infer Target>
    ? FactMany<Target>
    : NonNullable<Row[K]> extends RowLike & object
      ? FactOne<NonNullable<Row[K]>>
      : FactField<Row[K]>;
};
/** The row variable of a block of facts. */
export type FactRow<Row> = FactMembers<Row>;

export interface OrderTerm { readonly __order?: true }
interface OrderField extends OrderTerm { asc(): OrderTerm; desc(): OrderTerm }
type OrderRow<Row> = {
  readonly [K in keyof Row]-?: NonNullable<Row[K]> extends ReadonlyArray<any> ? { count(): OrderField } : OrderField;
};

/** Alternatives: each argument is a list of facts that must all hold. */
export function or(...alternatives: Facts[]): Fact {
  const operands = alternatives.map((facts) => conjunction(flatten(facts)) ?? TRUE);
  return fact(operands.length === 1 ? operands[0]! : { kind: "logical", id: id(), operator: "or", operands });
}

/** None of these facts hold together. */
export function not(...facts: Array<Fact | Facts>): Fact {
  const operand = conjunction(flatten(facts));
  if (!operand) throw new QueryCompileError("not() needs a fact");
  return fact({ kind: "not", id: id(), operand });
}

/** Named facts, defined once and used like a fact: `curatedBy({ l, person })`. */
export function rule<Vars>(body: (vars: Vars) => Facts): (vars: Vars) => Fact {
  return (vars) => fact(conjunction(flatten(body(vars))) ?? TRUE);
}

export interface ViewContext {
  user: { profile: string } | null;
}

export interface View<Input = unknown, Output = unknown> {
  readonly kind: "view";
  readonly schema?: StandardSchemaV1<Input, Input>;
  readonly body: (input: Input, context: ViewContext) => Output;
}

export function view<Output>(body: (input: undefined, context: ViewContext) => Output): View<undefined, Output>;
export function view<Input, Output>(schema: StandardSchemaV1<Input, Input>, body: (input: Input, context: ViewContext) => Output): View<Input, Output>;
export function view(schemaOrBody: any, possibleBody?: any): View<any, any> {
  return Object.freeze(possibleBody
    ? { kind: "view" as const, schema: schemaOrBody, body: possibleBody }
    : { kind: "view" as const, body: schemaOrBody });
}

export function isView(value: unknown): value is View {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "view";
}

/** A read as a path from a root of the plan: the root's key, then link keys, then a field. */
export type ReadPath = string[];

/** Field types and row identity for a result, parallel to its JSON (executable documents §12.1). */
export interface ResultShape {
  row?: { model: string; key: string };
  type?: string;
  fields?: Record<string, ResultShape>;
  items?: ResultShape[];
}

/** A model's read rules: facts the host adds to every read of it. */
export type ReadRules = Record<string, (row: any, context: ViewContext) => Facts>;

// ---------------------------------------------------------------- ids, keys, hashes

let nextID = 1;
function id(): number { return nextID++; }

const TRUE: PredicateExpression = {
  kind: "comparison", id: 0, operator: "eq",
  left: { kind: "literal", id: 0, value: 1 }, right: { kind: "literal", id: 0, value: 1 },
};

function canonical(value: unknown): string {
  return JSON.stringify(value, (key, child) => key === "id" && typeof child === "number" ? undefined : child) ?? "null";
}

function hash(text: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 16777619);
    b = (Math.imul(b, 33) ^ code) | 0;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

interface Narrowing {
  where?: PredicateExpression;
  orderBy: OrderExpression[];
  take?: number;
}

function narrowingKey(narrowing: Narrowing): string {
  return canonical({ where: narrowing.where, orderBy: narrowing.orderBy, take: narrowing.take });
}

function narrowed(narrowing: Narrowing | undefined): boolean {
  return Boolean(narrowing && (narrowing.where || narrowing.orderBy.length || narrowing.take !== undefined));
}

/** A link's name in results and read paths. The `~` keeps it apart from a field of the same name (`owner`). */
function linkKey(relationship: string, narrowing?: Narrowing): string {
  return narrowed(narrowing) ? `${relationship}~${narrowingKey(narrowing!)}` : `${relationship}~`;
}

const COUNT = "#count";

function rootKey(relation: string, cardinality: "many" | "maybe", narrowing: Narrowing): string {
  return `${relation}|${cardinality}|${narrowingKey(narrowing)}`;
}

// ---------------------------------------------------------------- facts

const FACT = Symbol.for("overstory.view.fact");
const ROW = Symbol.for("overstory.view.row");
const ORDER = Symbol.for("overstory.view.order");

function fact(predicate: PredicateExpression): Fact {
  return { [FACT]: predicate } as unknown as Fact;
}

function predicateOf(value: unknown): PredicateExpression {
  const predicate = (value as { [FACT]?: PredicateExpression } | null)?.[FACT];
  if (!predicate) throw new QueryCompileError("Facts must be built from a row variable, or with or(), not() or a rule");
  return predicate;
}

function flatten(facts: Facts | ReadonlyArray<Fact | Facts>): PredicateExpression[] {
  const result: PredicateExpression[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== undefined && value !== null && value !== true) result.push(predicateOf(value));
  };
  visit(facts);
  return result.filter((predicate) => predicate !== TRUE);
}

function conjunction(predicates: PredicateExpression[]): PredicateExpression | undefined {
  if (predicates.length === 0) return undefined;
  if (predicates.length === 1) return predicates[0];
  return { kind: "logical", id: id(), operator: "and", operands: predicates };
}

interface Step {
  relation: string;
  relationship: string;
  metadata: RelationshipMetadata;
}

/** A variable in facts: the block's row (`self`), a helper (`$name`), or a rule's row (no scope). */
interface VarBase {
  relation: string;
  scope: string | undefined;
}

/** What a row value passed into a fact names: some fields of a bound or scoped row. */
interface RowIdentity {
  relation: string;
  key: ValueExpression[];
}

function schemaOf(): StoreSchema {
  if (!active) throw new QueryCompileError("Facts are written only inside a view");
  return active.schema;
}

function relationshipOf(schema: StoreSchema, relation: string, name: string): RelationshipMetadata | undefined {
  return schema.relationships[`${relation}.${name}`];
}

function hasField(schema: StoreSchema, relation: string, name: string): boolean {
  return Boolean(schema.relations[relation]?.fields[name]);
}

/** Wrap a predicate about the end of a path in the joins that reach it. */
function along(base: VarBase, steps: Step[], inner: PredicateExpression | undefined, keys?: ValueExpression[]): PredicateExpression {
  let predicate = inner;
  let innerKeys = keys;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    predicate = {
      kind: "exists",
      id: id(),
      relation: step.relation,
      relationship: step.relationship,
      ...(index === 0 && base.scope ? { scope: base.scope } : {}),
      ...(predicate ? { where: predicate } : {}),
      ...(innerKeys ? { keys: innerKeys } : {}),
    } as PredicateExpression;
    innerKeys = undefined;
  }
  if (!predicate) throw new QueryCompileError("A fact needs a condition");
  return predicate;
}

function field(relation: string, name: string, scope: string | undefined): FieldExpression {
  return { kind: "field", id: id(), relation, field: name, ...(scope ? { scope } : {}) };
}

function literal(value: unknown): ValueExpression {
  return { kind: "literal", id: id(), value };
}

function rowVar(base: VarBase): unknown {
  return pathVar(base, []);
}

function pathVar(base: VarBase, steps: Step[]): unknown {
  const schema = schemaOf();
  const relation = steps.length ? steps[steps.length - 1]!.metadata.target : base.relation;
  const target = {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === ROW) return steps.length === 0 ? { variable: base } : undefined;
      if (typeof property !== "string" || property === "then") return undefined;
      const last = steps[steps.length - 1];
      if (last && property === "is") return (value: unknown) => isFact(base, steps, value);
      if (last && property === "has") return (value: unknown) => hasFact(base, steps, value);
      const metadata = relationshipOf(schema, relation, property);
      if (metadata) return pathVar(base, [...steps, { relation, relationship: property, metadata }]);
      if (hasField(schema, relation, property)) return fieldVar(base, steps, relation, property);
      throw new QueryCompileError(`${relation} has no field or relationship ${property}`);
    },
  });
}

function fieldVar(base: VarBase, steps: Step[], relation: string, name: string) {
  const own = field(relation, name, steps.length ? undefined : base.scope);
  return {
    is(value: unknown): Fact {
      const right = value === null || value === undefined ? literal(null) : scalarValue(value);
      return fact(along(base, steps, { kind: "comparison", id: id(), operator: "eq", left: own, right }));
    },
    contains(text: unknown): Fact {
      return fact(along(base, steps, { kind: "comparison", id: id(), operator: "contains", left: own, right: scalarValue(text) }));
    },
  };
}

function isFact(base: VarBase, steps: Step[], value: unknown): Fact {
  const schema = schemaOf();
  const last = steps[steps.length - 1]!;
  if (last.metadata.cardinality === "many") throw new QueryCompileError(`${last.relation}.${last.relationship} is a list: use has()`);
  const targetKey = schema.relations[last.metadata.target]!.primaryKey;
  const keys = value === null || value === undefined ? null : keyValues(value, last.metadata.target);
  const direct = last.metadata.direct;
  if (direct && targetKey.every((name) => direct.some((pair) => pair.target === name)) && direct.length === targetKey.length) {
    // A to-one held in the row's own columns: compare them, with no join.
    const scope = steps.length === 1 ? base.scope : undefined;
    const comparisons = targetKey.map((name, index): PredicateExpression => ({
      kind: "comparison", id: id(), operator: "eq",
      left: field(last.relation, direct.find((pair) => pair.target === name)!.source, scope),
      right: keys ? keys[index]! : literal(null),
    }));
    return fact(along(base, steps.slice(0, -1), conjunction(comparisons)));
  }
  if (!keys) return fact({ kind: "not", id: id(), operand: along(base, steps, undefined) });
  return fact(along(base, steps, undefined, keys));
}

function hasFact(base: VarBase, steps: Step[], value: unknown): Fact {
  const last = steps[steps.length - 1]!;
  return fact(along(base, steps, undefined, keyValues(value, last.metadata.target)));
}

/** A value for a field fact: a literal, or another row's field when it came from a row. */
function scalarValue(value: unknown): ValueExpression {
  const identity = rowIdentity(value);
  if (identity) {
    if (identity.key.length !== 1) throw new QueryCompileError(`A ${identity.relation} row has a composite key; compare its fields`);
    return identity.key[0]!;
  }
  const read = stubRead(value);
  if (read) return read;
  if (typeof value === "object" || typeof value === "function") throw new QueryCompileError("A fact compares a field with a value, a row or a key");
  return literal(value);
}

/** The key of the row a fact names, as values in the target's key order. */
function keyValues(value: unknown, target: string): ValueExpression[] {
  const schema = schemaOf();
  const identity = rowIdentity(value);
  if (identity) {
    if (identity.relation !== target) throw new QueryCompileError(`Expected a ${target} row, not a ${identity.relation} row`);
    return identity.key;
  }
  const key = schema.relations[target]!.primaryKey;
  if (key.length !== 1) throw new QueryCompileError(`A ${target} row is named by ${key.length} fields; pass the row`);
  return [scalarValue(value)];
}

// ---------------------------------------------------------------- trace model

interface TraceNode {
  relation: string;
  /** Stable across passes: the root's key, then the link keys that reach this node. */
  scope: string;
  fields: Set<string>;
  links: Map<string, TraceLink>;
}

interface TraceLink {
  key: string;
  relationship: string;
  metadata: RelationshipMetadata;
  narrowing?: Narrowing;
  node: TraceNode;
  /** The rows themselves are read. */
  rows: boolean;
  /** `.length` is read. */
  counted: boolean;
}

interface TraceRoot {
  key: string;
  source: NodeHandle;
  relation: string;
  cardinality: "many" | "maybe";
  narrowing: Narrowing;
  node: TraceNode;
}

interface NodePlace {
  root: string;
  path: string[];
}

type Mode = "trace" | "value";

interface Run {
  mode: Mode;
  schema: StoreSchema;
  user: ViewContext["user"];
  roots: Map<string, TraceRoot>;
  /** Results by root key, then by the key of the enclosing rows the root's facts bind. */
  results: Map<string, Map<string, unknown>>;
  places: Map<string, NodePlace>;
  misses: ReadPath[];
  /** Rows the value pass read, for annotating a data view's result. */
  seen: Map<object, TraceNode>;
  /** Objects built while reading a row (inside `.map` over rows). */
  built: WeakMap<object, { node: TraceNode; raw: Record<string, unknown> }>;
}

let active: Run | undefined;

function miss(path: ReadPath): void {
  active?.misses.push(path);
}

function rootNode(run: Run, key: string, relation: string): TraceNode {
  const scope = `r${hash(key)}`;
  run.places.set(scope, { root: key, path: [] });
  return { relation, scope, fields: new Set(), links: new Map() };
}

function ensureLink(run: Run, node: TraceNode, name: string, narrowing?: Narrowing): TraceLink {
  const key = linkKey(name, narrowing);
  let link = node.links.get(key);
  if (!link) {
    const metadata = relationshipOf(run.schema, node.relation, name);
    if (!metadata) throw new QueryCompileError(`${node.relation} has no relationship ${name}`);
    const place = run.places.get(node.scope)!;
    const scope = `n${hash(`${node.scope}/${key}`)}`;
    run.places.set(scope, { root: place.root, path: [...place.path, key] });
    link = {
      key,
      relationship: name,
      metadata,
      ...(narrowed(narrowing) ? { narrowing } : {}),
      node: { relation: metadata.target, scope, fields: new Set(), links: new Map() },
      rows: false,
      counted: false,
    };
    node.links.set(key, link);
  }
  return link;
}

function pathOf(run: Run, node: TraceNode): ReadPath {
  const place = run.places.get(node.scope)!;
  return [place.root, ...place.path];
}

// ---------------------------------------------------------------- stand-ins

interface RowInfo {
  /** The block's row variable, inside facts. */
  variable?: VarBase;
  /** A row of the plan (stand-in or result). */
  node?: TraceNode;
  raw?: Record<string, unknown>;
  /** A to-one row known only by its key, held in the parent row's columns. */
  keyOf?: { node: TraceNode; fields: string[]; raw?: Record<string, unknown>; target: string };
}

function rowInfo(value: unknown): RowInfo | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return (value as { [ROW]?: RowInfo })[ROW];
}

/** The key a row value names, as scoped fields, so a fact's key is the same in both passes. */
function rowIdentity(value: unknown): RowIdentity | undefined {
  const info = rowInfo(value);
  if (!info) return undefined;
  const schema = schemaOf();
  if (info.variable) {
    const key = schema.relations[info.variable.relation]!.primaryKey;
    return { relation: info.variable.relation, key: key.map((name) => field(info.variable!.relation, name, info.variable!.scope)) };
  }
  if (info.keyOf) {
    const owner = info.keyOf.node;
    for (const name of info.keyOf.fields) owner.fields.add(name);
    bindRow(owner, info.keyOf.raw);
    return { relation: info.keyOf.target, key: info.keyOf.fields.map((name) => field(owner.relation, name, owner.scope)) };
  }
  const node = info.node!;
  bindRow(node, info.raw);
  const key = schema.relations[node.relation]!.primaryKey;
  return { relation: node.relation, key: key.map((name) => field(node.relation, name, node.scope)) };
}

/** Facts compiled in the value pass remember the rows they bind, to find the right results. */
let binding: Map<string, Record<string, unknown>> | undefined;
function bindRow(node: TraceNode, raw: Record<string, unknown> | undefined): void {
  if (binding && raw) binding.set(node.scope, raw);
}

const STUB_TARGET = function stub() {};
const stubReads = new WeakMap<object, { node: TraceNode; field: string; raw?: Record<string, unknown> }>();

function stubRead(value: unknown): FieldExpression | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  const read = stubReads.get(value as object);
  if (!read) return undefined;
  bindRow(read.node, read.raw);
  return field(read.node.relation, read.field, read.node.scope);
}

/** An absorbing value: any read or call gives another stub. Stands in for a field's value. */
function stub(read?: { node: TraceNode; field: string }): any {
  const value = new Proxy(STUB_TARGET, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return (hint: string) => (hint === "number" ? 1 : "·");
      if (property === Symbol.iterator) return function* () {};
      if (property === "then" || property === "toJSON") return undefined;
      if (property === "length") return 1;
      return stub();
    },
    apply() { return stub(); },
  });
  if (read) stubReads.set(value, read);
  return value;
}

const ROW_CALLBACKS = new Set(["map", "flatMap", "forEach", "filter", "find", "findLast", "some", "every", "findIndex", "findLastIndex"]);

function traceRow(run: Run, node: TraceNode): any {
  return new Proxy({}, {
    get(_target, property) {
      if (property === ROW) return { node } satisfies RowInfo;
      if (typeof property !== "string") return property === Symbol.toPrimitive ? () => "·" : undefined;
      if (property === "then" || property === "toJSON") return undefined;
      const metadata = relationshipOf(run.schema, node.relation, property);
      if (metadata) {
        const link = ensureLink(run, node, property);
        if (metadata.cardinality === "many") return traceList(run, node, property, undefined);
        return toOneTrace(run, node, link);
      }
      if (hasField(run.schema, node.relation, property)) {
        node.fields.add(property);
        return stub({ node, field: property });
      }
      throw new QueryCompileError(`${node.relation} has no field or relationship ${property}`);
    },
    has(_target, property) {
      return typeof property === "string" && (hasField(run.schema, node.relation, property) || Boolean(relationshipOf(run.schema, node.relation, property)));
    },
  });
}

/** The foreign-key columns that hold a direct to-one's key, in the target's key order. */
function keyColumns(schema: StoreSchema, metadata: RelationshipMetadata): string[] | undefined {
  if (!metadata.direct) return undefined;
  const key = schema.relations[metadata.target]!.primaryKey;
  const pairs = key.map((name) => metadata.direct!.find((pair) => pair.target === name));
  if (pairs.some((pair) => !pair) || metadata.direct.length !== key.length) return undefined;
  return pairs.map((pair) => pair!.source);
}

/** A to-one stand-in. Its key comes from the parent's columns; anything else reads the row. */
function toOneTrace(run: Run, parent: TraceNode, link: TraceLink): any {
  const columns = keyColumns(run.schema, link.metadata);
  const key = run.schema.relations[link.metadata.target]!.primaryKey;
  if (!columns) {
    link.rows = true;
    return traceRow(run, link.node);
  }
  for (const column of columns) parent.fields.add(column);
  const row = () => { link.rows = true; return traceRow(run, link.node); };
  return new Proxy({}, {
    get(_target, property) {
      if (property === ROW) return { keyOf: { node: parent, fields: columns, target: link.metadata.target } } satisfies RowInfo;
      if (typeof property !== "string") return property === Symbol.toPrimitive ? () => "·" : undefined;
      if (property === "then" || property === "toJSON") return undefined;
      const index = key.indexOf(property);
      if (index >= 0) return stub({ node: parent, field: columns[index]! });
      return Reflect.get(row(), property);
    },
  });
}

function traceList(run: Run, parent: TraceNode, name: string, narrowing: Narrowing | undefined): any {
  const link = ensureLink(run, parent, name, narrowing);
  const row = () => { link.rows = true; return traceRow(run, link.node); };
  return listStandIn(link.metadata.target, row, () => { link.counted = true; }, (next) => traceList(run, parent, name, next), narrowing);
}

/** A list of stand-ins: one row, any callback runs once over it. */
function listStandIn(
  relation: string,
  row: () => any,
  count: () => void,
  renarrow: ((narrowing: Narrowing) => any) | undefined,
  narrowing: Narrowing | undefined,
): any {
  const self: any = new Proxy([], {
    get(_target, property) {
      // Two stand-ins, so a comparator sorting a copy (`[...rows].sort(by)`) runs and its reads join the plan.
      if (property === Symbol.iterator) return function* () { yield row(); yield row(); };
      if (property === "length") { count(); return 1; }
      if (typeof property !== "string") return undefined;
      if (renarrow) {
        if (property === "all") return (...args: unknown[]) => renarrow(merge(narrowing, { where: listFacts(relation, args) }));
        if (property === "orderBy") return (order: unknown) => renarrow(merge(narrowing, { orderBy: compileOrder(relation, order) }));
        if (property === "take") return (take: number) => renarrow(merge(narrowing, { take: checkedTake(take) }));
      }
      if (/^\d+$/.test(property)) return row();
      if (property === "at") return () => row();
      if (ROW_CALLBACKS.has(property)) return (callback: (row: any, index: number, array: unknown) => unknown) => {
        const value = callback(row(), 0, self);
        if (property === "filter") return self;
        if (property === "map" || property === "flatMap") return [value];
        if (property === "find" || property === "findLast") return row();
        if (property === "some" || property === "every") return Boolean(value);
        return property === "forEach" ? undefined : 0;
      };
      if (property === "sort" || property === "toSorted") return (compare?: (a: any, b: any) => number) => {
        compare?.(row(), row());
        return self;
      };
      if (property === "reduce") return (callback: (accumulator: any, row: any, index: number) => unknown, initial: unknown) => callback(initial ?? stub(), row(), 0);
      if (property === "slice" || property === "toReversed" || property === "reverse" || property === "concat") return () => self;
      if (property === "includes" || property === "indexOf") return () => { row(); return property === "includes" ? true : 0; };
      if (property === "join") return () => { row(); return "·"; };
      return stub();
    },
  });
  return self;
}

function merge(narrowing: Narrowing | undefined, parts: Partial<Narrowing>): Narrowing {
  const where = parts.where && narrowing?.where
    ? { kind: "logical" as const, id: id(), operator: "and" as const, operands: [narrowing.where, parts.where] }
    : parts.where ?? narrowing?.where;
  return {
    ...(where ? { where } : {}),
    orderBy: parts.orderBy ?? narrowing?.orderBy ?? [],
    ...(parts.take !== undefined ? { take: parts.take } : narrowing?.take !== undefined ? { take: narrowing.take } : {}),
  };
}

function checkedTake(take: number): number {
  if (!Number.isSafeInteger(take) || take < 1) throw new QueryCompileError("take() needs a positive whole number");
  return take;
}

/** Compile `(row, helpers) => facts` for rows of `relation`. Helper variables become joins. */
function listFacts(relation: string, args: unknown[]): PredicateExpression | undefined {
  const [first, second] = args;
  const helpers = typeof first === "function" ? {} : first as Record<string, unknown>;
  const body = (typeof first === "function" ? first : second) as (row: unknown, helpers: Record<string, unknown>) => Facts;
  if (typeof body !== "function") throw new QueryCompileError("all() and one() take facts: row => [facts]");
  const variables: Record<string, unknown> = {};
  const scopes: Array<{ scope: string; relation: string }> = [];
  for (const [name, source] of Object.entries(helpers ?? {})) {
    const helperRelation = sourceRelation(source);
    const scope = `$${name}`;
    scopes.push({ scope, relation: helperRelation });
    variables[name] = rowVar({ relation: helperRelation, scope });
  }
  const facts = flatten(body(rowVar({ relation, scope: "self" }), variables));
  let outside = facts;
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const { scope, relation: helperRelation } = scopes[index]!;
    const inside = outside.filter((predicate) => mentions(predicate, scope));
    outside = outside.filter((predicate) => !mentions(predicate, scope));
    const where = conjunction(inside);
    if (!where) throw new QueryCompileError(`The helper variable ${scope.slice(1)} appears in no fact`);
    outside.push({ kind: "some", id: id(), relation: helperRelation, scope, where });
  }
  return conjunction(outside);
}

function mentions(value: unknown, scope: string): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { scope?: unknown }).scope === scope) return true;
  return Object.values(value).some((child) => mentions(child, scope));
}

function sourceRelation(source: unknown): string {
  const relation = (source && (typeof source === "object" || typeof source === "function")) ? relationOfSource(source) : undefined;
  if (!relation) throw new QueryCompileError("A helper variable names a model source, as node(path).children");
  return relation;
}

function relationOfSource(source: unknown): string | undefined {
  try {
    return (source as { [key: symbol]: string })[Symbol.for("story.data.relation")];
  } catch {
    return undefined;
  }
}

function compileOrder(relation: string, order: unknown): OrderExpression[] {
  if (typeof order !== "function") throw new QueryCompileError("orderBy() takes row => order");
  const schema = schemaOf();
  const term = (value: ValueExpression, direction: "asc" | "desc"): OrderExpression => ({ kind: "order", id: id(), value, direction });
  const orderable = (value: ValueExpression) => {
    const result = { asc: () => term(value, "asc"), desc: () => term(value, "desc") };
    Object.defineProperty(result, ORDER, { value: term(value, "asc") });
    return result;
  };
  const row = new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      const metadata = relationshipOf(schema, relation, property);
      if (metadata) {
        if (metadata.cardinality !== "many") throw new QueryCompileError("orderBy() orders by a field or a count");
        return { count: () => orderable({ kind: "count", id: id(), relation, relationship: property } satisfies CountExpression) };
      }
      if (!hasField(schema, relation, property)) throw new QueryCompileError(`${relation} has no field ${property}`);
      return orderable(field(relation, property, undefined));
    },
  });
  const value = (order as (row: unknown) => unknown)(row);
  return (Array.isArray(value) ? value : [value]).map((candidate) => {
    if (candidate && typeof candidate === "object" && (candidate as OrderExpression).kind === "order") return candidate as OrderExpression;
    const asc = (candidate as { [ORDER]?: OrderExpression } | null)?.[ORDER];
    if (asc) return asc;
    throw new QueryCompileError("orderBy() returns fields, counts, or their asc()/desc()");
  });
}

// ---------------------------------------------------------------- results

/** The materialized form of a many relationship: an array, plus narrowing. */
class ResultList<Row> extends Array<Row> {
  static get [Symbol.species]() { return Array; }
}

function tagBuilt(run: Run, value: unknown, row: unknown): unknown {
  const info = rowInfo(row);
  if (info?.node && info.raw && value && typeof value === "object" && !run.built.has(value)) {
    run.built.set(value, { node: info.node, raw: info.raw });
  }
  return value;
}

function resultRow(run: Run, node: TraceNode, raw: Record<string, unknown>): any {
  run.seen.set(raw, node);
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === ROW) return { node, raw } satisfies RowInfo;
      if (typeof property !== "string" || property === "then" || property === "toJSON") return Reflect.get(target, property, receiver);
      const metadata = relationshipOf(run.schema, node.relation, property);
      if (metadata) {
        if (metadata.cardinality === "many") return resultList(run, node, raw, property, undefined);
        const key = linkKey(property);
        if (key in raw) {
          const value = raw[key] as Record<string, unknown> | null;
          return value === null ? null : resultRow(run, ensureLink(run, node, property).node, value);
        }
        const columns = keyColumns(run.schema, metadata);
        if (columns && columns.every((column) => column in raw)) {
          if (columns.every((column) => raw[column] === null || raw[column] === undefined)) return null;
          return keyRow(run, node, raw, property, columns);
        }
        const link = ensureLink(run, node, property);
        link.rows = true;
        miss([...pathOf(run, node), key]);
        return traceRow(run, link.node);
      }
      if (hasField(run.schema, node.relation, property)) {
        if (!(property in raw)) {
          node.fields.add(property);
          miss([...pathOf(run, node), property]);
          return stub({ node, field: property });
        }
        return raw[property];
      }
      return undefined;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => typeof key !== "string" || hasField(run.schema, node.relation, key));
    },
  });
}

/** A to-one row the plan knows only by key: its key fields answer, anything else widens. */
function keyRow(run: Run, parent: TraceNode, raw: Record<string, unknown>, name: string, columns: string[]): any {
  const link = ensureLink(run, parent, name);
  const key = run.schema.relations[link.metadata.target]!.primaryKey;
  const values = Object.fromEntries(key.map((field, index) => [field, raw[columns[index]!]]));
  return new Proxy(values, {
    get(target, property, receiver) {
      if (property === ROW) return { keyOf: { node: parent, fields: columns, raw, target: link.metadata.target } } satisfies RowInfo;
      if (typeof property !== "string" || property === "then" || property === "toJSON") return Reflect.get(target, property, receiver);
      if (property in values) return values[property];
      link.rows = true;
      miss([...pathOf(run, parent), link.key]);
      return Reflect.get(traceRow(run, link.node), property);
    },
  });
}

function resultList(run: Run, parent: TraceNode, raw: Record<string, unknown>, name: string, narrowing: Narrowing | undefined): any {
  const metadata = relationshipOf(run.schema, parent.relation, name)!;
  const key = linkKey(name, narrowing);
  const renarrow = (parts: Partial<Narrowing>) => resultList(run, parent, raw, name, merge(narrowing, parts));
  const extras = {
    all: (...args: unknown[]) => renarrow({ where: listFacts(metadata.target, args) }),
    orderBy: (order: unknown) => renarrow({ orderBy: compileOrder(metadata.target, order) }),
    take: (take: number) => renarrow({ take: checkedTake(take) }),
  };
  if (!(key in raw)) {
    // Only the count was planned: `.length` answers, anything else widens to rows.
    const count = `${key}${COUNT}`;
    const link = () => ensureLink(run, parent, name, narrowing);
    return new Proxy([], {
      get(_target, property) {
        if (property === "length" && count in raw) return raw[count];
        if (typeof property === "string" && property in extras) return extras[property as keyof typeof extras];
        if (property === "length") {
          link().counted = true;
          miss([...pathOf(run, parent), count]);
          return 1;
        }
        link().rows = true;
        miss([...pathOf(run, parent), key]);
        return Reflect.get(traceList(run, parent, name, narrowing), property);
      },
    });
  }
  const node = ensureLink(run, parent, name, narrowing).node;
  const rows = (raw[key] as Record<string, unknown>[]).map((row) => resultRow(run, node, row));
  return rowsList(run, rows, extras);
}

function rowsList(run: Run, rows: unknown[], extras: Record<string, unknown>): any {
  const list = ResultList.from(rows);
  Object.defineProperties(list, Object.fromEntries(Object.entries(extras).map(([name, value]) => [name, { value, enumerable: false }])));
  Object.defineProperty(list, "map", {
    enumerable: false,
    value(callback: (row: unknown, index: number, array: unknown) => unknown, thisArg?: unknown) {
      return Array.prototype.map.call(this, (row: unknown, index: number, array: unknown) => tagBuilt(run, callback.call(thisArg, row, index, array), row));
    },
  });
  return list;
}

// ---------------------------------------------------------------- roots: Model.all / Model.one

interface RootSpec {
  relation: string;
  source: NodeHandle;
  cardinality: "many" | "maybe";
  narrowing: Narrowing;
  /** Rows the facts named, by scope (value pass only). */
  bound: Map<string, Record<string, unknown>>;
}

function compileRootFacts(relation: string, args: unknown[]): { where?: PredicateExpression; bound: Map<string, Record<string, unknown>> } {
  const previous = binding;
  binding = new Map();
  try {
    const where = listFacts(relation, args);
    return { ...(where ? { where } : {}), bound: binding };
  } finally {
    binding = previous;
  }
}

registerSourceMethods((relation, source, name) => {
  const handle = (...args: unknown[]) => {
    const run = active;
    if (!run) throw new QueryCompileError(`${relation}.${name}() is read only inside a view`);
    const { where, bound } = compileRootFacts(relation, args);
    const spec: RootSpec = { relation, source, cardinality: name === "all" ? "many" : "maybe", narrowing: { ...(where ? { where } : {}), orderBy: [] }, bound };
    return name === "all" ? lazyRoot(spec) : readRoot(run, spec);
  };
  return handle;
});

/** `Model.all(…)` reads nothing until its rows are, so `.orderBy().take()` can still narrow it. */
function lazyRoot(spec: RootSpec): any {
  let resolved: any;
  const resolve = () => {
    if (!resolved) {
      if (!active) throw new QueryCompileError(`${spec.relation}.all() is read only inside a view`);
      resolved = readRoot(active, spec);
    }
    return resolved;
  };
  return new Proxy([], {
    get(_target, property) {
      if (property === "orderBy") return (order: unknown) => lazyRoot({ ...spec, narrowing: merge(spec.narrowing, { orderBy: compileOrder(spec.relation, order) }) });
      if (property === "take") return (take: number) => lazyRoot({ ...spec, narrowing: merge(spec.narrowing, { take: checkedTake(take) }) });
      if (property === "all") return (...args: unknown[]) => {
        const facts = compileRootFacts(spec.relation, args);
        return lazyRoot({ ...spec, narrowing: merge(spec.narrowing, { ...(facts.where ? { where: facts.where } : {}) }), bound: new Map([...spec.bound, ...facts.bound]) });
      };
      const value = resolve();
      const member = Reflect.get(value, property);
      return typeof member === "function" ? member.bind(value) : member;
    },
    has(_target, property) { return Reflect.has(resolve(), property); },
  });
}

function readRoot(run: Run, spec: RootSpec): any {
  const key = rootKey(spec.relation, spec.cardinality, spec.narrowing);
  let root = run.roots.get(key);
  let fresh = false;
  if (!root) {
    root = { key, source: spec.source, relation: spec.relation, cardinality: spec.cardinality, narrowing: spec.narrowing, node: rootNode(run, key, spec.relation) };
    run.roots.set(key, root);
    fresh = true;
  }
  const traced = () => spec.cardinality === "many"
    ? listStandIn(spec.relation, () => traceRow(run, root!.node), () => undefined, undefined, undefined)
    : traceRow(run, root!.node);
  if (run.mode === "trace") return traced();
  const results = run.results.get(key);
  const bindingKey = bindingKeyFor(spec);
  if (fresh || !results || bindingKey === undefined || !results.has(bindingKey)) {
    miss([key]);
    return traced();
  }
  const result = results.get(bindingKey);
  if (spec.cardinality === "many") {
    return rowsList(run, (result as Record<string, unknown>[]).map((row) => resultRow(run, root!.node, row)), {});
  }
  return result === null ? null : resultRow(run, root.node, result as Record<string, unknown>);
}

/** The key of the enclosing rows a root's facts bind, from the rows themselves. */
function bindingKeyFor(spec: RootSpec): string | undefined {
  const values: unknown[] = [];
  for (const read of boundReads(spec.narrowing.where, spec.narrowing.orderBy)) {
    const row = spec.bound.get(read.scope);
    if (!row || !(read.field in row)) return undefined;
    values.push(row[read.field] ?? null);
  }
  return JSON.stringify(values);
}

/** Fields of enclosing rows (scoped to plan nodes) that predicates read. */
function boundReads(where: PredicateExpression | undefined, orderBy: OrderExpression[] = []): Array<{ scope: string; field: string }> {
  const reads = new Map<string, { scope: string; field: string }>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { kind?: string; scope?: string; field?: string };
    if (node.kind === "field" && node.scope && /^[rn]/.test(node.scope)) reads.set(`${node.scope}\0${node.field}`, { scope: node.scope, field: node.field! });
    Object.values(value).forEach(visit);
  };
  visit(where);
  visit(orderBy);
  return [...reads.values()].sort((left, right) => `${left.scope}\0${left.field}`.localeCompare(`${right.scope}\0${right.field}`));
}

// ---------------------------------------------------------------- planning

function withRules(run: Run, rules: ReadRules | undefined, relation: string, scope: string | undefined, predicate: PredicateExpression | undefined): PredicateExpression | undefined {
  const inner = predicate ? applyRules(run, rules, predicate) : undefined;
  const rule = ruleFor(run, rules, relation, scope);
  if (!rule) return inner;
  return inner ? { kind: "logical", id: id(), operator: "and", operands: [rule, inner] } : rule;
}

function ruleFor(run: Run, rules: ReadRules | undefined, relation: string, scope: string | undefined): PredicateExpression | undefined {
  const rule = rules?.[relation];
  if (!rule) return undefined;
  return conjunction(flatten(rule(rowVar({ relation, scope }), { user: run.user })));
}

/** Add read rules inside every join a predicate makes, so facts can't probe hidden rows. */
function applyRules(run: Run, rules: ReadRules | undefined, predicate: PredicateExpression): PredicateExpression {
  if (!rules) return predicate;
  switch (predicate.kind) {
    case "logical":
      return { ...predicate, operands: predicate.operands.map((operand) => applyRules(run, rules, operand)) };
    case "not":
      return { ...predicate, operand: applyRules(run, rules, predicate.operand) };
    case "some": {
      const where = withRules(run, rules, predicate.relation, predicate.scope, predicate.where)!;
      return { ...predicate, where };
    }
    case "exists": {
      const target = run.schema.relationships[`${predicate.relation}.${predicate.relationship}`]?.target;
      const where = target ? withRules(run, rules, target, undefined, predicate.where) : predicate.where;
      return { ...predicate, ...(where ? { where } : {}) };
    }
    default:
      return predicate;
  }
}

function selectFor(run: Run, rules: ReadRules | undefined, node: TraceNode): Selection {
  const select: Selection = {};
  const relation = run.schema.relations[node.relation]!;
  for (const name of [...relation.primaryKey, ...node.fields]) select[name] = field(node.relation, name, undefined);
  for (const [key, link] of node.links) {
    const narrowing = link.narrowing;
    if (link.rows) {
      const target = link.metadata.target;
      const plan: SelectionPlan = {
        scope: link.node.scope,
        ...whereOf(withRules(run, rules, target, "self", narrowing?.where)),
        orderBy: narrowing?.orderBy ?? [],
        ...(narrowing?.take !== undefined ? { take: narrowing.take } : {}),
        select: selectFor(run, rules, link.node),
      };
      select[key] = { kind: "relationship", id: id(), relation: node.relation, relationship: link.relationship, plan } satisfies RelationshipSelection;
    } else if (link.counted) {
      if (narrowing?.take !== undefined) throw new QueryCompileError(`Count ${node.relation}.${link.relationship} after take(): read the rows`);
      const where = withRules(run, rules, link.metadata.target, "self", narrowing?.where);
      select[`${key}${COUNT}`] = { kind: "count", id: id(), relation: node.relation, relationship: link.relationship, ...(where ? { where } : {}) } satisfies CountExpression;
    }
  }
  return select;
}

function whereOf(where: PredicateExpression | undefined): { where?: PredicateExpression } {
  return where ? { where } : {};
}

function planRoot(run: Run, rules: ReadRules | undefined, root: TraceRoot): QueryHandle<unknown, unknown> {
  const plan: QueryPlan = {
    relation: root.relation,
    cardinality: root.cardinality,
    scope: root.node.scope,
    ...whereOf(withRules(run, rules, root.relation, "self", root.narrowing.where)),
    orderBy: root.narrowing.orderBy.map((order) => applyOrderRules(run, rules, root.relation, order)),
    ...(root.narrowing.take !== undefined ? { take: root.narrowing.take } : {}),
    select: selectFor(run, rules, root.node),
  };
  return Object.freeze({ kind: "query" as const, source: root.source, plan });
}

function applyOrderRules(run: Run, rules: ReadRules | undefined, relation: string, order: OrderExpression): OrderExpression {
  if (order.value.kind !== "count") return order;
  const target = run.schema.relationships[`${relation}.${order.value.relationship}`]!.target;
  const where = withRules(run, rules, target, "self", order.value.where);
  return where ? { ...order, value: { ...order.value, where } } : order;
}

/** Every field of a row from outside a plan's own tree that the plan reads. */
function externalReads(plan: SelectionPlan): Array<{ scope: string; field: string }> {
  const own = new Set<string>();
  const collect = (value: SelectionPlan) => {
    if (value.scope) own.add(value.scope);
    for (const selected of Object.values(value.select)) if (selected.kind === "relationship") collect(selected.plan);
  };
  collect(plan);
  const reads = new Map<string, { scope: string; field: string }>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { kind?: string; scope?: string; field?: string };
    if (node.kind === "field" && node.scope && /^[rn]/.test(node.scope) && !own.has(node.scope)) reads.set(`${node.scope}\0${node.field}`, { scope: node.scope, field: node.field! });
    Object.values(value).forEach(visit);
  };
  visit(plan);
  return [...reads.values()].sort((left, right) => `${left.scope}\0${left.field}`.localeCompare(`${right.scope}\0${right.field}`));
}

/** Rows of a plan node, found in already-executed results. */
function instancesOf(run: Run, scope: string): Record<string, unknown>[] | undefined {
  const place = run.places.get(scope);
  if (!place) return undefined;
  const results = run.results.get(place.root);
  if (!results) return undefined;
  let rows: Record<string, unknown>[] = [];
  for (const result of results.values()) {
    if (Array.isArray(result)) rows.push(...result as Record<string, unknown>[]);
    else if (result) rows.push(result as Record<string, unknown>);
  }
  for (const key of place.path) {
    rows = rows.flatMap((row) => {
      const value = row[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
      return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
    });
  }
  return rows;
}

// ---------------------------------------------------------------- running

export interface ViewRunOptions<Input> {
  engine: SQLiteQueryEngine;
  /** Resolve a source's node() path, as the host's activation does. */
  resolve: (source: NodeHandle) => Promise<ResolvedStorySource>;
  input?: Input;
  user?: ViewContext["user"];
  /** The host's read rules, by model. */
  readRules?: ReadRules;
  /** Reads a client's run of a `rows` answer missed. */
  missed?: ReadPath[];
  /** Run the value pass here (`value`, `tree`) or leave it to the client (`rows`). */
  form?: "value" | "rows" | "tree";
  /** Model paths for row identity, by relation (defaults to the relation's name). */
  modelPaths?: Record<string, string>;
  maxWidenings?: number;
}

/** A `rows` answer: the plan's results, for a client that runs the view itself. */
export interface RowsAnswer {
  schema: Pick<StoreSchema, "relations" | "relationships" | "fingerprint">;
  roots: Array<{ key: string; results: Array<[binding: string, result: unknown]> }>;
}

export interface ViewRun<Output> {
  form: "value" | "rows" | "tree";
  /** The value (`value`, `tree`), or the rows (`rows`). */
  output: Output | RowsAnswer;
  shape?: ResultShape;
  /** One plan per root and binding, as the host ran them. */
  plans: QueryHandle<unknown, unknown>[];
  /** Reads the plan pass missed, each of which widened the plan. */
  widened: ReadPath[];
  reruns: number;
  statements: number;
  /** What the answer depends on, merged across plans. */
  executions: Array<Awaited<ReturnType<SQLiteQueryEngine["execute"]>>>;
}

function newRun(schema: StoreSchema, user: ViewContext["user"]): Run {
  return { mode: "trace", schema, user, roots: new Map(), results: new Map(), places: new Map(), misses: [], seen: new Map(), built: new WeakMap() };
}

function within<T>(run: Run, work: () => T): T {
  const previous = active;
  active = run;
  try { return work(); } finally { active = previous; }
}

async function checkedInput<Input>(handle: View<Input, unknown>, input: unknown): Promise<Input> {
  if (!handle.schema) {
    if (input !== undefined && input !== null) throw new QueryInputError([{ message: "This view does not accept input" }]);
    return undefined as Input;
  }
  return await validateQueryInput(handle.schema, input) as Input;
}

export async function runView<Input, Output>(handle: View<Input, Output>, options: ViewRunOptions<Input>): Promise<ViewRun<Output>> {
  const schema = options.engine.schema;
  const user = options.user ?? null;
  const input = await checkedInput(handle, options.input);
  const form = options.form ?? "value";
  const run = newRun(schema, user);

  try {
    within(run, () => handle.body(input, { user }));
  } catch {
    // Code that can't run over stand-ins (JSON.parse of a field, say) ends the plan pass
    // early. Whatever it missed widens in the value pass.
  }
  if (options.missed?.length) within(run, () => widenWith(run, options.missed!));

  const widened: ReadPath[] = [];
  let statements = 0;
  for (let attempt = 0; ; attempt += 1) {
    const plans: QueryHandle<unknown, unknown>[] = [];
    const executions: ViewRun<Output>["executions"] = [];
    run.results.clear();
    statements += await executeRoots(run, options, plans, executions);
    // A `rows` answer is settled here too: the host runs the value pass with the client's
    // input and user, so the client only widens for its own state.
    run.mode = "value";
    run.misses = [];
    run.seen = new Map();
    run.built = new WeakMap();
    let output: Output;
    try {
      output = within(run, () => handle.body(input, { user }));
    } catch (error) {
      // Real code over a stand-in can throw. With misses recorded, widen and rerun.
      if (run.misses.length === 0) throw error;
      output = undefined as Output;
    }
    if (run.misses.length === 0 && form === "rows") {
      const answer = rowsAnswer(run);
      return { form, output: answer, shape: rowsShape(run, answer, options.modelPaths), plans, widened, reruns: attempt, statements, executions };
    }
    if (run.misses.length === 0) {
      const shape = form === "value" ? annotate(run, output, options.modelPaths) : undefined;
      return { form, output, ...(shape ? { shape } : {}), plans, widened, reruns: attempt, statements, executions };
    }
    widened.push(...run.misses);
    run.mode = "trace";
    if (attempt >= (options.maxWidenings ?? 4)) throw new QueryCompileError(`View did not settle after ${attempt + 1} widenings`);
  }
}

async function executeRoots(
  run: Run,
  options: ViewRunOptions<unknown>,
  plans: QueryHandle<unknown, unknown>[],
  executions: ViewRun<unknown>["executions"],
): Promise<number> {
  let statements = 0;
  const pending = new Map(run.roots);
  while (pending.size) {
    let progressed = false;
    for (const [key, root] of pending) {
      const plan = within(run, () => planRoot(run, options.readRules, root));
      const reads = externalReads(plan.plan);
      const own = new Set(boundReads(root.narrowing.where, root.narrowing.orderBy).map((read) => `${read.scope}\0${read.field}`));
      if (reads.some((read) => { const place = run.places.get(read.scope); return place && pending.has(place.root); })) continue;
      // Bindings: each distinct combination of the rows the root's own facts name, plus any
      // other enclosing row the plan reads, which must be single.
      const combinations: Array<{ key: string; bindings: Record<string, Record<string, unknown>> }> = [];
      const byScope = new Map<string, string[]>();
      for (const read of reads) byScope.set(read.scope, [...(byScope.get(read.scope) ?? []), read.field]);
      let options_: Array<Record<string, Record<string, unknown>>> = [{}];
      for (const [scope, fields] of byScope) {
        const instances = instancesOf(run, scope);
        if (!instances) throw new QueryCompileError("A view's facts name a row from outside the plan");
        const distinct = new Map<string, Record<string, unknown>>();
        for (const row of instances) distinct.set(JSON.stringify(fields.map((name) => row[name] ?? null)), row);
        const isOwn = fields.some((name) => own.has(`${scope}\0${name}`));
        if (!isOwn && distinct.size > 1) throw new QueryCompileError("A nested read names a row of another root that has several rows; name it in the root's facts");
        options_ = options_.flatMap((bindings) => [...distinct.values()].map((row) => ({ ...bindings, [scope]: row })));
      }
      for (const bindings of options_) {
        const values = boundReads(root.narrowing.where, root.narrowing.orderBy).map((read) => bindings[read.scope]?.[read.field] ?? null);
        combinations.push({ key: JSON.stringify(values), bindings });
      }
      const results = new Map<string, unknown>();
      for (const combination of combinations) {
        if (results.has(combination.key)) continue;
        options.engine.bind(plan, await options.resolve(root.source));
        const execution = await options.engine.execute(plan, { user: run.user, bindings: combination.bindings });
        statements += execution.statements.length;
        executions.push(execution);
        results.set(combination.key, execution.result);
      }
      run.results.set(key, results);
      plans.push(plan);
      pending.delete(key);
      progressed = true;
    }
    if (!progressed) throw new QueryCompileError("A view's roots name each other's rows in a cycle");
  }
  return statements;
}

/** Add reads a client missed. Each path is bounded by read rules and the caller's authority. */
function widenWith(run: Run, paths: ReadPath[]): void {
  for (const path of paths) {
    if (!Array.isArray(path) || path.length === 0 || path.some((part) => typeof part !== "string")) throw new QueryInputError([{ message: "A missed read is a path of strings" }]);
    const [key, ...rest] = path;
    let root = run.roots.get(key!);
    if (!root) {
      const parsed = parseRootKey(run, key!);
      root = { key: key!, ...parsed, node: rootNode(run, key!, parsed.relation) };
      run.roots.set(key!, root);
    }
    let node = root.node;
    rest.forEach((part, index) => {
      const last = index === rest.length - 1;
      if (last && hasField(run.schema, node.relation, part)) { node.fields.add(part); return; }
      const counted = part.endsWith(COUNT);
      const linkPart = counted ? part.slice(0, -COUNT.length) : part;
      const tilde = linkPart.indexOf("~");
      if (tilde < 0) throw new QueryInputError([{ message: `${node.relation} has no field ${linkPart}` }]);
      const name = linkPart.slice(0, tilde);
      const narrowing = tilde === linkPart.length - 1 ? undefined : parseNarrowing(run, linkPart.slice(tilde + 1));
      if (!relationshipOf(run.schema, node.relation, name)) throw new QueryInputError([{ message: `${node.relation} has no field or relationship ${name}` }]);
      const link = ensureLink(run, node, name, narrowing);
      if (counted && last) link.counted = true;
      else link.rows = true;
      node = link.node;
    });
  }
}

/** A root a client names must read a model the view's own plan reads, through the same source. */
function parseRootKey(run: Run, key: string): Omit<TraceRoot, "key" | "node"> {
  const [relation, cardinality, ...rest] = key.split("|");
  const source = [...run.roots.values()].find((root) => root.relation === relation)?.source;
  if (!relation || !source || (cardinality !== "many" && cardinality !== "maybe")) throw new QueryInputError([{ message: "A missed read names an unknown root" }]);
  return { source, relation, cardinality, narrowing: parseNarrowing(run, rest.join("|")) };
}

function parseNarrowing(run: Run, text: string): Narrowing {
  let value: { where?: unknown; orderBy?: unknown; take?: unknown };
  try { value = JSON.parse(text); } catch { throw new QueryInputError([{ message: "A missed read has a malformed narrowing" }]); }
  const narrowing: Narrowing = { orderBy: [] };
  if (value.where !== undefined) narrowing.where = parsePredicate(value.where);
  if (value.orderBy !== undefined) {
    if (!Array.isArray(value.orderBy)) throw new QueryInputError([{ message: "A missed read has a malformed order" }]);
    narrowing.orderBy = value.orderBy.map((order) => {
      const candidate = order as { kind?: unknown; direction?: unknown; value?: unknown };
      if (candidate.kind !== "order" || (candidate.direction !== "asc" && candidate.direction !== "desc")) throw new QueryInputError([{ message: "A missed read has a malformed order" }]);
      return { kind: "order", id: id(), direction: candidate.direction, value: parseValue(candidate.value) };
    });
  }
  if (value.take !== undefined) narrowing.take = checkedTake(Number(value.take));
  void run;
  return narrowing;
}

function parseValue(value: unknown): ValueExpression {
  const candidate = value as Record<string, unknown> | null;
  const bad = () => new QueryInputError([{ message: "A missed read has a malformed value" }]);
  if (!candidate || typeof candidate !== "object") throw bad();
  switch (candidate.kind) {
    case "field":
      if (typeof candidate.relation !== "string" || typeof candidate.field !== "string" || (candidate.scope !== undefined && typeof candidate.scope !== "string")) throw bad();
      return field(candidate.relation, candidate.field, candidate.scope as string | undefined);
    case "literal":
      if (candidate.value !== null && !["string", "number", "boolean"].includes(typeof candidate.value)) throw bad();
      return literal(candidate.value);
    case "count":
      if (typeof candidate.relation !== "string" || typeof candidate.relationship !== "string") throw bad();
      return { kind: "count", id: id(), relation: candidate.relation, relationship: candidate.relationship, ...(candidate.where !== undefined ? { where: parsePredicate(candidate.where) } : {}) };
    default:
      throw bad();
  }
}

function parsePredicate(value: unknown): PredicateExpression {
  const candidate = value as Record<string, unknown> | null;
  const bad = () => new QueryInputError([{ message: "A missed read has a malformed fact" }]);
  if (!candidate || typeof candidate !== "object") throw bad();
  switch (candidate.kind) {
    case "comparison":
      if (candidate.operator !== "eq" && candidate.operator !== "contains") throw bad();
      return { kind: "comparison", id: id(), operator: candidate.operator, left: parseValue(candidate.left), right: parseValue(candidate.right) };
    case "logical":
      if ((candidate.operator !== "and" && candidate.operator !== "or") || !Array.isArray(candidate.operands) || candidate.operands.length === 0) throw bad();
      return { kind: "logical", id: id(), operator: candidate.operator, operands: candidate.operands.map(parsePredicate) };
    case "not":
      return { kind: "not", id: id(), operand: parsePredicate(candidate.operand) };
    case "some":
      if (typeof candidate.relation !== "string" || typeof candidate.scope !== "string" || !candidate.scope.startsWith("$")) throw bad();
      return { kind: "some", id: id(), relation: candidate.relation, scope: candidate.scope, where: parsePredicate(candidate.where) };
    case "exists":
      if (typeof candidate.relation !== "string" || typeof candidate.relationship !== "string" || (candidate.scope !== undefined && typeof candidate.scope !== "string")) throw bad();
      if (candidate.keys !== undefined && !Array.isArray(candidate.keys)) throw bad();
      return {
        kind: "exists", id: id(), relation: candidate.relation, relationship: candidate.relationship,
        ...(candidate.scope !== undefined ? { scope: candidate.scope as string } : {}),
        ...(candidate.where !== undefined ? { where: parsePredicate(candidate.where) } : {}),
        ...(candidate.keys !== undefined ? { keys: (candidate.keys as unknown[]).map(parseValue) } : {}),
      } as PredicateExpression;
    default:
      throw bad();
  }
}

// ---------------------------------------------------------------- the client's value pass

export interface RowsRun<Output> {
  output: Output;
  /** Reads the rows lacked. Send them as `missed` to widen the plan. */
  missed: ReadPath[];
}

/** Run a JSX view over a `rows` answer, as a client does. */
export async function runViewOverRows<Input, Output>(
  handle: View<Input, Output>,
  options: { input?: Input; user?: ViewContext["user"]; rows: RowsAnswer },
): Promise<RowsRun<Output>> {
  const input = await checkedInput(handle, options.input);
  const schema = { version: 1, ...options.rows.schema } as StoreSchema;
  const run = newRun(schema, options.user ?? null);
  for (const root of options.rows.roots) {
    const [relation, cardinality] = root.key.split("|");
    run.roots.set(root.key, {
      key: root.key,
      source: { path: `(${relation})` } as NodeHandle,
      relation: relation!,
      cardinality: cardinality as "many" | "maybe",
      narrowing: { orderBy: [] },
      node: rootNode(run, root.key, relation!),
    });
    run.results.set(root.key, new Map(root.results));
  }
  run.mode = "value";
  let output: Output;
  try {
    output = within(run, () => handle.body(input, { user: options.user ?? null }));
  } catch (error) {
    if (run.misses.length === 0) throw error;
    output = undefined as Output;
  }
  return { output, missed: dedupe(expandMisses(run, run.misses)) };
}

/**
 * A miss at a link or a root carries on over stand-ins, which record what the view read
 * beneath it. Send those reads too, so one widening is enough.
 */
function expandMisses(run: Run, misses: ReadPath[]): ReadPath[] {
  const result: ReadPath[] = [];
  const below = (node: TraceNode, path: ReadPath) => {
    for (const name of node.fields) result.push([...path, name]);
    for (const [key, link] of node.links) {
      if (link.rows) { result.push([...path, key]); below(link.node, [...path, key]); }
      else if (link.counted) result.push([...path, `${key}${COUNT}`]);
    }
  };
  for (const path of misses) {
    result.push(path);
    const root = run.roots.get(path[0]!);
    let node: TraceNode | undefined = root?.node;
    for (const part of path.slice(1)) node = node?.links.get(part)?.node;
    if (node) below(node, path);
  }
  return result;
}

function dedupe(paths: ReadPath[]): ReadPath[] {
  return [...new Map(paths.map((path) => [JSON.stringify(path), path])).values()];
}

function rowsAnswer(run: Run): RowsAnswer {
  return {
    schema: { relations: run.schema.relations, relationships: run.schema.relationships, fingerprint: run.schema.fingerprint },
    roots: [...run.results].map(([key, results]) => ({ key, results: [...results] })),
  };
}

// ---------------------------------------------------------------- result shapes

function rowKey(schema: StoreSchema, relation: string, raw: Record<string, unknown>): string {
  const key = schema.relations[relation]!.primaryKey.map((name) => raw[name]);
  return key.length === 1 ? String(key[0]) : JSON.stringify(key);
}

function fieldType(schema: StoreSchema, relation: string, name: string): string | undefined {
  return schema.fieldTypes?.[relation]?.[name] ?? schema.relations[relation]?.fields[name]?.declaredType;
}

/** Field types and row identity for a `rows` answer: exact, from the plan. */
function rowsShape(run: Run, answer: RowsAnswer, modelPaths?: Record<string, string>): ResultShape {
  const shapeRow = (node: TraceNode, raw: Record<string, unknown>): ResultShape => {
    const fields: Record<string, ResultShape> = {};
    for (const [name, value] of Object.entries(raw)) {
      const link = node.links.get(name);
      if (link) {
        if (Array.isArray(value)) fields[name] = { items: value.map((child) => shapeRow(link.node, child as Record<string, unknown>)) };
        else if (value && typeof value === "object") fields[name] = shapeRow(link.node, value as Record<string, unknown>);
        continue;
      }
      if (name.endsWith(COUNT)) continue;
      const type = fieldType(run.schema, node.relation, name);
      if (type) fields[name] = { type };
    }
    return { row: { model: modelPaths?.[node.relation] ?? node.relation, key: rowKey(run.schema, node.relation, raw) }, fields };
  };
  const shapeResult = (node: TraceNode, result: unknown): ResultShape => Array.isArray(result)
    ? { items: result.map((row) => shapeRow(node, row as Record<string, unknown>)) }
    : result && typeof result === "object" ? shapeRow(node, result as Record<string, unknown>) : {};
  return {
    fields: {
      roots: {
        items: answer.roots.map((root) => {
          const node = run.roots.get(root.key)!.node;
          return { fields: { results: { items: root.results.map(([, result]) => ({ items: [{}, shapeResult(node, result)] })) } } };
        }),
      },
    },
  };
}

/**
 * Field types and row identity for a data view's JSON. An object built inside `.map` over
 * rows, or holding a row's key under the key's name, carries that row's identity. A value
 * equal to a field of its object's row, under that field's name, carries the field's type.
 */
function annotate(run: Run, output: unknown, modelPaths?: Record<string, string>): ResultShape | undefined {
  const byKey = new Map<string, Array<{ node: TraceNode; raw: Record<string, unknown> }>>();
  for (const [raw, node] of run.seen) {
    const key = run.schema.relations[node.relation]!.primaryKey;
    if (key.length !== 1) continue;
    const value = (raw as Record<string, unknown>)[key[0]!];
    const list = byKey.get(`${key[0]}\0${String(value)}`) ?? [];
    list.push({ node, raw: raw as Record<string, unknown> });
    byKey.set(`${key[0]}\0${String(value)}`, list);
  }
  // A value equal to some read row's field of the same name, when every such field has one type.
  const typesByValue = new Map<string, string | undefined>();
  for (const [raw, node] of run.seen) {
    for (const [name, value] of Object.entries(raw)) {
      if (value === null || typeof value === "object" || !hasField(run.schema, node.relation, name)) continue;
      const key = `${name}\0${typeof value}\0${String(value)}`;
      const type = fieldType(run.schema, node.relation, name);
      typesByValue.set(key, typesByValue.has(key) && typesByValue.get(key) !== type ? undefined : type);
    }
  }
  const rowOf = (value: Record<string, unknown>): { node: TraceNode; raw: Record<string, unknown> } | undefined => {
    const built = run.built.get(value);
    if (built) return built;
    for (const [name, member] of Object.entries(value)) {
      if (typeof member !== "string" && typeof member !== "number") continue;
      const candidates = byKey.get(`${name}\0${String(member)}`);
      if (candidates?.length) return candidates[0];
    }
    return undefined;
  };
  const visit = (value: unknown): ResultShape | undefined => {
    if (Array.isArray(value)) {
      const items = value.map((item) => visit(item) ?? {});
      return items.some((item) => Object.keys(item).length) ? { items } : undefined;
    }
    if (!value || typeof value !== "object") return undefined;
    const row = rowOf(value as Record<string, unknown>);
    const fields: Record<string, ResultShape> = {};
    for (const [name, member] of Object.entries(value)) {
      const nested = visit(member);
      if (nested) { fields[name] = nested; continue; }
      if (member === null || typeof member === "object") continue;
      if (row && name in row.raw && row.raw[name] === member) {
        const type = fieldType(run.schema, row.node.relation, name);
        if (type) fields[name] = { type };
      } else {
        const type = typesByValue.get(`${name}\0${typeof member}\0${String(member)}`);
        if (type) fields[name] = { type };
      }
    }
    const shape: ResultShape = {
      ...(row ? { row: { model: modelPaths?.[row.node.relation] ?? row.node.relation, key: rowKey(run.schema, row.node.relation, row.raw) } } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    };
    return Object.keys(shape).length ? shape : undefined;
  };
  return visit(output);
}

export const __testing = { canonical, rootKey, linkKey };
