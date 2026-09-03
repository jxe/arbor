import type { Diagnostic, SearchResult } from "./types.ts";
import { canonicalCBORHash } from "./cbor.ts";
import type { JSONValue, NodeRef, NodeSnapshot } from "./node-model.ts";
import type { ContentRevision, DirectoryRevision, EventCursor, Hash, LogicalPath, TreeID, TreeRef } from "./identifiers.ts";



export interface QueryHandleRef {
  tree: TreeID;
  module: LogicalPath;
  export: string;
  version: string;
}

export type MutationHandleRef = QueryHandleRef;

export interface QueryStreamDocumentRef {
  tree: TreeID;
  path: LogicalPath;
  version: string;
}

export interface QueryStreamMount {
  id: string;
  handle: QueryHandleRef;
  input?: unknown;
  knownOutputHash?: Hash;
}

export interface QueryStreamRequest {
  document: QueryStreamDocumentRef;
  queries: QueryStreamMount[];
}

export type QueryStreamEvent =
  | { type: "result"; id: string; observedThrough: EventCursor; outputHash: Hash; value: unknown }
  | { type: "result"; id: string; observedThrough: EventCursor; error: { code: string; message: string; retryable: boolean } }
  | { type: "ready"; queries: Array<{ id: string; observedThrough: EventCursor; outputHash?: Hash }> }
  | { type: "reload"; reason: "source-changed" | "access-changed" };

/** Server-side adapter shared by Local REST and tree-scoped Arbor Wire queries. */
export interface QueryStreamRuntime {
  stream(
    request: QueryStreamRequest,
    context: { signal: AbortSignal; user: { profile: string } | null },
  ): ReadableStream<QueryStreamEvent> | Promise<ReadableStream<QueryStreamEvent>>;
}

export interface MutationCallRequest {
  document: QueryStreamDocumentRef;
  handle: MutationHandleRef;
  mutationID: string;
  input: unknown;
}

export interface MutationResultReceipt<Result = unknown> {
  mutationID: string;
  requestDigest: Hash;
  observedThrough: EventCursor;
  result: Result;
}

/** Transport-neutral callable boundary; React/HTTP adaptation is owned later. */
export interface MutationCallRuntime {
  call(
    request: MutationCallRequest,
    context: { user: { profile: string } | null },
  ): Promise<MutationResultReceipt>;
}

/**
 * The tree dimension of a reference: which scope it resolves in.
 * Values are `"local"` (the degenerate filesystem scope; paths are
 * OS-absolute), `"system"` (the control scope), or a stable shared
 * `TreeID`. The scope is always explicit; there is no omitted-tree default.
 */
export type AccessLevel = "none" | "read" | "write";
export type ReadWriteAccess = Exclude<AccessLevel, "none">;
export type TreeKind = "ordinary" | "account-configuration";

export type AccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID }
  | { kind: "link"; digest: Hash };

export interface AccessRule {
  subject: AccessSubject;
  access: ReadWriteAccess;
}

export type SafeAccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID; locator?: string }
  | { kind: "link" };

export interface AccessEntry {
  id: string;
  subject: SafeAccessSubject;
  access: ReadWriteAccess;
}


export interface TreeDescriptor {
  id: TreeID;
  kind: TreeKind;
  access: AccessLevel;
  canonical: {
    path: LogicalPath;
    endpoint: string;
    parentTree: TreeID | null;
  } | null;
}

export type CanonicalTreeDescriptor = NonNullable<TreeDescriptor["canonical"]>;

/** Percent-encode a decoded canonical path segment by segment; the root encodes as `""`. */
function encodedCanonicalPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length ? `/${segments.map(encodeURIComponent).join("/")}` : "";
}

/** The public HTTP URL of a canonical tree: the endpoint's origin followed by its encoded path. */
export function canonicalHTTPURL(canonical: Pick<CanonicalTreeDescriptor, "path" | "endpoint">): string {
  return `${new URL(canonical.endpoint).origin}${encodedCanonicalPath(canonical.path) || "/"}`;
}

