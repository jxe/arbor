// SPIKE (Apps widgets thread, 2026-11-05): endpoints that are queries and views at once.
//
// An endpoint body is ordinary JavaScript over rows. The host learns the body's
// *shape* by running it once over tracing proxies: `.map` over a relationship is a
// nested selection, a property read is a field, `.length` alone is a count, and
// `.where`/`.orderBy`/`.take` narrow on the host. Everything else (values, ternaries,
// `.filter`, `.sort`, string methods) runs later over the results. A read the trace
// did not see (a branch it did not take) widens the plan and runs again.
//
// Not wired into the host or Story. See tests/integration/endpoint-spike.test.ts.

import {
  dataNode,
  query,
  symbolicRow,
  relationNameOf,
  type NodeSetHandle,
  type QueryCardinality,
  type QueryHandle,
  type StandardSchemaV1,
} from "./authoring.ts";
import type { ResolvedStorySource, StoreSchema, RelationshipMetadata } from "./schema.ts";
import type { SQLiteQueryEngine } from "./sqlite.ts";

// ---------------------------------------------------------------- trace model

interface Narrowing {
  where?: (row: any) => unknown;
  orderBy?: (row: any) => unknown;
  take?: number;
  /** Stable identity of the narrowing, from its symbolic form. */
  key: string;
}

interface TraceNode {
  relation: string;
  fields: Set<string>;
  links: Map<string, TraceLink>;
}

interface TraceLink {
  relationship: string;
  metadata: RelationshipMetadata;
  narrowing?: Narrowing;
  node: TraceNode;
  /** The rows themselves are read (mapped, iterated, indexed). */
  rows: boolean;
  /** `.length` is read. */
  counted: boolean;
}

interface TraceRoot {
  table: Table;
  cardinality: QueryCardinality;
  narrowing: Narrowing;
  node: TraceNode;
}

interface Run {
  mode: "trace" | "real";
  schema: StoreSchema;
  roots: Map<string, TraceRoot>;
  results: Map<string, unknown>;
  user: { profile: string } | null;
  /** Reads the plan did not cover in this run; the run carries on over trace stand-ins. */
  misses: string[];
}

let active: Run | undefined;

/** Record a read the plan missed. The run continues over tracing stand-ins from here, so
 * one rerun picks up every read in the missed subtree, not one read per rerun. */
function miss(at: string): void {
  active?.misses.push(at);
}

function newNode(relation: string): TraceNode {
  return { relation, fields: new Set(), links: new Map() };
}

function stripIds(_key: string, value: unknown) {
  return _key === "id" && typeof value === "number" ? undefined : value;
}

function narrowingKey(relation: string, parts: { where?: (row: any) => unknown; orderBy?: (row: any) => unknown; take?: number }): string {
  // Member proxies are functions, which JSON drops; read their plan nodes instead.
  const plain = (value: unknown): unknown => Array.isArray(value) ? value.map(plain) : dataNode(value) ?? value;
  const symbolic = {
    where: plain(parts.where?.(symbolicRow(relation))),
    orderBy: plain(parts.orderBy?.(symbolicRow(relation))),
    take: parts.take,
  };
  return JSON.stringify(symbolic, stripIds);
}

function linkKey(relationship: string, narrowing?: Narrowing): string {
  return narrowing ? `${relationship}~${hash(narrowing.key)}` : relationship;
}

function countKey(relationship: string, narrowing?: Narrowing): string {
  return `${linkKey(relationship, narrowing)}#count`;
}

function hash(text: string): string {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(36);
}

function relationshipOf(schema: StoreSchema, relation: string, name: string): RelationshipMetadata | undefined {
  return schema.relationships[`${relation}.${name}`];
}

