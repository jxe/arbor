import {
  liveViewStream,
  type Hash,
  type HandleRef,
  type LiveViewAdapter,
  type LiveViewContext,
  type ReadPath,
  type ViewAnswerForm,
  type ViewEvent,
  type ViewMount,
  type ViewsRequest,
  type ViewsRuntime,
} from "@ovst/protocol";
import type { NodeHandle, OverstoryUser, PredicateExpression, QueryPlan, SelectionPlan, ValueExpression } from "./authoring.ts";
import { runView, type ReadRules, type View, type ViewRun } from "./views.ts";
import type { ResolvedStorySource, StoreSchema } from "./schema.ts";
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
  /** Reached by some(): its rows decide which rows match without being recorded as dependencies. */
  opaque: boolean;
}

interface QuerySensitivity {
  relations: Map<string, RelationSensitivity>;
  input: unknown;
  user: OverstoryUser | null;
}

export function handleRefKey(ref: HandleRef): string {
  return `${ref.tree}\0${ref.path}\0${ref.name}\0${ref.version}`;
}

function addValue(fields: Set<string>, value: ValueExpression, schema: StoreSchema, relation: string, relations: Map<string, RelationSensitivity>): void {
  if (value.kind === "field") {
    if (!value.scope || value.scope === "self") fields.add(value.field);
    // Another row's field: that row's own plan depends on it. A helper variable's field
    // makes its whole relation opaque (see addPredicate).
    return;
  }
  if (value.kind !== "count") return;
  const metadata = schema.relationships[`${relation}.${value.relationship}`]!;
  if (value.where) {
    const target = relationSensitivity(relations, metadata.target, false);
    target.opaque = true;
    target.unfiltered = true;
    for (const field of Object.keys(schema.relations[metadata.target]!.fields)) target.fields.add(field);
  }
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
  } else if (predicate.kind === "not") {
    addPredicate(fields, predicate.operand, schema, relation, relations);
  } else if (predicate.kind === "some") {
    // A helper variable: any change to its relation may change which rows match.
    const helper = relationSensitivity(relations, predicate.relation, false);
    helper.opaque = true;
    helper.unfiltered = true;
    for (const field of Object.keys(schema.relations[predicate.relation]!.fields)) helper.fields.add(field);
    addPredicate(fields, predicate.where, schema, relation, relations);
  } else if (predicate.kind === "exists") {
    const from = predicate.scope && predicate.scope !== "self" ? predicate.relation : relation;
    const metadata = schema.relationships[`${from}.${predicate.relationship}`]!;
    for (const pair of metadata.direct ?? metadata.through!.source) fields.add(pair.source);
    const target = relationSensitivity(relations, metadata.target, false);
    target.opaque = true;
    if (metadata.direct) for (const pair of metadata.direct) target.fields.add(pair.target);
    else {
      const through = relationSensitivity(relations, metadata.through!.relation, false);
      through.opaque = true;
      through.unfiltered = true;
      for (const pair of [...metadata.through!.source, ...metadata.through!.target]) through.fields.add(pair.through);
      for (const pair of metadata.through!.target) target.fields.add(pair.target);
    }
    if (predicate.keys) {
      target.unfiltered = true;
      if (metadata.through) relationSensitivity(relations, metadata.through.relation, false).unfiltered = true;
    }
    if (predicate.where) {
      target.predicates.push(predicate.where);
      addPredicate(target.fields, predicate.where, schema, metadata.target, relations);
    } else target.unfiltered = true;
  } else {
    addValue(fields, predicate.left, schema, relation, relations);
    addValue(fields, predicate.right, schema, relation, relations);
  }
}

