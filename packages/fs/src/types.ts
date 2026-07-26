import type { ArborBlock, Diagnostic, MarkdownDocument, NodeWriteRequest } from "@arbor/core";

export type FsBodySource = "sibling" | "index" | null;
export type FsNodeKind = "missing" | "file" | "markdown" | "directory";
export type FsMaterialization = "available" | "placeholder";

export interface ResolvedFsNode {
  path: string;
  kind: FsNodeKind;
  absolutePath: string;
  directoryPath: string | null;
  bodyPath: string | null;
  bodySource: FsBodySource;
  writable: boolean;
  materialization: FsMaterialization;
  diagnostics: Diagnostic[];
}

export interface FsDirectoryEntry {
  path: string;
  name: string;
  kind: Exclude<FsNodeKind, "missing">;
  materialization: FsMaterialization;
  diagnostics: Diagnostic[];
}

export interface FsReadResult {
  node: ResolvedFsNode;
  bytes: Uint8Array | null;
  byteRevision: string;
  bodyRevision?: string;
  document?: MarkdownDocument;
}

export interface FsWriteResult extends FsReadResult {
  pageID: string;
  generation: number;
}

export type FsMutation =
  | { op: "createDirectory"; path: string }
  | { op: "createMarkdown"; path: string; blocks?: ArborBlock[] }
  | { op: "createFile"; path: string; bytes: Uint8Array }
  | { op: "rename"; path: string; name: string; updateDirectoryRows?: boolean }
  | {
    op: "move";
    paths: string[];
    destination: string;
    /** `natural` (default) inserts no destination row; an anchor implies `authored`. */
    placement?: "natural" | "authored";
    beforePath?: string;
    beforeBlockId?: string;
    directoryRevision?: string;
    updateDirectoryRows?: boolean;
  }
  | { op: "copy"; paths: string[]; destination: string }
  | { op: "trash"; paths: string[] }
  | { op: "restore"; paths: string[] }
  | { op: "import"; destination: string; entries: FsImportEntry[] };

export interface FsImportEntry {
  path: string;
  kind: "file" | "directory";
  bytes?: Uint8Array;
}

export interface FsMutationRequest {
  operations: FsMutation[];
}

export interface FsChange {
  path: string;
  previousPath?: string;
  kind: "created" | "updated" | "moved" | "deleted";
}

export interface FsMutationResult {
  transactionId: string;
  changes: FsChange[];
  created: string[];
  updated: string[];
  moved: Array<{ from: string; to: string }>;
  deleted: string[];
}

export type FsEventOrigin = "local-api" | "local-external" | "sync";
export type FsEventClassification = "echo" | "stomp" | "external";

export interface FsEvent {
  type: "created" | "updated" | "moved" | "deleted" | "diagnostic" | "batch";
  path: string;
  previousPath?: string;
  byteRevision?: string;
  bodyRevision?: string;
  transactionId?: string;
  origin: FsEventOrigin;
  classification?: FsEventClassification;
  generation?: number;
  settledGeneration?: number;
  diagnostic?: Diagnostic;
  changes?: FsChange[];
}

export interface WorkspaceFSOptions {
  stateDirectory: string;
  settleDelayMs?: number;
  faultInjector?: (point: string) => void | Promise<void>;
}

export interface FsConflictDetails {
  code:
    | "occupied-destination"
    | "stale-revision"
    | "duplicate-body"
    | "read-only"
    | "offline"
    | "unsafe-path"
    | "unsupported-entry"
    | "interrupted-transaction"
    | "recursive-move"
    | "not-found"
    | "missing-insertion-anchor"
    | "invalid-name";
  path: string;
  current?: FsReadResult;
}

export class FsConflictError extends Error {
  readonly status = 409;
  constructor(public details: FsConflictDetails, message: string) {
    super(message);
    this.name = "FsConflictError";
  }
}

/** Test-only crash signal: WorkspaceFS deliberately leaves durable intent/staging for reopen recovery. */
export class FsInjectedCrashError extends Error {
  constructor(public point: string, options?: ErrorOptions) {
    super(`Injected filesystem crash at ${point}`, options);
    this.name = "FsInjectedCrashError";
  }
}

export type MarkdownWriteRequest = NodeWriteRequest;