function ensureLink(schema: StoreSchema, node: TraceNode, name: string, narrowing?: Narrowing): TraceLink {
  const key = linkKey(name, narrowing);
  let link = node.links.get(key);
  if (!link) {
    const metadata = relationshipOf(schema, node.relation, name)!;
    link = { relationship: name, metadata, narrowing, node: newNode(metadata.target), rows: false, counted: false };
    node.links.set(key, link);
  }
  return link;
}

// ---------------------------------------------------------------- tracing proxies

const STUB_TARGET = function stub() {};

/** An absorbing value: any read or call gives another stub. Stands in for scalars. */
function stub(): any {
  return new Proxy(STUB_TARGET, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return (hint: string) => (hint === "number" ? 1 : "·");
      if (property === Symbol.iterator) return function* () {};
      if (property === "then") return undefined;
      if (property === "length") return 1;
      return stub();
    },
    apply() { return stub(); },
  });
}

function traceRow(schema: StoreSchema, node: TraceNode): any {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") {
        if (property === Symbol.toPrimitive) return () => "·";
        return undefined;
      }
      if (property === "then" || property === "toJSON") return undefined;
      const metadata = relationshipOf(schema, node.relation, property);
      if (metadata) {
        const link = ensureLink(schema, node, property);
        if (metadata.cardinality === "many") return traceList(schema, node, property, link);
        link.rows = true;
        return traceRow(schema, link.node);
      }
      if (schema.relations[node.relation]?.fields[property]) {
        node.fields.add(property);
        return stub();
      }
      throw new Error(`${node.relation} has no field or relationship ${property}`);
    },
  });
}

const ROW_CALLBACKS = new Set(["map", "flatMap", "forEach", "filter", "find", "findLast", "some", "every", "findIndex", "findLastIndex"]);

function traceList(schema: StoreSchema, parent: TraceNode, name: string, link: TraceLink): any {
  const target = link.metadata.target;
  const row = () => { link.rows = true; return traceRow(schema, link.node); };
  const narrowed = (parts: Omit<Narrowing, "key">) => {
    const merged = { ...link.narrowing, ...parts };
    const narrowing = { ...merged, key: narrowingKey(target, merged) };
    return traceList(schema, parent, name, ensureLink(schema, parent, name, narrowing));
  };
  return new Proxy([], {
    get(_target, property) {
      if (property === Symbol.iterator) return function* () { yield row(); };
      if (property === "length") { link.counted = true; return 1; }
      if (property === "where") return (where: Narrowing["where"]) => narrowed({ where });
      if (property === "orderBy") return (orderBy: Narrowing["orderBy"]) => narrowed({ orderBy });
      if (property === "take") return (take: number) => narrowed({ take });
      if (typeof property !== "string") return undefined;
      if (/^\d+$/.test(property) || property === "at") return property === "at" ? () => row() : row();
      if (ROW_CALLBACKS.has(property)) return (callback: (row: any, index: number) => unknown) => {
        const value = callback(row(), 0);
        return property === "filter" ? traceList(schema, parent, name, link) : property === "map" || property === "flatMap" ? [value] : stub();
      };
      if (property === "sort" || property === "toSorted") return (compare?: (a: any, b: any) => number) => {
        compare?.(row(), row());
        return traceList(schema, parent, name, link);
      };
      if (property === "reduce") return (callback: (acc: any, row: any) => unknown, initial: unknown) => callback(initial ?? stub(), row());
      if (property === "slice" || property === "toReversed" || property === "reverse") return () => traceList(schema, parent, name, link);
      return stub();
    },
  });
}

// ---------------------------------------------------------------- result proxies

