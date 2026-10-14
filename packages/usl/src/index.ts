// Ultimate Schema Language (.usl): parser and checker.

export * from "./ast.ts";
export { parseUsl, UslSyntaxError, type ParseResult } from "./parse.ts";
export {
  checkUsl,
  BUILTIN_MODELS,
  IMPLICIT_FIELDS,
  VALUE_TYPES,
  type CheckResult,
  type ResolvedConnection,
  type ResolvedField,
  type ResolvedModel,
  type Storage,
} from "./check.ts";

import type { Diagnostic } from "./ast.ts";
import { checkUsl, type CheckResult } from "./check.ts";
import { parseUsl } from "./parse.ts";

/** Parses and checks a .usl source. A syntax error stops before checking. */
export function compileUsl(source: string): CheckResult {
  const parsed = parseUsl(source);
  if (!parsed.file) return { diagnostics: parsed.diagnostics, models: [], connections: [] };
  return checkUsl(parsed.file);
}

export function formatDiagnostic(path: string, d: Diagnostic): string {
  return `${path}:${d.line}:${d.column}: ${d.code}: ${d.message}`;
}
