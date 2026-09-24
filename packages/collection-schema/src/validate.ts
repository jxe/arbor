import { COLLECTION_SCHEMA_LIMITS, pointer, type CollectionSchemaLimit, type ValueDiagnostic } from "./diagnostics.ts";
import { literalKey, type Check, type CollectionSchema } from "./compile.ts";

const MAX_DIAGNOSTICS = 32;

/** A step allowance shared by every row of one collection file. */
export interface ValidationBudget {
  remaining: number;
}

export function collectionValidationBudget(steps: number = COLLECTION_SCHEMA_LIMITS["collection-steps"]): ValidationBudget {
  return { remaining: steps };
}

class BudgetExceeded extends Error {
  constructor(readonly limit: CollectionSchemaLimit) { super(limit); }
}

interface Context {
  diagnostics: ValueDiagnostic[];
  rowSteps: number;
  rowLimit: number;
  budget: ValidationBudget | undefined;
}

function step(context: Context): void {
  context.rowSteps += 1;
  if (context.rowSteps > context.rowLimit) throw new BudgetExceeded("row-steps");
  if (context.budget) {
    context.budget.remaining -= 1;
    if (context.budget.remaining < 0) throw new BudgetExceeded("collection-steps");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

/** A value location, materialized as a JSON Pointer only when a diagnostic needs it. */
type Path = { parent: Path; segment: string | number } | null;

function materialize(path: Path): string {
  const segments: Array<string | number> = [];
  for (let at = path; at; at = at.parent) segments.push(at.segment);
  return segments.reverse().reduce<string>((parent, segment) => pointer(parent, segment), "");
}

function report(context: Context | null, code: ValueDiagnostic["code"], path: Path, message: string): false {
  if (context && context.diagnostics.length < MAX_DIAGNOSTICS) context.diagnostics.push({ code, path: materialize(path), message });
  return false;
}

/**
 * Validate one value. With `context` null this is a pure match used for
 * choice alternatives; otherwise failures are recorded in deterministic order.
 */
function check(node: Check, value: unknown, path: Path, context: Context, collect: boolean): boolean {
  step(context);
  const sink = collect ? context : null;
  switch (node.kind) {
    case "text":
      if (typeof value !== "string") return report(sink, "type-mismatch", path, "Expected text");
      return wellFormed(value) || report(sink, "invalid-text", path, "Text contains an unpaired surrogate");
    case "text-literal":
      if (typeof value !== "string") return report(sink, "type-mismatch", path, `Expected ${JSON.stringify(node.value)}`);
      if (!wellFormed(value)) return report(sink, "invalid-text", path, "Text contains an unpaired surrogate");
      return value === node.value || report(sink, "type-mismatch", path, `Expected ${JSON.stringify(node.value)}`);
    case "bool":
      return typeof value === "boolean" || report(sink, "type-mismatch", path, "Expected a boolean");
    case "bool-literal":
      return value === node.value || report(sink, "type-mismatch", path, `Expected ${node.value}`);
    case "null":
      return value === null || report(sink, "type-mismatch", path, "Expected null");
    case "int":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return report(sink, "type-mismatch", path, "Expected an integer within ±(2^53 − 1)");
      return (value >= node.min && value <= node.max) || report(sink, "out-of-range", path, `Expected an integer from ${node.min} to ${node.max}`);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return report(sink, "type-mismatch", path, "Expected a finite number");
      return (value >= node.min && (node.exclusiveMax ? value < node.max : value <= node.max))
        || report(sink, "out-of-range", path, `Expected a number from ${node.min} ${node.exclusiveMax ? "below" : "to"} ${node.max}`);
    case "number-literal":
      return value === node.value || report(sink, "type-mismatch", path, `Expected ${node.value}`);
    case "array": {
      if (!Array.isArray(value)) return report(sink, "type-mismatch", path, "Expected an array");
      if (node.nonEmpty && value.length === 0) return report(sink, "type-mismatch", path, "Expected at least one element");
      let valid = true;
      for (const [index, element] of value.entries()) {
        if (!check(node.element, element, { parent: path, segment: index }, context, collect)) {
          valid = false;
          if (!collect) return false;
        }
      }
      return valid;
    }
    case "map": {
      if (!isPlainObject(value)) return report(sink, "type-mismatch", path, "Expected an object");
      let valid = true;
      for (const member of node.members) {
        step(context);
        if (!Object.hasOwn(value, member.name)) {
          if (!member.optional) {
            valid = false;
            if (!collect) return false;
            report(sink, "missing-member", { parent: path, segment: member.name }, `Missing required member ${JSON.stringify(member.name)}`);
          }
          continue;
        }
        if (!check(member.check, value[member.name], { parent: path, segment: member.name }, context, collect)) {
          valid = false;
          if (!collect) return false;
        }
      }
      for (const key of Object.keys(value)) {
        step(context);
        if (node.byName.has(key)) continue;
        valid = false;
        if (!collect) return false;
        report(sink, "unknown-member", { parent: path, segment: key }, `Member ${JSON.stringify(key)} is not declared`);
      }
      return valid;
    }
    case "choice": {
      if (node.literals) {
        if ((typeof value === "string" || typeof value === "number") && node.literals.has(literalKey(value))) return true;
        return report(sink, "no-matching-choice", path, "Value matches none of the declared alternatives");
      }
      for (const alternative of node.alternatives) {
        if (check(alternative, value, path, context, false)) return true;
      }
      return report(sink, "no-matching-choice", path, "Value matches none of the declared alternatives");
    }
  }
}

/**
 * Validate one row against `row`. Validation is a decision only: it never
 * inserts defaults, removes fields, or transforms values.
 */
export function validateRow(
  schema: CollectionSchema,
  value: unknown,
  budget?: ValidationBudget,
  rowLimit: number = COLLECTION_SCHEMA_LIMITS["row-steps"],
): ValueDiagnostic[] {
  const context: Context = { diagnostics: [], rowSteps: 0, rowLimit, budget };
  try {
    check(schema.row, value, null, context, true);
    return context.diagnostics;
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    return [{
      code: "budget-exceeded",
      path: "",
      limit: error.limit,
      message: error.limit === "row-steps"
        ? `Validating the row exceeds ${rowLimit} steps`
        : "Validating the collection file exceeds its step budget",
    }];
  }
}
