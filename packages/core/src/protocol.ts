import type {
  CollectionPage,
  CollectionSummary,
  Diagnostic,
  MarkdownDocument,
  SearchResult,
  TreeChild,
} from "./types.ts";

export type LogicalPath = string;
export type PageID = string;
export type ContentRevision = string;
export type DirectoryRevision = string;
export type EventCursor = string;
export type Hash = `sha256:${string}`;

/**
 * The tree dimension of a reference: which scope it resolves in.
 * Values are `"local"` (the degenerate filesystem scope; paths are
 * OS-absolute), `"system"` (the control scope), or a stable shared
 * `TreeID`. The scope is always explicit; there is no omitted-tree default.
 */
export type TreeRef = "local" | "system" | TreeID;
export type TreeID = string;
export type AccessLevel = "none" | "read" | "write";
export type ReadWriteAccess = Exclude<AccessLevel, "none">;
export type TreeKind =
  | "community-profile"
  | "person-profile"
  | "group-profile"
  | "shared-subtree"
  | "account-configuration";

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

export const LOCAL_TREE: TreeRef = "local";
export const SYSTEM_TREE: TreeRef = "system";

export type NodeRef =
  | { tree: TreeRef; path: LogicalPath }
  | { tree: TreeRef; pageID: PageID; pathHint?: LogicalPath };

export interface ResolvedNodeRef {
  tree: TreeRef;
  path: LogicalPath;
  pageID?: PageID;
}

export interface TreeDescriptor {
  id: TreeID;
  kind: TreeKind;
  access: AccessLevel;
  canonical: {
    locator: string;
    path: LogicalPath;
    endpoint: string;
    httpURL: string;
    parentTree: TreeID | null;
  } | null;
}

export interface LocalTreeDescriptor extends TreeDescriptor {
  name: string;
  osPath?: string;
  placement: "placed" | "replica" | "remote";
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error";
  missing?: boolean;
}

export interface RemoteTreeDescriptor extends TreeDescriptor {
  ref: Hash;
  update: string;
}

export type ProtocolNodeKind = "markdown" | "directory" | "collection" | "database" | "file";

export interface NodeSnapshot {
  ref: ResolvedNodeRef;
  /** Scope the snapshot resolved in, after canonicalization into an owning root. */
  tree: TreeRef;
  /** The enclosing durable or migration tree, when applicable. */
  enclosingTree?: LocalTreeDescriptor;
  /** Canonical-path convenience field used by hand-maintained clients. */
  path: LogicalPath;
  name: string;
  kind: ProtocolNodeKind;
  writable: boolean;
  materialization: "available" | "placeholder";
  contentRevision?: ContentRevision;
  directoryRevision?: DirectoryRevision;
  /** Whether `document` reflects stored bytes or an implicit (bodyless) directory. */
  bodyState?: "stored" | "implicit";
  /** Which physical representation supplies a stored body. Diagnostic only. */
  bodyOrigin?: "sibling" | "index";
  document?: MarkdownDocument;
  collection?: CollectionSummary;
  diagnostics: Diagnostic[];
  observedThrough: EventCursor;
  /** Ergonomic client field. The wire node response omits this and uses /v1/children. */
  children?: TreeChild[];
}

export interface ChildrenPage {
  parent: ResolvedNodeRef;
  items: TreeChild[];
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface SearchPage {
  results: Array<SearchResult & { pageID?: PageID }>;
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface BacklinkEntry {
  ref: ResolvedNodeRef;
  title: string;
  context: string;
}

export interface BacklinksPage {
  target: ResolvedNodeRef;
  entries: BacklinkEntry[];
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface CollectionResultPage extends CollectionPage {
  observedThrough: EventCursor;
}

export interface BlockRecoveryEntry {
  kind: "block";
  ref: ResolvedNodeRef;
  hash: string;
  markdown: string;
  parent: string | null;
  status: "lost" | "purged";
  changedAt: number;
}

export interface TrashRecoveryEntry {
  kind: "trash";
  ref: ResolvedNodeRef;
  originalPath: LogicalPath;
  nodeKind: ProtocolNodeKind;
  changedAt: number;
}

export type RecoveryEntry = BlockRecoveryEntry | TrashRecoveryEntry;

export interface RecoveryPage {
  ref: ResolvedNodeRef;
  entries: RecoveryEntry[];
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface LocatorResolution {
  ref: ResolvedNodeRef;
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
  /** Scope the effect landed in. Present from milestone 3 on. */
  tree: TreeRef;
  path: LogicalPath;
  previousPath?: LogicalPath;
  pageID?: PageID;
  contentRevision?: ContentRevision;
  directoryRevision?: DirectoryRevision;
}

export interface MutationReceipt {
  mutationID: string;
  observedThrough: EventCursor;
  effects: MutationEffect[];
}

export type WorkspaceEventOrigin = "api" | "external" | "recovery" | "sync";

export interface WorkspaceChange {
  path: LogicalPath;
  previousPath?: LogicalPath;
  pageID?: PageID;
  contentRevision?: ContentRevision;
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
  | "tree-id-conflict"
  | (string & {});

export type ArborSyncErrorCode = ArborErrorCode;

export interface ArborSyncErrorValue {
  error: ArborErrorCode;
  message: string;
  retryable: boolean;
  tree?: TreeRef;
  path?: LogicalPath;
  details?: unknown;
}

export interface ArborSyncErrorEnvelope {
  error: ArborErrorCode;
  message: string;
  retryable: boolean;
  tree?: TreeRef;
  path?: LogicalPath;
  details?: unknown;
}

export type ArborError<TDetails = unknown> = Omit<ArborSyncErrorEnvelope, "details"> & { details?: TDetails };

export interface ObservationEvent<TKind extends string = string, TChange = unknown> {
  cursor: EventCursor;
  tree: TreeRef;
  kind: TKind;
  change: TChange;
}

export function canonicalJSONString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSONString).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJSONString(record[key])}`)
    .join(",")}}`;
}
