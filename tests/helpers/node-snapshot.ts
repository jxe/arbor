import type { MarkdownDocument, NodeSummary } from "@arbor/core";
import type { TreeNode } from "@arbor/core/internal";
import { parseMarkdown } from "@arbor/editor";

export function nodeDocument(node: (NodeSummary & { content?: { source: string } }) | TreeNode): MarkdownDocument | undefined {
  if (!("capabilities" in node)) return node.document;
  return node.capabilities.content?.format === "markdown" && node.content
    ? parseMarkdown(node.content.source)
    : undefined;
}

export function nodeKind(node: NodeSummary): "directory" | "markdown" | "file" {
  if (node.capabilities.children) return "directory";
  return node.capabilities.content?.format === "markdown" ? "markdown" : "file";
}
