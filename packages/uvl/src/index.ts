// UVL, the Ultimate View Language (.view): parser, formatter and checker.
// The language's name appears only in this package's name and docs, so a rename is cheap.

export * from "./ast.ts";
export { parseView, ViewSyntaxError, COMPREHENSION_FUNCTIONS, type ParseResult } from "./parse.ts";
export { formatView, FormatError } from "./fmt.ts";
export { viewBlocks, pageSource, formatPage, type ViewBlock, type PageSource } from "./blocks.ts";
export {
  checkView,
  resolvePath,
  BUILTIN_NAMES,
  BUILTIN_FUNCTIONS,
  type CheckOptions,
  type ViewCheck,
  type CheckedView,
  type CheckedMutation,
  type CheckedParam,
  type Write,
} from "./check.ts";
export type { ElementPlan, OrderPlan, PlanExpr } from "./plan.ts";

import type { Diagnostic } from "./ast.ts";

/** The file extension of view sources. */
export const VIEW_EXTENSION = ".view";

export function formatDiagnostic(path: string, d: Diagnostic): string {
  return `${d.path ?? path}:${d.line}:${d.column}: ${d.code}: ${d.message}`;
}
