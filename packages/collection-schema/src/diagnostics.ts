/** The profile version this package implements (spec 06 §2.4). */
export const COLLECTION_SCHEMA_PROFILE = 1;
export const COLLECTION_SCHEMA_SOURCE = "schema.cddl";

/** Normative limits of profile version 1 (spec 06 §2.4.6). */
export const COLLECTION_SCHEMA_LIMITS = {
  "source-bytes": 1_048_576,
  tokens: 65_536,
  rules: 1_024,
  "syntax-nodes": 32_768,
  "nesting-depth": 32,
  "choice-alternatives": 256,
  "map-members": 1_024,
  "expanded-nodes": 100_000,
  "row-steps": 1_000_000,
  "collection-steps": 50_000_000,
  "text-literal-bytes": 4_096,
} as const;

export type CollectionSchemaLimit = keyof typeof COLLECTION_SCHEMA_LIMITS;

export type SchemaDiagnosticCode =
  | "invalid-utf8"
  | "schema-too-large"
  | "invalid-character"
  | "syntax-error"
  | "unsupported-syntax"
  | "unsupported-type"
  | "invalid-literal"
  | "invalid-range"
  | "duplicate-rule"
  | "unknown-rule"
  | "reserved-rule"
  | "rule-cycle"
  | "missing-row"
  | "invalid-row"
  | "duplicate-member"
  | "invalid-metadata"
  | "missing-profile-version"
  | "unsupported-profile-version"
  | "invalid-primary-key"
  | "invalid-child-name"
  | "budget-exceeded";

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
  | "out-of-range"
  | "no-matching-choice"
  | "unknown-member"
  | "missing-member"
  | "invalid-text"
  | "budget-exceeded"
  | "csv-unknown-column"
  | "csv-duplicate-column"
  | "csv-invalid-cell"
  | "csv-invalid-row"
  | "csv-unrepresentable-schema"
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
