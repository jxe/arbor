import { canonicalJSONString, sha256, type ChildrenPage, type Hash, type NodeRef, type NodeSnapshot, type NodeSummary, type QueryStreamEvent, type WorkspaceEvent } from "@arbor/core";
import type { MountedQuery } from "./live.ts";
import type {
  ArborUser,
  QueryHandle,
} from "./authoring.ts";
import {
  compareUTF8,
  containsRequiredUser,
  evaluateQueryPredicate,
  finishCardinality,
  QueryCompileError,
  QueryUserRequiredError,
  shapeQueryRow,
  validatePortableNodePlan,
  validateQueryInput,
} from "./query-core.ts";

export interface NodeQueryProvider {
  snapshot(sourcePath: string): Promise<NodeSnapshot>;
  children(source: NodeRef, cursor: string | null): Promise<ChildrenPage>;
}

export interface NodeQueryExecution<Result> {
  result: Result;
  dependencies: {
    membership: {
      ref: NodeRef;
      revision: string;
      schemaRevision: string | null;
      observedThrough: string;
    };
    rows: Array<{ ref: NodeSummary["ref"]; revision: string }>;
  };
}

export interface NodeQueryEngineOptions {
  maxRows?: number;
}

function stableOrder(rows: NodeSummary[]): NodeSummary[] {
  return rows.sort((left, right) => compareUTF8(
    left.ref.stableKey ?? left.ref.path,
    right.ref.stableKey ?? right.ref.path,
  ));
}

function sameRef(left: NodeRef, right: NodeRef): boolean {
  return left.tree === right.tree && left.path === right.path && left.stableKey === right.stableKey;
}

export class NodeQueryEngine {
  private readonly maxRows: number;

  constructor(private readonly provider: NodeQueryProvider, options: NodeQueryEngineOptions = {}) {
    this.maxRows = options.maxRows ?? 10_000;
  }

  async execute<Result, Input>(
    handle: QueryHandle<Result, Input>,
    options: { input?: Input; user?: ArborUser | null } = {},
  ): Promise<NodeQueryExecution<Result>> {
    validatePortableNodePlan(handle.plan);
    const input = await validateQueryInput(handle.schema, options.input);
    const user = options.user ?? null;
    if (containsRequiredUser(handle.plan) && !user) throw new QueryUserRequiredError();
    const source = await this.provider.snapshot(handle.source.path);
    const children = source.capabilities.children;
    if (!children) throw new QueryCompileError(`arbor(${JSON.stringify(handle.source.path)}) does not have children`);
    const rows: NodeSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.provider.children(source.ref, cursor);
      if (!sameRef(page.parent, source.ref)) throw new QueryCompileError("Node provider changed the query source while paging children");
      rows.push(...page.items);
      if (rows.length > this.maxRows) throw new QueryCompileError(`Node query exceeds its ${this.maxRows}-row execution bound`);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new QueryCompileError("Node provider repeated a children cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);

    const identities = new Set<string>();
    for (const row of rows) {
      const identity = `${row.ref.tree}\0${row.ref.stableKey ?? row.ref.path}`;
      if (identities.has(identity)) throw new QueryCompileError(`Node provider returned duplicate child identity ${identity}`);
      identities.add(identity);
    }
    const matched = stableOrder(rows.filter((row) => evaluateQueryPredicate(handle.plan.where, row.properties, { input, user })));
    const shaped = matched.map((row) => shapeQueryRow(row.properties, handle.plan.select));
    const result = finishCardinality(shaped, handle.plan.cardinality, "node");
    return {
      result: result as Result,
      dependencies: {
        membership: {
          ref: source.ref,
          revision: children.revision,
          schemaRevision: children.schema ?? null,
          observedThrough: source.observedThrough,
        },
        rows: rows.map((row) => ({ ref: row.ref, revision: row.revision })),
      },
    };
  }
}

export interface NodeQueryObservationSource {
  currentCursor(): string;
  subscribe(listener: (event: WorkspaceEvent) => void): () => void;
}

function nodeOutputHash(value: unknown): Hash {
  return `sha256:${sha256(canonicalJSONString(value))}`;
}

function safeNodeQueryError(error: unknown) {
  const message = error instanceof Error && /input|required|not found|missing|children|bound/i.test(error.message)
    ? error.message
    : "The query could not be evaluated";
  return { code: "invalid-request", message, retryable: false } as const;
}

/** Race-free conservative live execution for any provider that exposes ordinary nodes. */
export class NodeLiveQueryBroker {
  constructor(
    readonly engine: NodeQueryEngine,
    readonly observations: NodeQueryObservationSource,
  ) {}

  bind(_handle: QueryHandle<unknown, unknown>): void {}

  stream(
    mounts: readonly MountedQuery[],
    context: { signal: AbortSignal; user: ArborUser | null },
  ): ReadableStream<QueryStreamEvent> {
    const engine = this.engine;
    const observations = this.observations;
    return new ReadableStream<QueryStreamEvent>({
      start(controller) {
        let closed = false;
        let ready = false;
        const states = mounts.map((mount) => ({
          mount,
          cursor: observations.currentCursor(),
          hash: undefined as Hash | undefined,
          running: undefined as Promise<void> | undefined,
          dirty: false,
        }));
        const emit = (event: QueryStreamEvent) => { if (!closed) controller.enqueue(event); };
        const evaluate = (state: typeof states[number], publish: boolean): Promise<void> => {
          if (state.running) { state.dirty = true; return state.running; }
          state.running = (async () => {
            do {
              state.dirty = false;
              const boundary = observations.currentCursor();
              try {
                const execution = await engine.execute(state.mount.handle, {
                  input: state.mount.input,
                  user: context.user,
                });
                const hash = nodeOutputHash(execution.result);
                state.cursor = execution.dependencies.membership.observedThrough || boundary;
                if (publish && hash !== state.hash) {
                  emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, outputHash: hash, value: execution.result });
                }
                state.hash = hash;
              } catch (error) {
                state.cursor = boundary;
                if (publish) emit({ type: "result", id: state.mount.id, observedThrough: boundary, error: safeNodeQueryError(error) });
              }
            } while (state.dirty && !closed);
          })().finally(() => { state.running = undefined; });
          return state.running;
        };
        const stop = observations.subscribe((event) => {
          for (const state of states) {
            if (state.mount.tree && event.tree !== state.mount.tree) continue;
            state.dirty = true;
            if (ready) void evaluate(state, true);
          }
        });
        const close = () => {
          if (closed) return;
          closed = true;
          stop();
          try { controller.close(); } catch {}
        };
        context.signal.addEventListener("abort", close, { once: true });
        void (async () => {
          await Promise.all(states.map((state) => evaluate(state, false)));
          if (closed) return;
          for (const state of states) {
            if (state.hash !== state.mount.knownOutputHash && state.hash) {
              const execution = await engine.execute(state.mount.handle, { input: state.mount.input, user: context.user });
              state.hash = nodeOutputHash(execution.result);
              state.cursor = execution.dependencies.membership.observedThrough;
              emit({ type: "result", id: state.mount.id, observedThrough: state.cursor, outputHash: state.hash, value: execution.result });
            }
          }
          ready = true;
          emit({ type: "ready", queries: states.map((state) => ({
            id: state.mount.id,
            observedThrough: state.cursor,
            ...(state.hash ? { outputHash: state.hash } : {}),
          })) });
          for (const state of states) if (state.dirty) void evaluate(state, true);
        })().catch((error) => {
          if (!closed) controller.error(error);
          stop();
        });
      },
    });
  }
}
