// Beetle, the views-and-data language (.beetle, spec 1.5): parser, formatter and checker for
// tables, views, rules, state tables and mutations. A collection's schema.beetle checks
// through @ovst/usl, so its layout, fingerprint and setup SQL are USL's.

export * from "./ast.ts";
export { parseView, ViewSyntaxError, COMPREHENSION_FUNCTIONS, type ParseResult } from "./parse.ts";
export { formatView, FormatError } from "./fmt.ts";
export { viewBlocks, pageSource, formatPage, type ViewBlock, type PageSource } from "./blocks.ts";
export { compileSchema, uslFileOf, type SchemaResult } from "./schema.ts";
export {
  checkView,
  resolvePath,
  isSchemaPath,
  BUILTIN_NAMES,
  BUILTIN_FUNCTIONS,
  type CheckOptions,
  type ViewCheck,
  type CheckedView,
  type CheckedMutation,
  type CheckedParam,
  type Write,
} from "./check.ts";
export type { DataPlan, DataPlanEntry, ElementPlan, OrderPlan, PlanExpr } from "./plan.ts";

import type { Diagnostic } from "./ast.ts";

/** The file extension of Beetle files. */
export const BEETLE_EXTENSION = ".beetle";

export function formatDiagnostic(path: string, d: Diagnostic): string {
  return `${d.path ?? path}:${d.line}:${d.column}: ${d.code}: ${d.message}`;
}
export { compileProgram, type Program } from "./check.ts";
export { Evaluator, BeetleError, Action, display, toJSON, toProp, type Value, type ViewNode, type EvalContext, type BoundRows } from "./eval.ts";
export { runMutation, type MutationOptions, type MutationOutcome } from "./mutate.ts";
export { Store, StoreSchema, Row, EnumValue, derivedID, canonical, type PersonFields, type RowQuery } from "./store.ts";
