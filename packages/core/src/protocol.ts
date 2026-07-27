import type {
  ArborBlock,
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

/**
 * The tree dimension of a reference: which scope it resolves in.
 * Local values are a tracked root's opaque `RootID`, `"local"` (the
 * degenerate no-tree filesystem scope; paths are OS-absolute), and
 * `"system"` (the read-only control scope). Shared/visited `TreeID`s and
 * DNS names join the same dimension later. Omitted on a request, it means
 * the session root.
 */
export type TreeRef = string;
export type RootID = string;

export const LOCAL_TREE: TreeRef = "local";
export const SYSTEM_TREE: TreeRef = "system";

export type NodeRef =
  | { tree?: TreeRef; path: LogicalPath }
  | { tree?: TreeRef; pageID: PageID; pathHint?: LogicalPath };

export interface ResolvedNodeRef {
  /** Scope the reference resolved in. Present on all responses; absent only in legacy payloads, meaning the session root. */
  tree?: TreeRef;
  path: LogicalPath;
  pageID?: PageID;
}

export interface RootDescriptor {
  id: RootID;
  /** Friendly name; the root directory's basename by default. */
  name: string;
  /** Absolute canonical path of the root on disk. */
  osPath: string;
  tracking: "tracked" | "session";
  /** The record exists but its path does not resolve. */
  missing?: boolean;
}

export interface RootsPage {
  roots: RootDescriptor[];
  /** The user's home directory, for client-side `~` rendering. */
  home: string;
  diagnostics: Diagnostic[];
  observedThrough: EventCursor;
}

export type ProtocolNodeKind = "markdown" | "directory" | "collection" | "database" | "file";

export interface NodeSnapshot {
  ref: ResolvedNodeRef;
  /** Scope the snapshot resolved in, after canonicalization into an owning root. */
  tree?: TreeRef;
  /** The enclosing tracked/session root; present iff `tree` is a RootID. */
  enclosingRoot?: RootDescriptor;
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

export type ContentWorkspaceOperation =
  | {
    op: "writeMarkdown";
    ref: NodeRef;
    baseContentRevision: ContentRevision;
    frontmatterPatch?: Record<string, unknown | null>;
    blocks: ArborBlock[];
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
  | { op: "createDirectory"; tree?: TreeRef; path: LogicalPath }
  | { op: "createMarkdown"; tree?: TreeRef; path: LogicalPath; blocks?: ArborBlock[] }
  | { op: "rename"; ref: NodeRef; name: string }
  | {
    op: "move";
    refs: NodeRef[];
    destination: NodeRef;
    /**
     * `natural` (the default) moves the node without inserting a stored
     * destination row; `authored` places a row in the destination directory
     * document. An anchor (`beforePath`/`beforeBlockID`) implies `authored`.
     */
    placement?: "natural" | "authored";
    beforePath?: LogicalPath;
    beforeBlockID?: string;
    baseDirectoryRevision?: DirectoryRevision;
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
  tree?: TreeRef;
  path: LogicalPath;
  previousPath?: LogicalPath;
  pageID?: PageID;
  contentRevision?: ContentRevision;
  directoryRevision?: DirectoryRevision;
}

export interface MutationReceipt {
  mutationID: string;
  eventCursor: EventCursor;
  effects: MutationEffect[];
}

export type WorkspaceEventOrigin = "api" | "external" | "recovery" | "sync";

export interface WorkspaceEvent {
  cursor: EventCursor;
  /** Scope the event belongs to; one process-wide stream orders all scopes. */
  tree?: TreeRef;
  kind: MutationEffectKind | "diagnostic";
  path: LogicalPath;
  previousPath?: LogicalPath;
  pageID?: PageID;
  contentRevision?: ContentRevision;
  directoryRevision?: DirectoryRevision;
  origin: WorkspaceEventOrigin;
  mutationID?: string;
}

export type ArbordErrorCode =
  | "invalid-reference"
  | "not-found"
  | "duplicate-page-id"
  | "duplicate-body-representation"
  | "stale-content-revision"
  | "stale-directory-revision"
  | "missing-insertion-anchor"
  | "occupied-destination"
  | "unsafe-path"
  | "mutation-mismatch"
  | "read-only"
  | "permission-denied"
  | "not-materialized"
  | "unsupported-operation"
  | "resync-required"
  | "internal-error"
  | (string & {});

export interface ArbordErrorValue {
  code: ArbordErrorCode;
  message: string;
  retryable: boolean;
  path?: LogicalPath;
  current?: NodeSnapshot;
  owners?: LogicalPath[];
  anchor?: { beforePath?: LogicalPath; beforeBlockID?: string };
  mutationID?: string;
}

export interface ArbordErrorEnvelope {
  error: ArbordErrorValue;
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
