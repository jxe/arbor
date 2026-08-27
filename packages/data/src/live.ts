import { canonicalJSONString, sha256, type Hash, type QueryHandleRef, type QueryStreamEvent, type QueryStreamRequest, type QueryStreamRuntime } from "@arbor/core";
import type { ArborUser, PredicateExpression, QueryHandle, QueryPlan, SelectionPlan, ValueExpression } from "./authoring.ts";
import type { StoreSchema } from "./schema.ts";
import { SQLiteQueryEngine, type QueryExecution } from "./sqlite.ts";
import { SQLiteStoreBroker, type SQLiteRowChange, type SQLiteStoreChange } from "./observer.ts";

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

interface MountedQuery {
  id: string;
  handle: QueryHandle<unknown, unknown>;
  input?: unknown;
  knownOutputHash?: Hash;
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

function inputValue(input: unknown, path: readonly string[]): unknown {
  let value = input;
  for (const part of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  return value;
}

function value(value: ValueExpression, row: Record<string, unknown>, query: QuerySensitivity): unknown {
  if (value.kind === "field") return row[value.field];
  if (value.kind === "parameter") return inputValue(query.input, value.path);
  if (value.kind === "user") return query.user?.profile ?? null;
  if (value.kind === "literal") return value.value;
  return undefined;
}

function predicateMatches(predicate: PredicateExpression | undefined, row: Record<string, unknown> | null, query: QuerySensitivity): boolean {
  if (!row) return false;
  if (!predicate) return true;
  if (predicate.kind === "logical") return predicate.operator === "and"
    ? predicate.operands.every((operand) => predicateMatches(operand, row, query))
    : predicate.operands.some((operand) => predicateMatches(operand, row, query));
  if (predicate.left.kind === "count" || predicate.right.kind === "count") return true;
  const left = value(predicate.left, row, query);
  const right = value(predicate.right, row, query);
  return predicate.operator === "eq"
    ? left === right
    : String(left ?? "").toLocaleLowerCase().includes(String(right ?? "").toLocaleLowerCase());
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

function outputHash(value: unknown): Hash {
  return `sha256:${sha256(canonicalJSONString(value))}`;
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

  stream(mounts: readonly MountedQuery[], context: { signal: AbortSignal; user: ArborUser | null }): ReadableStream<QueryStreamEvent> {
    const broker = this;
    let cancelStream: (() => void) | undefined;
    return new ReadableStream<QueryStreamEvent>({
      start(controller) {
        let closed = false;
        let ready = false;
        const states = mounts.map((mount) => ({
          mount,
          query: sensitivity(broker.engine.schema, mount.handle.plan, mount.input, context.user),
          execution: undefined as QueryExecution<unknown> | undefined,
          pending: [] as Invalidation[],
          running: undefined as Promise<void> | undefined,
          hash: undefined as Hash | undefined,
          cursor: broker.currentCursor(),
        }));
        const emit = (event: QueryStreamEvent) => {
          if (closed) return;
          if ((controller.desiredSize ?? 1) <= 0) {
            cleanup();
            try { controller.close(); } catch {}
            return;
          }
          controller.enqueue(event);
        };
        const evaluate = async (state: typeof states[number], publish: boolean): Promise<void> => {
          if (state.running) return state.running;
          state.running = (async () => {
            while (!closed) {
              const oldExecution = state.execution;
              state.pending = [];
              let execution: QueryExecution<unknown>;
              try {
                execution = await broker.engine.execute(state.mount.handle, { input: state.mount.input, user: context.user });
              } catch (error) {
                state.cursor = broker.currentCursor();
                emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, error: safeError(error) });
                return;
              }
              const invalidated = state.pending.some((event) =>
                relevant(event, state.query, oldExecution) || relevant(event, state.query, execution));
              if (invalidated) continue;
              state.execution = execution;
              state.cursor = broker.currentCursor();
              const hash = outputHash(execution.result);
              if (publish && hash !== state.hash) {
                state.hash = hash;
                emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, outputHash: hash, value: execution.result });
              } else state.hash = hash;
              return;
            }
          })().finally(() => { state.running = undefined; });
          return state.running;
        };
        const stop = (() => {
          const listener = (event: Invalidation) => {
            if (event.kind === "reload") {
              emit({ type: "reload", reason: event.reason });
              cleanup();
              try { controller.close(); } catch {}
              return;
            }
            for (const state of states) {
              if (!relevant(event, state.query, state.execution)) continue;
              state.pending.push(event);
              if (ready && !state.running) void evaluate(state, true);
            }
          };
          broker.listeners.add(listener);
          return () => broker.listeners.delete(listener);
        })();
        const cleanup = () => {
          if (closed) return;
          closed = true;
          stop();
          context.signal.removeEventListener("abort", abort);
        };
        cancelStream = cleanup;
        const abort = () => {
          cleanup();
          try { controller.close(); } catch {}
        };
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) {
          abort();
          return;
        }
        void (async () => {
          await Promise.all(states.map((state) => evaluate(state, false)));
          if (closed) return;
          // No event can cross this synchronous publication boundary without
          // first being queued by the already-attached listener.
          for (const state of states) {
            if (!state.execution || !state.hash) continue;
            if (state.hash !== state.mount.knownOutputHash) {
              emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, outputHash: state.hash, value: state.execution.result });
            }
          }
          ready = true;
          emit({ type: "ready", queries: states.map((state) => ({
            id: state.mount.id,
            observedThrough: state.cursor,
            ...(state.hash ? { outputHash: state.hash } : {}),
          })) });
          for (const state of states) if (state.pending.length && !state.running) void evaluate(state, true);
        })();
      },
      cancel() { cancelStream?.(); },
    }, { highWaterMark: 64 });
  }

  private nextCursor(): string { this.sequence += 1; return this.currentCursor(); }
  private publish(event: Invalidation): void { for (const listener of [...this.listeners]) listener(event); }

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
    readonly broker: LiveQueryBroker,
    entries: readonly { ref: QueryHandleRef; handle: QueryHandle<unknown, unknown> }[],
  ) {
    for (const entry of entries) this.handles.set(refKey(entry.ref), entry.handle);
  }

  stream(request: QueryStreamRequest, context: { signal: AbortSignal; user: ArborUser | null }): ReadableStream<QueryStreamEvent> {
    if (canonicalJSONString(request.document) !== canonicalJSONString(this.document)) throw new Error("The mounted document version is not active");
    if (!Array.isArray(request.queries)) throw new Error("queries must be an array");
    const ids = new Set<string>();
    const mounts = request.queries.map((mount): MountedQuery => {
      if (!mount.id || ids.has(mount.id)) throw new Error("Mounted query ids must be non-empty and unique");
      ids.add(mount.id);
      const handle = this.handles.get(refKey(mount.handle));
      if (!handle) throw new Error("A mounted query handle or version is not active");
      return { id: mount.id, handle, input: mount.input, knownOutputHash: mount.knownOutputHash };
    });
    return this.broker.stream(mounts, context);
  }
}
