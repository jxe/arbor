import type { NodeSummary } from "@arbor/core";
import type {
  ArborUser,
  PredicateExpression,
  QueryHandle,
  QueryPlan,
  SelectionValue,
  StandardSchemaV1,
  ValueExpression,
} from "./authoring.ts";
import { QueryCompileError, QueryInputError, QueryUserRequiredError } from "./sqlite.ts";

export interface NodeQueryChildrenPage {
  items: NodeSummary[];
  nextCursor: string | null;
}

export interface NodeQueryProvider {
  children(sourcePath: string, cursor: string | null): Promise<NodeQueryChildrenPage>;
}

export interface NodeQueryExecution<Result> {
  result: Result;
  dependencies: Array<{ ref: NodeSummary["ref"]; revision: string }>;
}

export interface NodeQueryEngineOptions {
  maxRows?: number;
}

function parameterValue(input: unknown, path: readonly string[]): unknown {
  let value = input;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function runtimeValue(value: ValueExpression, row: NodeSummary, input: unknown, user: ArborUser | null): unknown {
  if (value.kind === "field") return row.properties[value.field];
  if (value.kind === "parameter") return parameterValue(input, value.path);
  if (value.kind === "user") return user?.[value.field] ?? null;
  if (value.kind === "literal") return value.value;
  throw new QueryCompileError("The portable node-query subset does not support aggregates");
}

function evaluatePredicate(value: PredicateExpression | undefined, row: NodeSummary, input: unknown, user: ArborUser | null): boolean {
  if (!value) return true;
  if (value.kind === "logical") {
    return value.operator === "and"
      ? value.operands.every((operand) => evaluatePredicate(operand, row, input, user))
      : value.operands.some((operand) => evaluatePredicate(operand, row, input, user));
  }
  const left = runtimeValue(value.left, row, input, user);
  const right = runtimeValue(value.right, row, input, user);
  if (value.operator === "eq") return left === right;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const asciiLower = (candidate: unknown) => String(candidate).replace(/[A-Z]/g, (character) => character.toLowerCase());
  return asciiLower(left).includes(asciiLower(right));
}

function containsRequiredUser(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { kind?: string }).kind === "user" && (value as { required?: boolean }).required) return true;
  if (Array.isArray(value)) return value.some(containsRequiredUser);
  return Object.values(value).some(containsRequiredUser);
}

function validatePortablePlan(plan: QueryPlan): void {
  if (plan.orderBy.length) throw new QueryCompileError("The portable node-query subset does not support authored ordering");
  if (plan.take !== undefined || plan.after !== undefined || plan.keyBy !== undefined) {
    throw new QueryCompileError("The portable node-query subset supports filtering and field picking only");
  }
  const visitValue = (value: ValueExpression) => {
    if (value.kind === "count") throw new QueryCompileError("The portable node-query subset does not support aggregates");
  };
  const visitPredicate = (value: PredicateExpression) => {
    if (value.kind === "logical") value.operands.forEach(visitPredicate);
    else { visitValue(value.left); visitValue(value.right); }
  };
  if (plan.where) visitPredicate(plan.where);
  for (const selected of Object.values(plan.select)) {
    if (selected.kind !== "field") {
      throw new QueryCompileError("The portable node-query subset selects authored fields only");
    }
  }
}

async function validatedInput<Input>(schema: StandardSchemaV1<Input, Input> | undefined, input: unknown): Promise<Input> {
  if (!schema) return input as Input;
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new QueryInputError(result.issues);
  return result.value;
}

function utf8Compare(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function stableOrder(rows: NodeSummary[]): NodeSummary[] {
  return rows.sort((left, right) => utf8Compare(
    left.ref.stableKey ?? left.ref.path,
    right.ref.stableKey ?? right.ref.path,
  ));
}

function shape(row: NodeSummary, selection: Record<string, SelectionValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(selection).map(([name, selected]) => [name, row.properties[selected.kind === "field" ? selected.field : name]]));
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
    validatePortablePlan(handle.plan);
    const input = await validatedInput(handle.schema, options.input);
    const user = options.user ?? null;
    if (containsRequiredUser(handle.plan) && !user) throw new QueryUserRequiredError();
    const rows: NodeSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.provider.children(handle.source.path, cursor);
      rows.push(...page.items);
      if (rows.length > this.maxRows) throw new QueryCompileError(`Node query exceeds its ${this.maxRows}-row execution bound`);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new QueryCompileError("Node provider repeated a children cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);

    const matched = stableOrder(rows.filter((row) => evaluatePredicate(handle.plan.where, row, input, user)));
    const shaped = matched.map((row) => shape(row, handle.plan.select));
    let result: unknown;
    if (handle.plan.cardinality === "many") result = shaped;
    else {
      if (shaped.length > 1) throw new QueryCompileError(`query.${handle.plan.cardinality} returned more than one node`);
      if (handle.plan.cardinality === "one" && shaped.length !== 1) throw new QueryCompileError("query.one returned no node");
      result = shaped[0] ?? null;
    }
    return {
      result: result as Result,
      dependencies: rows.map((row) => ({ ref: row.ref, revision: row.revision })),
    };
  }
}