function resultRow(schema: StoreSchema, node: TraceNode, raw: Record<string, unknown>, path: string): any {
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property !== "string" || property === "then" || property === "toJSON") return Reflect.get(target, property, receiver);
      const metadata = relationshipOf(schema, node.relation, property);
      if (metadata) {
        const key = linkKey(property);
        if (metadata.cardinality === "many") return resultList(schema, node, raw, property, undefined, `${path}.${property}`);
        if (!(key in raw)) {
          const link = ensureLink(schema, node, property);
          link.rows = true;
          miss(`${path}.${property}`);
          return traceRow(schema, link.node);
        }
        const value = raw[key] as Record<string, unknown> | null;
        return value === null ? null : resultRow(schema, node.links.get(key)!.node, value, `${path}.${property}`);
      }
      if (schema.relations[node.relation]?.fields[property]) {
        if (!(property in raw)) {
          node.fields.add(property);
          miss(`${path}.${property}`);
          return stub();
        }
        return raw[property];
      }
      return undefined;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => typeof key !== "string" || !/[~#]/.test(key));
    },
  });
}

/** The materialized form of a many relationship: a real array, plus host narrowing. */
class ResultList<Row> extends Array<Row> {
  static get [Symbol.species]() { return Array; }
}

function resultList(
  schema: StoreSchema,
  parent: TraceNode,
  raw: Record<string, unknown>,
  name: string,
  narrowing: Narrowing | undefined,
  path: string,
): any {
  const metadata = relationshipOf(schema, parent.relation, name)!;
  const key = linkKey(name, narrowing);
  const link = () => ensureLink(schema, parent, name, narrowing);
  const narrowed = (parts: Omit<Narrowing, "key">) => {
    const merged = { ...narrowing, ...parts };
    return resultList(schema, parent, raw, name, { ...merged, key: narrowingKey(metadata.target, merged) }, path);
  };
  const extras = {
    where: (where: Narrowing["where"]) => narrowed({ where }),
    orderBy: (orderBy: Narrowing["orderBy"]) => narrowed({ orderBy }),
    take: (take: number) => narrowed({ take }),
  };
  if (!(key in raw)) {
    // Only the count was planned: `.length` answers, anything else widens to rows.
    const count = countKey(name, narrowing);
    return new Proxy([], {
      get(_target, property) {
        if (property === "length" && count in raw) return raw[count];
        if (property in extras) return extras[property as keyof typeof extras];
        miss(`${path}${property === "length" ? ".length" : ""}`);
        if (property === "length") { link().counted = true; return 1; }
        return Reflect.get(traceList(schema, parent, name, link()), property);
      },
    });
  }
  const rows = (raw[key] as Record<string, unknown>[]).map((row, index) => resultRow(schema, link().node, row, `${path}[${index}]`));
  return Object.assign(ResultList.from(rows), extras);
}

// ---------------------------------------------------------------- tables and endpoints

export interface Table {
  readonly relation: string;
  readonly nodeSet: NodeSetHandle;
  /** Narrow every read of this table on the host, e.g. by visibility. */
  where(where: (row: any) => unknown): Table;
  one<T>(key: Record<string, unknown>, body: (row: any) => T): T;
  maybe<T>(key: Record<string, unknown>, body: (row: any | null) => T): T;
  many<T>(narrowing: { where?: (row: any) => unknown; orderBy?: (row: any) => unknown; take?: number }, body: (rows: any) => T): T;
}

/** A spike-local wrapper over `node(path).children`. */
export function table(nodeSet: NodeSetHandle, filters: Array<(row: any) => unknown> = []): Table {
  const relation = relationNameOf(nodeSet);
  const all = (row: any, extra?: (row: any) => unknown) => {
    const parts = [...filters, ...(extra ? [extra] : [])].flatMap((filter) => {
      const value = filter(row);
      return Array.isArray(value) ? value : [value];
    });
    return parts;
  };
  const keyed = (key: Record<string, unknown>) => ({
    where: (row: any) => [...Object.entries(key).map(([field, value]) => row[field].eq(value)), ...all(row)],
  });
  const self: Table = {
    relation,
    nodeSet,
    where: (where) => table(nodeSet, [...filters, where]),
    one: (key, body) => root(self, "one", keyed(key), body),
    maybe: (key, body) => root(self, "maybe", keyed(key), body),
    many: (narrowing, body) => root(self, "many", {
      ...narrowing,
      ...(filters.length || narrowing.where ? { where: (row: any) => all(row, narrowing.where) } : {}),
    }, body),
  };
  return self;
}

