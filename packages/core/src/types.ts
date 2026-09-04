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
  /** Exact authoritative Markdown source, including frontmatter. */
  source: string;
  frontmatter: Record<string, unknown>;
  frontmatterSource: string | null;
  bodySource: string;
  blocks: ArborBlock[];
}

export interface SearchResult {
  ref: import("./node-model.ts").NodeRef;
  title: string;
  excerpt: string;
  score: number;
}

export interface NodeWriteRequest {
  baseRevision: string;
  source: string;
}