/** The `arbor://` locator of a canonical tree: the endpoint's host followed by its encoded path. */
export function canonicalArborLocator(canonical: Pick<CanonicalTreeDescriptor, "path" | "endpoint">): string {
  return `arbor://${new URL(canonical.endpoint).host}${encodedCanonicalPath(canonical.path) || "/"}`;
}

export interface LocalTreeDescriptor extends TreeDescriptor {
  /** Account routing identity for hosted and configuration trees. */
  configurationTree?: TreeID;
  name: string;
  osPath?: string;
  placement: "placed" | "replica" | "remote";
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error";
  missing?: boolean;
}

export interface RemoteTreeDescriptor extends TreeDescriptor {
  /** The bytes hash of the current accepted tree state: the wire root. */
  root: Hash;
  update: string;
}

/** Deployment/placement context carried by local and Canopy node responses. */
export interface NodeResponse extends NodeSnapshot {
  enclosingTree?: LocalTreeDescriptor;
}

export interface SearchPage {
  results: SearchResult[];
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface BacklinkEntry {
  ref: NodeRef;
  title: string;
  context: string;
}

export interface BacklinksPage {
  target: NodeRef;
  entries: BacklinkEntry[];
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface BlockRecoveryEntry {
  kind: "block";
  ref: NodeRef;
  hash: string;
  markdown: string;
  parent: string | null;
  status: "lost" | "purged";
  changedAt: number;
}

export interface TrashRecoveryEntry {
  kind: "trash";
  ref: NodeRef;
  originalPath: LogicalPath;
  /** Physical recovery classification, not a logical node kind. */
  nodeKind: "markdown" | "directory" | "file";
  changedAt: number;
}

export type RecoveryEntry = BlockRecoveryEntry | TrashRecoveryEntry;

export interface RecoveryPage {
  ref: NodeRef;
  entries: RecoveryEntry[];
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface LocatorResolution {
  ref: NodeRef;
  enclosingTree?: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
}

export interface SnapshotEnvelope<T> {
  snapshot: T;
  observedThrough: EventCursor;
}

/** One simultaneous UTF-8 byte replacement against an exact source revision. */
export interface SourceEdit {
  offset: number;
  length: number;
  replacement: string;
  expected?: string;
}

export class SourceEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceEditError";
  }
}

/** Apply guarded, ordered source edits without ever indexing JavaScript UTF-16. */
export function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
  const original = new TextEncoder().encode(source);
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  let size = 0;
  for (const [index, edit] of edits.entries()) {
    if (
      !Number.isSafeInteger(edit.offset)
      || !Number.isSafeInteger(edit.length)
      || edit.offset < cursor
      || edit.length < 0
      || edit.offset > original.length
      || edit.length > original.length - edit.offset
    ) {
      throw new SourceEditError(`sourceEdits[${index}] has an invalid or overlapping UTF-8 range`);
    }
    const unchanged = original.subarray(cursor, edit.offset);
    chunks.push(unchanged);
    size += unchanged.length;
    const replaced = original.subarray(edit.offset, edit.offset + edit.length);
    if (edit.expected !== undefined) {
      const expected = new TextEncoder().encode(edit.expected);
      if (expected.length !== replaced.length || expected.some((byte, offset) => byte !== replaced[offset])) {
        throw new SourceEditError(`sourceEdits[${index}] expected bytes do not match the current source`);
      }
    }
    const replacement = new TextEncoder().encode(edit.replacement);
    chunks.push(replacement);
    size += replacement.length;
    cursor = edit.offset + edit.length;
  }
  const tail = original.subarray(cursor);
  chunks.push(tail);
  size += tail.length;
  const result = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result);
  } catch {
    throw new SourceEditError("sourceEdits produce invalid UTF-8");
  }
}

