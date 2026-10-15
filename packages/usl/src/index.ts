// Ultimate Schema Language (.usl): parser and checker.

export * from "./ast.ts";
export { parseUsl, UslSyntaxError, USL_LIMITS, type ParseResult } from "./parse.ts";
export { layoutOf, LayoutError, type Column, type ColumnType, type ForeignKey, type JoinEnd, type StoredField, type Table } from "./layout.ts";
export {
  rowOf,
  recordOf,
  joinRowsOf,
  rowsFromRecords,
  recordsFromRows,
  type StoredRecord,
  type RecordsByModel,
  type RowsByTable,
  type RecordOptions,
} from "./records.ts";
export { setupSql, columnType, SQL_TYPES, type Dialect, type SetupOptions } from "./sql.ts";
export { validateRow, fitsColumn, fromCell, type RowDiagnostic } from "./rows.ts";
export { typeDeclarations } from "./types.ts";
export { relationshipsOf, PERSON_RELATION, type Relationship } from "./relationships.ts";
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
  type ResolvedView,
  type LineItem,
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
export {
  presentView,
  viewEdits,
  viewsOf,
  presentedModel,
  applyRowEdits,
  checkRows,
  checkFieldValue,
  firstParagraph,
  rowKey,
  ViewError,
  type Presentation,
  type PresentedGroup,
  type PresentedLine,
  type PresentOptions,
  type Cell,
  type Chip,
  type GroupKind,
  type RowCapabilities,
  type RowEdit,
  type RowsDiagnostic,
  type ViewIntent,
} from "./present.ts";