function relationSensitivity(relations: Map<string, RelationSensitivity>, relation: string, root: boolean): RelationSensitivity {
  let value = relations.get(relation);
  if (!value) {
    value = { root, fields: new Set(), predicates: [], unfiltered: false, opaque: false };
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

function sensitivity(schema: StoreSchema, plan: QueryPlan, input: unknown, user: OverstoryUser | null): QuerySensitivity {
  const relations = new Map<string, RelationSensitivity>();
  visitPlan(schema, plan.relation, plan, relations, true);
  return { relations, input, user };
}

function predicateMatches(predicate: PredicateExpression | undefined, row: Record<string, unknown> | null, query: QuerySensitivity): boolean {
  if (!row) return false;
  // A count or some() depends on other rows, so the row alone cannot rule the predicate out.
  const scoped = (value: ValueExpression) => value.kind === "count" || (value.kind === "field" && Boolean(value.scope) && value.scope !== "self");
  const containsCount = (value: PredicateExpression): boolean => value.kind === "logical"
    ? value.operands.some(containsCount)
    : value.kind === "not"
      ? containsCount(value.operand)
      : value.kind === "exists" || value.kind === "some" || scoped(value.left) || scoped(value.right);
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
  if (relation.root || relation.opaque) return true;
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
  const message = error instanceof Error && /input|required|not found|missing|missed/i.test(error.message)
    ? error.message
    : "The view could not be evaluated";
  return { code: "invalid-request", message, retryable: false } as const;
}

/** A view mounted on a stream, with how its sources resolve. */
export interface MountedView {
  id: string;
  handle: View<any, unknown>;
  input?: unknown;
  form?: ViewAnswerForm;
  missed?: ReadPath[];
  knownOutputHash?: Hash;
  /** Binds each source the view reads, as its activation does. */
  resolve: (source: NodeHandle) => Promise<ResolvedStorySource>;
}

export interface LiveViewBrokerOptions {
  /** The host's read rules, by model. */
  readRules?: ReadRules;
  /** Model paths for row identity, by relation. */
  modelPaths?: Record<string, string>;
}

/** What one run of a view is sensitive to: each plan it ran, with that execution. */
type ViewSensitivity = Array<{ query: QuerySensitivity; execution: QueryExecution<unknown> }>;

/** Coordinates store/profile cursors and owns the race-free subscription state machines. */
export class LiveViewBroker implements AsyncDisposable {
  private readonly listeners = new Set<(event: Invalidation) => void>();
  private sequence = 0;
  private readonly stopStore: () => void;
  private readonly stopProfiles: () => void;

  constructor(readonly engine: SQLiteQueryEngine, readonly store: SQLiteStoreBroker, readonly options: LiveViewBrokerOptions = {}) {
    this.stopStore = store.subscribe((change) => this.publish({ cursor: this.nextCursor(), kind: "store", change }));
    this.stopProfiles = engine.subscribeProfiles((change) => this.publish({ cursor: this.nextCursor(), kind: "profile", ...change }));
  }

  currentCursor(): string { return `view:${this.sequence}`; }

  /** How many view streams are open on this broker. */
  get listening(): number { return this.listeners.size; }

  reload(reason: "source-changed" | "access-changed"): void {
    this.publish({ cursor: this.nextCursor(), kind: "reload", reason });
  }

  /** One run of a view, as a stream evaluates it. */
  run(mount: Omit<MountedView, "id">, user: OverstoryUser | null): Promise<ViewRun<unknown>> {
    return runView(mount.handle, {
      engine: this.engine,
      resolve: mount.resolve,
      input: mount.input,
      user,
      ...(this.options.readRules ? { readRules: this.options.readRules } : {}),
      ...(mount.missed ? { missed: mount.missed } : {}),
      ...(mount.form ? { form: mount.form } : {}),
      ...(this.options.modelPaths ? { modelPaths: this.options.modelPaths } : {}),
    });
  }

  stream(mounts: readonly MountedView[], context: LiveViewContext): ReadableStream<ViewEvent> {
    const broker = this;
    const adapter: LiveViewAdapter<ViewRun<unknown>, ViewSensitivity, Invalidation, MountedView> = {
      subscribe(listener) {
        broker.listeners.add(listener);
        return () => broker.listeners.delete(listener);
      },
      execute: (mount) => broker.run(mount, context.user),
      sensitivity: (mount, run) => run.ran.map(({ plan, execution }) => ({
        query: sensitivity(broker.engine.schema, plan.plan, mount.input, context.user),
        execution,
      })),
      // Before a view's first run its plan is unknown, so every event is relevant.
      relevant: (event, _mount, plans) => !plans || event.kind === "reload" || plans.some(({ query, execution }) => relevant(event, query, execution)),
      result: (run) => run.output,
      shape: (run) => run.shape,
      safeError,
      reload: (event) => event.kind === "reload" ? event.reason : undefined,
    };
    return liveViewStream(mounts, context, adapter);
  }

  private nextCursor(): string { this.sequence += 1; return this.currentCursor(); }
  private publish(event: Invalidation): void { for (const listener of [...this.listeners]) listener(event); }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stopStore();
    this.stopProfiles();
    this.listeners.clear();
  }
}

/** The views of one source tree, by handle: what a `views` request may mount. */
export class RegisteredViewRuntime implements ViewsRuntime {
  private readonly views = new Map<string, { handle: View<any, unknown>; resolve: MountedView["resolve"] }>();

  constructor(
    readonly tree: string,
    readonly broker: Pick<LiveViewBroker, "stream">,
    entries: readonly { ref: HandleRef; handle: View<any, unknown>; resolve: MountedView["resolve"] }[],
  ) {
    for (const entry of entries) this.views.set(handleRefKey(entry.ref), { handle: entry.handle, resolve: entry.resolve });
  }

  stream(request: ViewsRequest, context: { signal: AbortSignal; user: OverstoryUser | null }): ReadableStream<ViewEvent> {
    // Each handle carries its tree, path and version; there is no document (07 §12.1).
    if (request.views?.some((view) => view?.handle?.tree !== this.tree)) throw new Error("Every view handle must name this source tree");
    return this.broker.stream(viewMounts(request, (ref) => this.views.get(handleRefKey(ref))), context);
  }
}

/** Check a `views` request's mounts and pair each with its view. */
export function viewMounts<Entry>(
  request: ViewsRequest,
  find: (ref: HandleRef) => Entry | undefined,
): Array<Omit<ViewMount, "handle"> & { ref: HandleRef } & Entry> {
  if (!Array.isArray(request.views) || request.views.length === 0) throw new Error("views must be a nonempty array");
  const ids = new Set<string>();
  return request.views.map((mount) => {
    if (typeof mount.id !== "string" || !mount.id || ids.has(mount.id)) throw new Error("Mounted view ids must be non-empty and unique");
    ids.add(mount.id);
    if (mount.form !== undefined && mount.form !== "value" && mount.form !== "rows" && mount.form !== "tree") throw new Error("A view's form must be value, rows or tree");
    if (mount.missed !== undefined && !Array.isArray(mount.missed)) throw new Error("missed must be an array of read paths");
    const entry = find(mount.handle);
    if (!entry) throw new Error("A mounted view handle or version is not active");
    const { handle: ref, ...rest } = mount;
    return { ...rest, ref, ...entry };
  });
}
