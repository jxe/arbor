import { stableJSONString, type QueryHandleRef, type QueryStreamEvent, type QueryStreamRequest, type QueryStreamRuntime } from "@arbor/core";
import { liveQueryStream, type LiveQueryAdapter, type LiveQueryContext, type MountedQuery } from "./live-stream.ts";

export type { MountedQuery } from "./live-stream.ts";
import type { ArborUser, PredicateExpression, QueryHandle, QueryPlan, SelectionPlan, ValueExpression } from "./authoring.ts";
import type { ResolvedArborSource, StoreSchema } from "./schema.ts";
import { SQLiteQueryEngine, type QueryExecution } from "./sqlite.ts";
import { SQLiteStoreBroker, type SQLiteRowChange, type SQLiteStoreChange } from "./observer.ts";
import { evaluateQueryPredicate } from "./query-core.ts";

type Invalidation =
  | { cursor: string; kind: "store"; change: SQLiteStoreChange }
  | { cursor: string; kind: "profile"; profile: string; tree: string; ref: string }
  | { cursor: string; kind: "reload"; reason: "source-changed" | "access-changed" };

interface RelationSensitivity {
  root: boolean;
  fields: Set<string>;
  predicates: PredicateExpression[];
  unfiltered: boolean;
}

interface QuerySensitivity {
  relations: Map<string, RelationSensitivity>;
  input: unknown;
  user: ArborUser | null;
}

function refKey(ref: QueryHandleRef): string {
  return `${ref.tree}\0${ref.module}\0${ref.export}\0${ref.version}`;
}

function addValue(fields: Set<string>, value: ValueExpression, schema: StoreSchema, relation: string, relations: Map<string, RelationSensitivity>): void {
  if (value.kind === "field") fields.add(value.field);
  if (value.kind !== "count") return;
  const metadata = schema.relationships[`${relation}.${value.relationship}`]!;
  for (const pair of metadata.direct ?? metadata.through!.source) fields.add(pair.source);
  if (metadata.direct) {
    const target = relationSensitivity(relations, metadata.target, false);
    for (const pair of metadata.direct) target.fields.add(pair.target);
  } else {
    const through = relationSensitivity(relations, metadata.through!.relation, false);
    for (const pair of [...metadata.through!.source, ...metadata.through!.target]) through.fields.add(pair.through);
  }
}

function addPredicate(fields: Set<string>, predicate: PredicateExpression, schema: StoreSchema, relation: string, relations: Map<string, RelationSensitivity>): void {
  if (predicate.kind === "logical") {
    for (const operand of predicate.operands) addPredicate(fields, operand, schema, relation, relations);
  } else {
    addValue(fields, predicate.left, schema, relation, relations);
    addValue(fields, predicate.right, schema, relation, relations);
  }
}

function relationSensitivity(relations: Map<string, RelationSensitivity>, relation: string, root: boolean): RelationSensitivity {
  let value = relations.get(relation);
  if (!value) {
    value = { root, fields: new Set(), predicates: [], unfiltered: false };
    relations.set(relation, value);
  } else if (root) value.root = true;
  return value;
}

function visitPlan(schema: StoreSchema, relation: string, plan: SelectionPlan, relations: Map<string, RelationSensitivity>, root: boolean): void {
  const current = relationSensitivity(relations, relation, root);
  for (const field of schema.relations[relation]!.primaryKey) current.fields.add(field);
  if (!plan.where) current.unfiltered = true;
  if (plan.where) current.predicates.push(plan.where);
  if (plan.where) addPredicate(current.fields, plan.where, schema, relation, relations);
  for (const order of plan.orderBy) addValue(current.fields, order.value, schema, relation, relations);
  for (const selected of Object.values(plan.select)) {
    if (selected.kind === "field" || selected.kind === "count") {
      addValue(current.fields, selected, schema, relation, relations);
      continue;
    }
    if (selected.kind !== "relationship") continue;
    const metadata = schema.relationships[`${relation}.${selected.relationship}`]!;
    if (metadata.direct) {
      for (const pair of metadata.direct) current.fields.add(pair.source);
      const target = relationSensitivity(relations, metadata.target, false);
      for (const pair of metadata.direct) target.fields.add(pair.target);
    } else {
      for (const pair of metadata.through!.source) current.fields.add(pair.source);
      const through = relationSensitivity(relations, metadata.through!.relation, false);
      for (const pair of [...metadata.through!.source, ...metadata.through!.target]) through.fields.add(pair.through);
    }
    visitPlan(schema, metadata.target, selected.plan, relations, false);
  }
}

function sensitivity(schema: StoreSchema, plan: QueryPlan, input: unknown, user: ArborUser | null): QuerySensitivity {
  const relations = new Map<string, RelationSensitivity>();
  visitPlan(schema, plan.relation, plan, relations, true);
  return { relations, input, user };
}

function predicateMatches(predicate: PredicateExpression | undefined, row: Record<string, unknown> | null, query: QuerySensitivity): boolean {
  if (!row) return false;
  const containsCount = (value: PredicateExpression): boolean => value.kind === "logical"
    ? value.operands.some(containsCount)
    : value.left.kind === "count" || value.right.kind === "count";
  if (predicate && containsCount(predicate)) return true;
  return evaluateQueryPredicate(predicate, row, query);
}

function matches(record: Record<string, unknown> | null, expected: Record<string, unknown>): boolean {
  return Boolean(record) && Object.entries(expected).every(([field, value]) => Object.is(record![field], value));
}

