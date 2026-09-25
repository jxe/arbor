import type { Diagnostic, MarkdownDocument, Materialization } from "@overstory/protocol";

export type FsBodySource = "sibling" | "index" | null;
export type FsNodeKind = "missing" | "file" | "markdown" | "directory";

export interface ResolvedFsNode {
  path: string;
  kind: FsNodeKind;
  absolutePath: string;
  directoryPath: string | null;
  bodyPath: string | null;
  bodySource: FsBodySource;
  writable: boolean;
  materialization: Materialization;
  diagnostics: Diagnostic[];
}

export interface FsDirectoryEntry {
  path: string;
  name: string;
  kind: Exclude<FsNodeKind, "missing">;
  materialization: Materialization;
  pageID?: string;
  diagnostics: Diagnostic[];
}

export interface FsReadResult {
  node: ResolvedFsNode;
  bytes: Uint8Array | null;
  /** Exact stored body bytes before provider-owned directory completion. */
  storedBytes?: Uint8Array | null;
  byteRevision: string;
  storedByteRevision?: string;
  bodyRevision?: string;
  document?: MarkdownDocument;
}

/** A settled change the watcher observed in the folder. */
export interface FsEvent {
  type: "created" | "updated" | "moved" | "deleted" | "diagnostic";
  path: string;
  previousPath?: string;
  byteRevision?: string;
  bodyRevision?: string;
  diagnostic?: Diagnostic;
}

export interface WorkspaceFSOptions {
  stateDirectory: string;
  discovery?: "recursive" | "shallow" | "none";
  /** Physically nested trees projected by the reader's workspace, not owned by this tree. */
  excludedRoots?: readonly string[];
}
