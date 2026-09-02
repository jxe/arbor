import type {
  ChildRepresentationSummary,
  Diagnostic,
  Hash,
  IdentityRule,
  JSONValue,
  NodeSnapshot,
  TreeRef,
} from "@arbor/core";
import { canonicalJSONString, revisionOf, sha256 } from "@arbor/core";
export type ProjectionProviderKind = "csv" | "json" | "jsonl" | "markdown" | "sqlite" | "postgres";
/** Provider discovery metadata, already expressed in the public representation vocabulary. */
export interface ProjectionDescriptor {
  columns: string[];
  identityRule?: IdentityRule;
  revision?: string;
  schemaRevision?: string;
  modelDigest?: string;
  diagnostics?: Diagnostic[];
  editable: boolean;
  representation: ChildRepresentationSummary;
  total?: number;
  tables?: string[];
  rowContent?: "markdown";
}
/** A validated provider record before it is projected as a public NodeSnapshot. */
export interface ProviderChildRecord {
  key: string;
  path: string;
  stableKey: string | null;
  revision?: string;
  values: Record<string, unknown>;
  diagnostics: Diagnostic[];
}
export interface ProjectionDefinition {
  provider: ProjectionProviderKind;
  schemaPath?: string;
  storePath?: string;
  markdownPaths?: string[];
  diagnostics: Diagnostic[];
}
export interface ProjectionProviderContext {
  tree: TreeRef;
  observedThrough: string;
  writable: boolean;
  readPhysical?: (path: string) => Promise<NodeSnapshot>;
}
/** Opaque to Arbor Sync: only ProjectionProviderHost dispatches on provider. */
export interface ProjectionWriteTarget {
  directory: string;
  parentPath: string;
  storage: "physical" | "provider";
  table?: string;
  path: string;
  stableKey: string | null;
  revision: string;
  sourceRevision?: string;
  properties: Record<string, JSONValue>;
  identityRule?: { properties: string[] };
  writable: boolean;
}
export interface PreparedProviderPropertyWrite {
  durability: "host-journal" | "provider-transaction";
  path: string;
  stableKey: string;
  revision?: string;
  properties: Record<string, JSONValue>;
  commit(): Promise<ProviderPropertyWriteResult>;
  abort(): Promise<void>;
}
export type ProjectionPropertyPreparation =
  | {
    storage: "physical";
    properties: Record<string, JSONValue>;
    identityRule?: { properties: string[] };
  }
  | { storage: "provider"; write: PreparedProviderPropertyWrite };
export interface ProviderPropertyWriteResult {
  path: string;
  stableKey: string;
  revision: string;
  properties: Record<string, JSONValue>;
}
export interface ProjectionRowResolution {
  row: ProviderChildRecord;
  page: LoadedProjectionSlice;
}
/**
 * One storage driver behind the projection host. A driver registers the
 * provider kinds it serves; optional members are absent when a driver cannot
 * support them, and the session then answers read-only or null instead of
 * dispatching on the kind.
 */
export interface ProjectionProvider {
  readonly kinds: readonly ProjectionProviderKind[];
  describe(definition: ProjectionDefinition): Promise<ProjectionDescriptor>;
  /** Table subtrees of a database-shaped projection. */
  describeTable?(definition: ProjectionDefinition, table: string): Promise<ProjectionDescriptor | null>;
  page(
    definition: ProjectionDefinition,
    treePath: string,
    cursor: string | null,
    limit: number,
    table?: string,
  ): Promise<LoadedProjectionSlice>;
  resolve?(
    definition: ProjectionDefinition,
    parentPath: string,
    ref: { path: string; stableKey: string | null },
    table?: string,
  ): Promise<ProjectionRowResolution | null>;
  /** Where a row's properties live: an authored file, or the provider's own store. */
  rowStorage?(definition: ProjectionDefinition): "physical" | "provider";
  prepareWrite?(
    definition: ProjectionDefinition,
    target: ProjectionWriteTarget,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    mutation: { scope: string; id: string },
  ): Promise<PreparedProviderPropertyWrite>;
  prepareMarkdown?(
    definition: ProjectionDefinition,
    properties: Record<string, JSONValue>,
  ): Promise<{ properties: Record<string, JSONValue>; identityRule?: { properties: string[] } }>;
  fileRollupDescriptor?(definition: ProjectionDefinition, sourceName: string): Promise<{
    codec: "csv" | "json" | "jsonl";
    schema: Hash;
    scope: "children";
    modelDigest: Hash;
  } | null>;
  schema?(definition: ProjectionDefinition): Promise<Record<string, Record<string, string>>>;
  [Symbol.asyncDispose]?(): Promise<void>;
}
export type ProjectionProviderErrorCode =
  | "invalid-cursor"
  | "stale-properties"
  | "stale-source"
  | "mutation-mismatch"
  | "invalid-write"
  | "constraint"
  | "read-only";
/** Storage-neutral provider failure; adapters map these codes to protocol errors once. */
export class ProjectionProviderError extends Error {
  constructor(
    public readonly code: ProjectionProviderErrorCode,
    message: string,
    public readonly current?: ProviderChildRecord,
  ) {
    super(message);
    this.name = "ProjectionProviderError";
  }
}
export interface LoadedProjectionSlice {
  path: string;
  columns: string[];
  identityRule?: { properties: string[] };
  revision: string;
  sourceRevision?: string;
  schemaRevision: string;
  rows: ProviderChildRecord[];
  nextCursor: string | null;
  diagnostics: Diagnostic[];
  editable: boolean;
  rowContent?: "markdown";
}
interface StoredCursor {
  version: 1;
  query: string;
  revision: string;
  mode: "keyset" | "offset";
  after?: string;
  offset?: number;
}
export function jsonValue(value: unknown): JSONValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: JSONValue[] = [];
    for (const item of value) {
      const converted = jsonValue(item);
      if (converted !== undefined) result.push(converted);
    }
    return result;
  }
  if (value && typeof value === "object") {
    const result: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonValue(item);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }
  return undefined;
}
export function providerDigest(value: unknown): Hash {
  return `sha256:${sha256(canonicalJSONString(value))}`;
}
export function invalidDescriptor(definition: ProjectionDefinition): ProjectionDescriptor {
  return {
    columns: [],
    revision: revisionOf(JSON.stringify(definition.diagnostics)),
    schemaRevision: revisionOf("invalid-collection-schema"),
    diagnostics: definition.diagnostics,
    editable: false,
    representation: representationFor(definition.provider),
  };
}
export function representationFor(
  provider: ProjectionProviderKind,
  modelDigest: Hash = providerDigest({ provider }),
  scope: "children" | "subtree" = provider === "sqlite" ? "subtree" : "children",
): ChildRepresentationSummary {
  if (provider === "postgres") return { type: "external", driver: "postgres" };
  if (provider === "markdown") return { type: "expanded" };
  return { type: "rollup", codec: provider, scope, modelDigest };
}
export function encodeProviderCursor(value: StoredCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeProviderCursor(
  cursor: string | null,
  query: string,
  revision: string,
  mode: StoredCursor["mode"],
): StoredCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<StoredCursor>;
    if (value.version !== 1 || value.query !== query || value.revision !== revision || value.mode !== mode) throw new Error();
    if (mode === "keyset" && typeof value.after !== "string") throw new Error();
    if (mode === "offset" && (!Number.isSafeInteger(value.offset) || value.offset! < 0)) throw new Error();
    return value as StoredCursor;
  } catch {
    throw new ProjectionProviderError("invalid-cursor", "The collection cursor is invalid or belongs to another revision");
  }
}
