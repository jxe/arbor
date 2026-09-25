import type { MarkdownDocument, NodeSummary } from "@overstory/protocol";
import type { NodeSnapshot } from "@overstory/arborsync-client";
import { parseMarkdown } from "@overstory/protocol";

export function nodeDocument(node: NodeSnapshot): MarkdownDocument | undefined {
  return node.capabilities.content?.format === "markdown" && node.content
    ? parseMarkdown(node.content.source)
    : undefined;
}

export function hasChildren(node: NodeSummary): boolean {
  return node.capabilities.children !== undefined;
}

export function hasMarkdownContent(node: NodeSummary): boolean {
  return node.capabilities.content?.format === "markdown";
}

export function presentationKind(node: NodeSummary): "directory" | "markdown" | "file" {
  if (hasChildren(node)) return "directory";
  return hasMarkdownContent(node) ? "markdown" : "file";
}

/**
 * Where a node's Markdown body lives, for file-relative links. A summary does
 * not say, so a directory is taken to hold `_index.md` and a document to be
 * a sibling `x.md`; Web 025 replaces this with the node's representation.
 */
export function presentationBody(node: NodeSummary): "sibling" | "index" | null {
  const kind = presentationKind(node);
  return kind === "markdown" ? "sibling" : kind === "directory" ? "index" : null;
}
