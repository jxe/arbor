import type { MarkdownDocument, NodeSummary } from "@ovst/protocol";
import { parseMarkdown } from "@ovst/protocol";

export function nodeDocument(node: (NodeSummary & { content?: { source: string } }) | { document?: MarkdownDocument }): MarkdownDocument | undefined {
  if (!("capabilities" in node)) return node.document;
  return node.capabilities.content?.format === "markdown" && node.content
    ? parseMarkdown(node.content.source)
    : undefined;
}

export function nodeKind(node: NodeSummary): "directory" | "markdown" | "file" {
  if (node.capabilities.children) return "directory";
  return node.capabilities.content?.format === "markdown" ? "markdown" : "file";
}
