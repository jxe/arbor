export type NodeKind = "markdown" | "directory" | "collection" | "file" | "postgres";
export type Materialization = "available" | "placeholder";

export interface Diagnostic {
  code: string;
  message: string;
  path: string;
  severity: "info" | "warning" | "error";
  row?: number;
  field?: string;
}

export type BlockType =
  | "paragraph"
  | "heading"
  | "bulletListItem"
  | "numberedListItem"
  | "checkListItem"
  | "quote"
  | "codeBlock"
  | "image"
  | "divider"
  | "mathBlock"
  | "footnoteDefinition"
  | "toggle"
  | "standaloneLink"
  | "rawMarkdown";

export interface ArborBlock {
  id: string;
  type: BlockType;
  content?: string;
  props?: Record<string, string | number | boolean>;
  children: ArborBlock[];
  source?: string;
  sourceHash?: string;
}

export interface MarkdownDocument {
  frontmatter: Record<string, unknown>;
  frontmatterSource: string | null;
  bodySource: string;
  blocks: ArborBlock[];
}

export interface TreeChild {
  name: string;
  path: string;
  kind: NodeKind;
  materialization: Materialization;
  /** Durable document identity, when known unambiguously. */
  pageID?: string;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: NodeKind;
  revision: string;
  writable: boolean;
  materialization: Materialization;
  /** Which physical representation supplies a stored body; absent for implicit bodies. */
  bodyOrigin?: "sibling" | "index";
  document?: MarkdownDocument;
  children?: TreeChild[];
  collection?: CollectionSummary;
  diagnostics: Diagnostic[];
}

export type CollectionBacking = "csv" | "jsonl" | "markdown" | "postgres";

export interface CollectionSummary {
  backing: CollectionBacking;
  columns: string[];
  editable: boolean;
  total?: number;
  tables?: string[];
}

export interface CollectionRow {
  key: string;
  path?: string;
  values: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

export interface CollectionPage {
  path: string;
  backing: CollectionBacking;
  columns: string[];
  rows: CollectionRow[];
  nextCursor: string | null;
  diagnostics: Diagnostic[];
  editable: boolean;
}

export interface SearchResult {
  /** Shared-tree scope the result belongs to. */
  tree?: string;
  path: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface NodeWriteRequest {
  baseRevision: string;
  frontmatterPatch?: Record<string, unknown | null>;
  blocks: ArborBlock[];
}

export interface ArborEvent {
  seq: number;
  type: "created" | "updated" | "moved" | "deleted" | "diagnostic" | "batch";
  path: string;
  previousPath?: string;
  revision?: string;
  classification?: "echo" | "stomp" | "external";
  changes?: Array<{ path: string; previousPath?: string; kind: "created" | "updated" | "moved" | "deleted" }>;
}