export type ContentWorkspaceOperation =
  | {
    op: "writeProperties";
    ref: NodeRef;
    basePropertiesRevision: string;
    /** Complete candidate property map; omitted keys are deletions. */
    properties: Record<string, JSONValue>;
  }
  | {
    op: "writeText";
    ref: NodeRef;
    baseContentRevision: ContentRevision;
    source: string;
  }
  | {
    op: "writeMarkdown";
    ref: NodeRef;
    baseContentRevision: ContentRevision;
    source: string;
    /** Optional editor provenance; the complete `source` remains authoritative. */
    sourceEdits?: SourceEdit[];
  }
  | {
    op: "restoreRecovery";
    ref: NodeRef;
    hash: string;
    baseContentRevision?: ContentRevision;
  }
  | {
    op: "ensureDocumentIdentity";
    ref: NodeRef;
    baseContentRevision: ContentRevision;
  };

export type StructuralWorkspaceOperation =
  | { op: "createDirectory"; tree: TreeRef; path: LogicalPath }
  | { op: "createMarkdown"; tree: TreeRef; path: LogicalPath; source?: string }
  | { op: "rename"; ref: NodeRef; name: string }
  | {
    op: "move";
    refs: NodeRef[];
    destination: NodeRef;
  }
  | { op: "copy"; refs: NodeRef[]; destination: NodeRef }
  | { op: "trash"; refs: NodeRef[] }
  | { op: "restore"; refs: NodeRef[] };

export type WorkspaceOperation = ContentWorkspaceOperation | StructuralWorkspaceOperation;

export interface ContentMutationRequest {
  mutationID: string;
  operations: [ContentWorkspaceOperation];
}

export interface StructuralMutationRequest {
  mutationID: string;
  operations: [StructuralWorkspaceOperation, ...StructuralWorkspaceOperation[]];
}

export type MutationRequest = ContentMutationRequest | StructuralMutationRequest;

export type MutationEffectKind = "created" | "updated" | "moved" | "deleted";

export interface MutationEffect {
  kind: MutationEffectKind;
  ref: NodeRef;
  previousPath?: LogicalPath;
  contentRevision?: ContentRevision;
  propertiesRevision?: string;
  /** Exact property names changed when the provider can prove them; omission widens invalidation. */
  changedProperties?: string[];
  directoryRevision?: DirectoryRevision;
}

export interface MutationReceipt {
  mutationID: string;
  observedThrough: EventCursor;
  effects: MutationEffect[];
}

export type WorkspaceEventOrigin = "api" | "external" | "recovery" | "sync";

export interface WorkspaceChange {
  ref: NodeRef;
  previousPath?: LogicalPath;
  contentRevision?: ContentRevision;
  propertiesRevision?: string;
  /** Exact property names changed when the provider can prove them; omission widens invalidation. */
  changedProperties?: string[];
  directoryRevision?: DirectoryRevision;
  origin: WorkspaceEventOrigin;
  mutationID?: string;
}

export type WorkspaceEvent = ObservationEvent<MutationEffectKind | "diagnostic", WorkspaceChange>;

export type ArborErrorCode =
  | "invalid-request"
  | "unauthenticated"
  | "permission-denied"
  | "conflict"
  | "not-found"
  | "read-only"
  | "unsupported-operation"
  | "resync-required"
  | "rate-limited"
  | "quota-exceeded"
  | "internal-error"
  | "already-claimed"
  | (string & {});

/** The single error envelope shared by Arbor Wire and the local REST surface. */
export interface ArborError<TDetails = unknown> {
  error: ArborErrorCode;
  message: string;
  retryable: boolean;
  tree?: TreeRef;
  path?: LogicalPath;
  details?: TDetails;
}

export interface ObservationEvent<TKind extends string = string, TChange = unknown> {
  cursor: EventCursor;
  tree: TreeRef;
  kind: TKind;
  change: TChange;
}

/**
 * Deterministic JSON text for local equality comparison and private receipts.
 * It is not a wire identity: every hashed identity uses `canonicalCBORHash`.
 */
export function stableJSONString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSONString).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSONString(record[key])}`)
    .join(",")}}`;
}

/**
 * Hashes the canonical, semantic identity of a retryable request. Transport
 * details must be removed by the caller before constructing this value.
 */
export function semanticRequestDigest(identity: unknown): Hash {
  return canonicalCBORHash(identity);
}