function root<T>(table: Table, cardinality: QueryCardinality, parts: Omit<Narrowing, "key">, body: (value: any) => T): T {
  const run = active;
  if (!run) throw new Error("A table is read only inside an endpoint");
  const narrowing: Narrowing = { ...parts, key: narrowingKey(table.relation, parts) };
  const key = `${table.relation}:${cardinality}:${narrowing.key}`;
  let traced = run.roots.get(key);
  let tracing = run.mode === "trace";
  if (!traced) {
    traced = { table, cardinality, narrowing, node: newNode(table.relation) };
    run.roots.set(key, traced);
    if (!tracing) miss(`root ${table.relation}`);
    tracing = true;
  }
  const node = traced.node;
  if (tracing) {
    if (cardinality === "many") {
      const holder = newNode("(root)");
      const link: TraceLink = { relationship: "(root)", metadata: { source: "(root)", name: "(root)", target: table.relation, cardinality: "many" }, node, rows: true, counted: false };
      holder.links.set("(root)", link);
      return body(rootTraceList(run.schema, link));
    }
    return body(traceRow(run.schema, node));
  }
  const result = run.results.get(key);
  if (cardinality === "many") {
    return body(ResultList.from((result as Record<string, unknown>[]).map((row, index) => resultRow(run.schema, node, row, `${table.relation}[${index}]`))));
  }
  return body(result === null ? null : resultRow(run.schema, node, result as Record<string, unknown>, table.relation));
}

function rootTraceList(schema: StoreSchema, link: TraceLink): any {
  return new Proxy([], {
    get(_target, property) {
      if (property === Symbol.iterator) return function* () { yield traceRow(schema, link.node); };
      if (property === "length") return 1;
      if (typeof property !== "string") return undefined;
      if (/^\d+$/.test(property)) return traceRow(schema, link.node);
      if (ROW_CALLBACKS.has(property)) return (callback: (row: any, index: number) => unknown) => {
        const value = callback(traceRow(schema, link.node), 0);
        return property === "filter" ? rootTraceList(schema, link) : property === "map" ? [value] : stub();
      };
      if (property === "sort" || property === "toSorted") return (compare?: (a: any, b: any) => number) => {
        compare?.(traceRow(schema, link.node), traceRow(schema, link.node));
        return rootTraceList(schema, link);
      };
      return stub();
    },
  });
}

export interface EndpointContext { user: { profile: string } | null }

export interface Endpoint<Input, Output> {
  readonly kind: "endpoint";
  readonly schema?: StandardSchemaV1<Input, Input>;
  readonly body: (input: Input, context: EndpointContext) => Output;
}

export function endpoint<Output>(body: (input: undefined, context: EndpointContext) => Output): Endpoint<undefined, Output>;
export function endpoint<Input, Output>(schema: StandardSchemaV1<Input, Input>, body: (input: Input, context: EndpointContext) => Output): Endpoint<Input, Output>;
export function endpoint(schemaOrBody: any, possibleBody?: any): Endpoint<any, any> {
  return possibleBody
    ? { kind: "endpoint", schema: schemaOrBody, body: possibleBody }
    : { kind: "endpoint", body: schemaOrBody };
}

// ---------------------------------------------------------------- planning

