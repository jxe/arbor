import { parentNodePath, type ChildrenPage, type NodeRef, type NodeSnapshot, type NodeSummary, type QueryStreamEvent, type WorkspaceEvent } from "@arbor/core";
import { liveQueryStream, type LiveQueryAdapter, type LiveQueryContext, type MountedQuery } from "./live-stream.ts";
import type {
  ArborUser,
  QueryHandle,
} from "./authoring.ts";
import {
  compareUTF8,
  containsRequiredUser,
  evaluateQueryPredicate,
  finishCardinality,
  portableQueryFields,
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

function safeNodeQueryError(error: unknown) {
  const message = error instanceof Error && /input|required|not found|missing|children|bound/i.test(error.message)
    ? error.message
    : "The query could not be evaluated";
  return { code: "invalid-request", message, retryable: false } as const;
}

interface NodeQuerySensitivity {
  source: NodeRef;
  rows: ReadonlySet<string>;
  fields: ReadonlySet<string>;
}

function refIdentity(ref: NodeRef): string {
  return `${ref.tree}\0${ref.stableKey ?? ref.path}`;
}

function containsPath(ancestor: string, path: string): boolean {
  return ancestor === "/" || path === ancestor || path.startsWith(`${ancestor}/`);
}

function nodeSensitivity(
  handle: QueryHandle<unknown, unknown>,
  execution: NodeQueryExecution<unknown>,
): NodeQuerySensitivity {
  return {
    source: execution.dependencies.membership.ref,
    rows: new Set(execution.dependencies.rows.map((row) => refIdentity(row.ref))),
    fields: portableQueryFields(handle.plan),
  };
}

/**
 * Provider-neutral invalidation for an ordinary child query. Membership changes
 * are structural; row updates can be narrowed to the fields the query reads.
 * Missing precision is deliberately conservative.
 */
function nodeEventRelevant(event: WorkspaceEvent, sensitivity?: NodeQuerySensitivity): boolean {
  if (!sensitivity) return true;
  if (event.tree !== sensitivity.source.tree) return false;
  if (event.kind === "diagnostic") return true;
  const change = event.change;
  const currentPath = change.ref.path;
  const previousPath = change.previousPath;
  if (currentPath === sensitivity.source.path || previousPath === sensitivity.source.path) return true;
  if (
    (event.kind === "moved" || event.kind === "deleted")
    && (containsPath(currentPath, sensitivity.source.path)
      || (previousPath ? containsPath(previousPath, sensitivity.source.path) : false))
  ) return true;
  const currentChild = parentNodePath(currentPath) === sensitivity.source.path;
  const previousChild = previousPath ? parentNodePath(previousPath) === sensitivity.source.path : false;
  if (event.kind === "created" || event.kind === "deleted" || event.kind === "moved") {
    return currentChild || previousChild;
  }
  if (!currentChild && !sensitivity.rows.has(refIdentity(change.ref))) return false;
  if (change.changedProperties && !change.changedProperties.some((field) => sensitivity.fields.has(field))) return false;
  return true;
}

/** Race-free sensitivity-aware live execution for any ordinary-node provider. */
export class NodeLiveQueryBroker {
  constructor(
    readonly engine: NodeQueryEngine,
    readonly observations: NodeQueryObservationSource,
  ) {}

  bind(_handle: QueryHandle<unknown, unknown>): void {}

  stream(mounts: readonly MountedQuery[], context: LiveQueryContext): ReadableStream<QueryStreamEvent> {
    const adapter: LiveQueryAdapter<NodeQueryExecution<unknown>, NodeQuerySensitivity, WorkspaceEvent> = {
      currentCursor: () => this.observations.currentCursor(),
      subscribe: (listener) => this.observations.subscribe(listener),
      execute: (mount) => this.engine.execute(mount.handle, { input: mount.input, user: context.user }),
      sensitivity: (mount, execution) => nodeSensitivity(mount.handle, execution),
      relevant: (event, mount, sensitivity) => (!mount.tree || event.tree === mount.tree) && nodeEventRelevant(event, sensitivity),
      result: (execution) => execution.result,
      safeError: safeNodeQueryError,
    };
    return liveQueryStream(mounts, context, adapter);
  }
}
