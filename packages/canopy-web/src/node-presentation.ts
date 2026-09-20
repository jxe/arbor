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
