import { USL_LIMITS } from "@ovst/usl";

export const COLLECTION_SCHEMA_SOURCE = "schema.usl";

/** Limits on a collection schema and on validating its rows (spec 06 §2.4). */
export const COLLECTION_SCHEMA_LIMITS = {
  "source-bytes": USL_LIMITS.sourceBytes,
  tokens: USL_LIMITS.tokens,
  "nesting-depth": USL_LIMITS.depth,
  "row-steps": 1_000_000,
  "collection-steps": 50_000_000,
} as const;

export type CollectionSchemaLimit = keyof typeof COLLECTION_SCHEMA_LIMITS;

/**
 * Why a schema was rejected: a USL checker code (`unknown-type`,
 * `duplicate-field`, `limit`, ...) or one of the collection's own.
 */
export type SchemaDiagnosticCode = "invalid-utf8" | "schema-too-large" | "collection-tables" | (string & {});

export interface SourceLocation {
  /** 1-based line. */
  line: number;
  /** 1-based column counted in Unicode scalar values. */
  column: number;
}

export interface SchemaDiagnostic {
  code: SchemaDiagnosticCode;
  message: string;
  location?: SourceLocation;
  limit?: CollectionSchemaLimit;
}

export type ValueDiagnosticCode =
  | "type-mismatch"
  | "no-matching-choice"
  | "unknown-member"
  | "missing-member"
  | "invalid-text"
  | "budget-exceeded"
  | "csv-duplicate-column"
  | "csv-invalid-cell"
  | "csv-invalid-row"
  | "csv-unrepresentable-value";

export interface ValueDiagnostic {
  code: ValueDiagnosticCode;
  message: string;
  /** JSON Pointer (RFC 6901) to the failing value; "" is the row itself. */
  path: string;
  limit?: CollectionSchemaLimit;
}

/** A schema the profile rejects. `diagnostics[0]` is the deterministic first failure. */
export class CollectionSchemaError extends Error {
  constructor(readonly diagnostics: readonly SchemaDiagnostic[]) {
    const first = diagnostics[0];
    const where = first?.location ? ` at ${first.location.line}:${first.location.column}` : "";
    super(first ? `${first.code}${where}: ${first.message}` : "Invalid collection schema");
    this.name = "CollectionSchemaError";
  }

  get code(): SchemaDiagnosticCode {
    return this.diagnostics[0]?.code ?? "syntax-error";
  }
}

export function schemaFailure(
  code: SchemaDiagnosticCode,
  message: string,
  location?: SourceLocation,
  limit?: CollectionSchemaLimit,
): CollectionSchemaError {
  return new CollectionSchemaError([{ code, message, ...(location ? { location } : {}), ...(limit ? { limit } : {}) }]);
}

export function pointer(parent: string, segment: string | number): string {
  return `${parent}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