function rowRelevant(change: SQLiteRowChange, query: QuerySensitivity, execution?: QueryExecution<unknown>): boolean {
  const relation = query.relations.get(change.collection);
  if (!relation) return false;
  if (change.operation === "update" && !change.changedFields.some((field) => relation.fields.has(field))) return false;
  const rowMayParticipate = relation.unfiltered || relation.predicates.length === 0 || relation.predicates.some((predicate) =>
    predicateMatches(predicate, change.before, query) || predicateMatches(predicate, change.after, query));
  if (!rowMayParticipate) return false;
  if (relation.root) return true;
  const dependency = execution?.dependencies.database[change.collection];
  if (!dependency) return true;
  if (dependency.rows.some((key) => matches(change.before, key) || matches(change.after, key))) return true;
  if (dependency.matchAny.some((constraint) => matches(change.before, constraint) || matches(change.after, constraint))) return true;
  return false;
}

function relevant(event: Invalidation, query: QuerySensitivity, execution?: QueryExecution<unknown>): boolean {
  if (event.kind === "reload") return true;
  if (event.kind === "profile") return execution?.dependencies.profiles.some((dependency) => dependency.profile === event.profile || dependency.tree === event.tree) ?? true;
  if (event.change.precision !== "rows") return true;
  return event.change.changes.some((change) => rowRelevant(change, query, execution));
}

function safeError(error: unknown) {
  const message = error instanceof Error && /input|required|not found|missing/i.test(error.message)
    ? error.message
    : "The query could not be evaluated";
  return { code: "invalid-request", message, retryable: false } as const;
}

/** Coordinates store/profile cursors and owns the race-free subscription state machines. */
export class LiveQueryBroker implements AsyncDisposable {
  private readonly listeners = new Set<(event: Invalidation) => void>();
  private sequence = 0;
  private readonly stopStore: () => void;
  private readonly stopProfiles: () => void;

  constructor(readonly engine: SQLiteQueryEngine, readonly store: SQLiteStoreBroker) {
    this.stopStore = store.subscribe((change) => this.publish({ cursor: this.nextCursor(), kind: "store", change }));
    this.stopProfiles = engine.subscribeProfiles((change) => this.publish({ cursor: this.nextCursor(), kind: "profile", ...change }));
  }

  currentCursor(): string { return `query:${this.sequence}`; }

  reload(reason: "source-changed" | "access-changed"): void {
    this.publish({ cursor: this.nextCursor(), kind: "reload", reason });
  }

  stream(mounts: readonly MountedQuery[], context: LiveQueryContext): ReadableStream<QueryStreamEvent> {
    const broker = this;
    const sensitivities = new Map<MountedQuery, QuerySensitivity>();
    const querySensitivity = (mount: MountedQuery): QuerySensitivity => {
      let value = sensitivities.get(mount);
      if (!value) {
        value = sensitivity(broker.engine.schema, mount.handle.plan, mount.input, context.user);
        sensitivities.set(mount, value);
      }
      return value;
    };
    const adapter: LiveQueryAdapter<QueryExecution<unknown>, QuerySensitivity, Invalidation> = {
      currentCursor: () => broker.currentCursor(),
      subscribe(listener) {
        broker.listeners.add(listener);
        return () => broker.listeners.delete(listener);
      },
      initialSensitivity: querySensitivity,
      execute: (mount) => broker.engine.execute(mount.handle, { input: mount.input, user: context.user }),
      sensitivity: (mount) => querySensitivity(mount),
      relevant: (event, mount, query, execution) => relevant(event, query ?? querySensitivity(mount), execution),
      result: (execution) => execution.result,
      safeError,
      reload: (event) => event.kind === "reload" ? event.reason : undefined,
    };
    return liveQueryStream(mounts, context, adapter);
  }

  private nextCursor(): string { this.sequence += 1; return this.currentCursor(); }
  private publish(event: Invalidation): void { for (const listener of [...this.listeners]) listener(event); }

  bind(handle: QueryHandle<unknown, unknown>, source?: ResolvedArborSource): void {
    if (!source) throw new Error("SQLite query handles require a resolved source binding");
    this.engine.bind(handle, source);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stopStore();
    this.stopProfiles();
    this.listeners.clear();
  }
}

export class RegisteredQueryRuntime implements QueryStreamRuntime {
  private readonly handles = new Map<string, QueryHandle<unknown, unknown>>();

  constructor(
    readonly document: QueryStreamRequest["document"],
    readonly broker: Pick<LiveQueryBroker, "bind" | "stream">,
    entries: readonly { ref: QueryHandleRef; handle: QueryHandle<unknown, unknown>; source?: ResolvedArborSource }[],
  ) {
    for (const entry of entries) {
      this.broker.bind(entry.handle, entry.source);
      this.handles.set(refKey(entry.ref), entry.handle);
    }
  }

  stream(request: QueryStreamRequest, context: { signal: AbortSignal; user: ArborUser | null }): ReadableStream<QueryStreamEvent> {
    if (stableJSONString(request.document) !== stableJSONString(this.document)) throw new Error("The mounted document version is not active");
    if (!Array.isArray(request.queries)) throw new Error("queries must be an array");
    const ids = new Set<string>();
    const mounts = request.queries.map((mount): MountedQuery => {
      if (!mount.id || ids.has(mount.id)) throw new Error("Mounted query ids must be non-empty and unique");
      ids.add(mount.id);
      const handle = this.handles.get(refKey(mount.handle));
      if (!handle) throw new Error("A mounted query handle or version is not active");
      return { id: mount.id, tree: mount.handle.tree, handle, input: mount.input, knownOutputHash: mount.knownOutputHash };
    });
    return this.broker.stream(mounts, context);
  }
}