function selectFor(schema: StoreSchema, node: TraceNode, scope: any): Record<string, unknown> {
  const select: Record<string, unknown> = {};
  const relation = schema.relations[node.relation]!;
  for (const field of relation.primaryKey) select[field] = scope[field];
  for (const field of node.fields) select[field] = scope[field];
  for (const [key, link] of node.links) {
    const narrowing = link.narrowing;
    if (link.rows || link.metadata.cardinality !== "many") {
      select[key] = scope[link.relationship]({
        ...(narrowing?.where ? { where: narrowing.where } : {}),
        ...(narrowing?.orderBy ? { orderBy: narrowing.orderBy } : {}),
        ...(narrowing?.take ? { take: narrowing.take } : {}),
        select: (row: any) => selectFor(schema, link.node, row),
      });
    }
    if (link.counted && !link.rows) {
      if (narrowing) throw new Error(`A count over narrowed ${node.relation}.${link.relationship} is not supported by the query engine`);
      select[countKey(link.relationship)] = scope[link.relationship].count;
    }
  }
  return select;
}

export function planRoot(schema: StoreSchema, root: TraceRoot): QueryHandle<unknown, unknown> {
  const narrowing = root.narrowing;
  return query[root.cardinality](root.table.nodeSet, (row) => ({
    ...(narrowing.where ? { where: narrowing.where(row) } : {}),
    ...(narrowing.orderBy ? { orderBy: narrowing.orderBy(row) } : {}),
    ...(narrowing.take ? { take: narrowing.take } : {}),
    select: selectFor(schema, root.node, row),
  }));
}

// ---------------------------------------------------------------- running

export interface EndpointRunOptions<Input> {
  engine: SQLiteQueryEngine;
  /** Resolve a planned handle's node() source, as activation would. */
  resolve: (handle: QueryHandle<unknown, unknown>) => Promise<ResolvedStorySource>;
  input?: Input;
  user?: { profile: string } | null;
  maxWidenings?: number;
}

export interface EndpointRun<Output> {
  output: Output;
  /** One plan per root the body read, as the host would run them. */
  plans: QueryHandle<unknown, unknown>[];
  /** Reads the first trace missed, each of which re-planned and re-ran. */
  widened: string[];
  /** Times the plan was widened and run again. */
  reruns: number;
  statements: number;
}

export async function runEndpoint<Input, Output>(
  handle: Endpoint<Input, Output>,
  options: EndpointRunOptions<Input>,
): Promise<EndpointRun<Output>> {
  const schema = options.engine.schema;
  const user = options.user ?? null;
  let input = options.input as Input;
  if (handle.schema) {
    const checked = await handle.schema["~standard"].validate(input);
    if (checked.issues) throw new Error(checked.issues.map((issue) => issue.message).join("; "));
    input = checked.value as Input;
  }
  const run: Run = { mode: "trace", schema, roots: new Map(), results: new Map(), user, misses: [] };
  const widened: string[] = [];
  const within = <T>(work: () => T): T => {
    const previous = active;
    active = run;
    try { return work(); } finally { active = previous; }
  };

  try {
    within(() => handle.body(input, { user }));
  } catch {
    // JS that cannot run over stand-ins (JSON.parse of a field, say) ends the trace
    // early; whatever it missed widens on the first real run.
  }

  let statements = 0;
  for (let attempt = 0; ; attempt += 1) {
    const plans: QueryHandle<unknown, unknown>[] = [];
    run.results.clear();
    for (const [key, root] of run.roots) {
      const plan = planRoot(schema, root);
      options.engine.bind(plan, await options.resolve(plan));
      const execution = await options.engine.execute(plan, { user });
      statements += execution.statements.length;
      run.results.set(key, execution.result);
      plans.push(plan);
    }
    run.mode = "real";
    run.misses = [];
    let output: Output;
    try {
      output = within(() => handle.body(input, { user }));
    } catch (error) {
      // Real JS over a trace stand-in can throw; with misses recorded, rerun instead.
      if (run.misses.length === 0) throw error;
      output = undefined as Output;
    }
    if (run.misses.length === 0) return { output, plans, widened, reruns: attempt, statements };
    widened.push(...run.misses);
    if (attempt >= (options.maxWidenings ?? 4)) throw new Error(`Endpoint did not settle after ${attempt + 1} widenings`);
  }
}
