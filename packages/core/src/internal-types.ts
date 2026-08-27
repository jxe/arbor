import type { Diagnostic, MarkdownDocument, Materialization } from "./types.ts";
import type { IdentityRule } from "./node-model.ts";

/** Physical/provider dispatch types. Never serialize these as the node model. */
export type NodeKind = "markdown" | "directory" | "collection" | "file" | "postgres";

export interface TreeChild {
  tree: string;
  name: string;
  path: string;
  kind: NodeKind;
  materialization: Materialization;
  pageID?: string;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: NodeKind;
  revision: string;
  contentRevision?: string;
  propertiesRevision?: string;
  childrenRevision?: string;
  writable: boolean;
  materialization: Materialization;
  bodyOrigin?: "sibling" | "index";
  document?: MarkdownDocument;
  children?: TreeChild[];
  collection?: CollectionSummary;
  diagnostics: Diagnostic[];
}

export type CollectionBacking = "csv" | "json" | "jsonl" | "markdown" | "sqlite" | "postgres";

export interface CollectionSummary {
  backing: CollectionBacking;
  columns: string[];
  identityRule?: IdentityRule;
  revision?: string;
  schemaRevision?: string;
  modelDigest?: string;
  diagnostics?: Diagnostic[];
  editable: boolean;
  rollupScope?: "children" | "subtree";
  total?: number;
  tables?: string[];
}

export interface CollectionRow {
  key: string;
  path: string;
  stableKey: string | null;
  revision?: string;
  values: Record<string, unknown>;
  diagnostics: Diagnostic[];
}
