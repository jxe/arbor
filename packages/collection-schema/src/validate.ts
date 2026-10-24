import { COLLECTION_SCHEMA_LIMITS, pointer, type CollectionSchemaLimit, type ValueDiagnostic } from "./diagnostics.ts";
import type { Check, CollectionSchema } from "./compile.ts";
import { isPersonValue } from "@ovst/usl";

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
 * Validate one value. With `collect` false this only decides, stopping at the
 * first failure; otherwise failures are recorded in deterministic order.
 */
function check(node: Check, value: unknown, path: Path, context: Context, collect: boolean): boolean {
  step(context);
  const sink = collect ? context : null;
  switch (node.kind) {
    case "text":
      if (typeof value !== "string") return report(sink, "type-mismatch", path, "Expected text");
      return wellFormed(value) || report(sink, "invalid-text", path, "Text contains an unpaired surrogate");
    case "person":
      return isPersonValue(value) || report(sink, "type-mismatch", path, "Expected a profile id or contact:<key>");
    case "date":
      if (typeof value !== "string") return report(sink, "type-mismatch", path, "Expected a date");
      return !Number.isNaN(Date.parse(value)) || report(sink, "type-mismatch", path, "Expected an ISO 8601 date");
    case "bool":
      return typeof value === "boolean" || report(sink, "type-mismatch", path, "Expected a boolean");
    case "int":
      return (typeof value === "number" && Number.isSafeInteger(value)) || report(sink, "type-mismatch", path, "Expected an integer within ±(2^53 − 1)");
    case "number":
      return (typeof value === "number" && Number.isFinite(value)) || report(sink, "type-mismatch", path, "Expected a finite number");
    case "array": {
      if (!Array.isArray(value)) return report(sink, "type-mismatch", path, "Expected an array");
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
        if (member.nullable && value[member.name] === null) continue;
        if (!check(member.check, value[member.name], { parent: path, segment: member.name }, context, collect)) {
          valid = false;
          if (!collect) return false;
        }
      }
      // An open map accepts and preserves undeclared members without examining them.
      if (node.open) return valid;
      for (const key of Object.keys(value)) {
        step(context);
        if (node.byName.has(key)) continue;
        valid = false;
        if (!collect) return false;
        report(sink, "unknown-member", { parent: path, segment: key }, `Member ${JSON.stringify(key)} is not declared`);
      }
      return valid;
    }
    case "choice":
      return (typeof value === "string" && node.values.has(value))
        || report(sink, "no-matching-choice", path, `Expected one of ${[...node.values].map((v) => JSON.stringify(v)).join(", ")}`);
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
