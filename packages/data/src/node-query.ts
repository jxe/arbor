import type { ChildrenPage, NodeRef, NodeSnapshot, NodeSummary } from "@arbor/core";
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
