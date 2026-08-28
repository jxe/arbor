import type {
  ArborUser,
  PredicateExpression,
  QueryCardinality,
  QueryPlan,
  SelectionValue,
  StandardSchemaV1,
  ValueExpression,
} from "./authoring.ts";
import { stableKeyFromProperties } from "@arbor/core";

export class QueryCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryCompileError";
  }
}

export class QueryInputError extends Error {
  constructor(readonly issues: readonly { message: string; path?: readonly unknown[] }[]) {
    super(issues.map((issue) => issue.message).join("; ") || "Invalid query input");
    this.name = "QueryInputError";
  }
}

export class QueryUserRequiredError extends Error {
  constructor() {
    super("This query requires an Arbor user");
    this.name = "QueryUserRequiredError";
  }
}

export interface QueryValueContext {
  input: unknown;
  user: ArborUser | null;
}

export function parameterValue(input: unknown, path: readonly string[]): unknown {
  let value = input;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function runtimeQueryValue(
  value: ValueExpression,
  row: Record<string, unknown>,
  context: QueryValueContext,
): unknown {
  if (value.kind === "field") return row[value.field];
  if (value.kind === "parameter") return parameterValue(context.input, value.path);
  if (value.kind === "user") return context.user?.[value.field] ?? null;
  if (value.kind === "literal") return value.value;
  return row[`__aggregate_${value.id}`];
}

function asciiLower(value: unknown): string {
  return String(value).replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function evaluateQueryPredicate(
  predicate: PredicateExpression | undefined,
  row: Record<string, unknown>,
  context: QueryValueContext,
): boolean {
  if (!predicate) return true;
  if (predicate.kind === "logical") {
    return predicate.operator === "and"
      ? predicate.operands.every((operand) => evaluateQueryPredicate(operand, row, context))
      : predicate.operands.some((operand) => evaluateQueryPredicate(operand, row, context));
  }
  const left = runtimeQueryValue(predicate.left, row, context);
  const right = runtimeQueryValue(predicate.right, row, context);
  if (predicate.operator === "eq") return left === right;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return asciiLower(left).includes(asciiLower(right));
}

export function containsRequiredUser(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { kind?: string }).kind === "user" && (value as { required?: boolean }).required) return true;
  if (Array.isArray(value)) return value.some(containsRequiredUser);
  return Object.entries(value).some(([key, child]) => key !== "schema" && containsRequiredUser(child));
}

export async function validateQueryInput<Input>(
  schema: StandardSchemaV1<Input, Input> | undefined,
  input: unknown,
): Promise<Input | undefined> {
  if (!schema) {
    if (input !== undefined) throw new QueryInputError([{ message: "This query does not accept input" }]);
    return undefined;
  }
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new QueryInputError(result.issues);
  return result.value;
}

export function compareQueryValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return compareUTF8(String(left), String(right));
}

export function compareUTF8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function isPortableNodePlan(plan: QueryPlan): boolean {
  try {
    validatePortableNodePlan(plan);
    return true;
  } catch (error) {
    if (error instanceof QueryCompileError) return false;
    throw error;
  }
}

export function sortPortablePropertyRows(
  rows: Record<string, unknown>[],
  identityProperties: readonly string[],
): Record<string, unknown>[] {
  return rows.sort((left, right) => {
    const leftKey = stableKeyFromProperties(identityProperties, left);
    const rightKey = stableKeyFromProperties(identityProperties, right);
    if (!leftKey || !rightKey) throw new QueryCompileError("Portable query result has a missing stable key");
    return compareUTF8(leftKey, rightKey);
  });
}

export function finishCardinality(
  rows: readonly Record<string, unknown>[],
  cardinality: QueryCardinality,
  noun: "node" | "row",
): unknown {
  if (cardinality === "many") return rows;
  if (rows.length > 1) throw new QueryCompileError(`query.${cardinality} returned more than one ${noun}`);
  if (cardinality === "one" && rows.length !== 1) throw new QueryCompileError(`query.one returned no ${noun}`);
  return rows[0] ?? null;
}

export function shapeQueryRow(
  row: Record<string, unknown>,
  selection: Record<string, SelectionValue>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(selection).map(([name, selected]) => [
    name,
    row[selected.kind === "field" ? selected.field : name],
  ]));
}

/** Property fields whose changes can affect one portable node-query result. */
export function portableQueryFields(plan: QueryPlan): ReadonlySet<string> {
  const fields = new Set<string>();
  const visitValue = (value: ValueExpression) => {
    if (value.kind === "field") fields.add(value.field);
  };
  const visitPredicate = (predicate: PredicateExpression) => {
    if (predicate.kind === "logical") predicate.operands.forEach(visitPredicate);
    else {
      visitValue(predicate.left);
      visitValue(predicate.right);
    }
  };
  if (plan.where) visitPredicate(plan.where);
  for (const selected of Object.values(plan.select)) visitValue(selected as ValueExpression);
  return fields;
}

/** Validate the deliberately small provider-neutral query algebra. */
export function validatePortableNodePlan(plan: QueryPlan): void {
  if (plan.orderBy.length) throw new QueryCompileError("The portable node-query subset does not support authored ordering");
  if (plan.take !== undefined || plan.after !== undefined || plan.keyBy !== undefined) {
    throw new QueryCompileError("The portable node-query subset supports filtering and field picking only");
  }
  const visitValue = (value: ValueExpression) => {
    if (value.kind === "count") throw new QueryCompileError("The portable node-query subset does not support aggregates");
  };
  const visitPredicate = (value: PredicateExpression) => {
    if (value.kind === "logical") {
      if (value.operands.length === 0) throw new QueryCompileError("A logical predicate cannot be empty");
      value.operands.forEach(visitPredicate);
    } else {
      visitValue(value.left);
      visitValue(value.right);
      if (value.operator === "contains" && value.left.kind !== "field") {
        throw new QueryCompileError("contains() requires a node field");
      }
    }
  };
  if (plan.where) visitPredicate(plan.where);
  for (const selected of Object.values(plan.select)) {
    if (selected.kind !== "field") {
      throw new QueryCompileError("The portable node-query subset selects authored fields only");
    }
  }
}
