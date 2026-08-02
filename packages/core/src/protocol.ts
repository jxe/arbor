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
 * Values are `"local"` (the degenerate filesystem scope; paths are
 * OS-absolute), `"system"` (the control scope), or a stable shared
 * `TreeID`. Omitted on a request, it means the launch session.
 */
export type TreeRef = string;
export type TreeID = string;
export type PublicAccess = "none" | "read" | "write";
/** Initial audience selected when promoting a tree. */
export type PublicationMode = "private" | "public-read" | "public-write";
export type ShareAudience =
  | { kind: "private" }
  | { kind: "everyone"; access: "read" | "write" }
  | { kind: "profile"; locator: string; access: "read" | "write" };

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

export interface TreeDescriptor {
  id: TreeID;
  name: string;
  osPath?: string;
  canonical?: string;
  canonicalPath?: string;
  httpURL?: string;
  endpoint?: string;
  publicAccess?: PublicAccess;
  access?: "read" | "write";
  accessEntries?: Array<{
    id: string;
    kind: "everyone" | "profile" | "link";
    access: "read" | "write";
    locator?: string;
  }>;
  placement: "local" | "shared" | "remote";
  sync?: "idle" | "pushing" | "pulling" | "offline" | "conflict" | "error";
  legacy?: boolean;
  missing?: boolean;
}

export type ProtocolNodeKind = "markdown" | "directory" | "collection" | "database" | "file";

export interface NodeSnapshot {
  ref: ResolvedNodeRef;
  /** Scope the snapshot resolved in, after canonicalization into an owning root. */
  tree?: TreeRef;
  /** The enclosing durable or migration tree, when applicable. */
  enclosingTree?: TreeDescriptor;
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

export type SystemOperation =
  | { op: "connectCommunity"; origin: string; accountToken: string }
  | { op: "disconnectCommunity" }
  | { op: "claimProfile"; origin: string; handle: string; path: string; displayName?: string }
  | { op: "createGroupProfile"; handle: string; path: string; displayName?: string }
  | { op: "promoteTree"; path: string; canonicalPath: string; audience: ShareAudience }
  | { op: "placeTree"; tree: TreeID; path: string; endpoint?: string; canonical?: string }
  | { op: "removeTreePlacement"; path: string; endpoint?: string; canonicalPath?: string }
  | {
      op: "setTreeAccess";
      tree: TreeID;
      subject:
        | { kind: "all" }
        | { kind: "everyone" }
        | { kind: "profile"; locator: string }
        | { kind: "link"; secret: string }
        | { kind: "entry"; id: string };
      access: "none" | "read" | "write";
    };

export type WorkspaceOperation = ContentWorkspaceOperation | StructuralWorkspaceOperation | SystemOperation;

export interface ContentMutationRequest {
  mutationID: string;
  operations: [ContentWorkspaceOperation];
}

export interface StructuralMutationRequest {
  mutationID: string;
  operations: [StructuralWorkspaceOperation, ...StructuralWorkspaceOperation[]];
}

export interface SystemMutationRequest {
  mutationID: string;
  operations: [SystemOperation];
}

export type MutationRequest = ContentMutationRequest | StructuralMutationRequest | SystemMutationRequest;

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
  | "reserved-boundary"
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
