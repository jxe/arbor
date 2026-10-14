// Ultimate Schema Language (.usl): parser and checker.

export * from "./ast.ts";
export { parseUsl, UslSyntaxError, USL_LIMITS, type ParseResult } from "./parse.ts";
export { layoutOf, LayoutError, type Column, type ColumnType, type ForeignKey, type Table } from "./layout.ts";
export { setupSql, columnType, SQL_TYPES, type Dialect } from "./sql.ts";
export { validateRow, fitsColumn, fromCell, type RowDiagnostic } from "./rows.ts";
export { typeDeclarations } from "./types.ts";
export {
  checkUsl,
  BUILTIN_MODELS,
  IMPLICIT_FIELDS,
  VALUE_TYPES,
  type CheckResult,
  type ResolvedConnection,
  type ResolvedEnd,
  type RowValue,
  type ResolvedField,
  type ResolvedModel,
  type Storage,
} from "./check.ts";

import { createHash } from "node:crypto";
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

/** The schema's revision: SHA-256 of its exact source bytes, as for `schema.cddl`. */
export function uslFingerprint(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
