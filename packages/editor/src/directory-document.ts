import type { MarkdownDocument } from "@arbor/core";
import type { TreeChild } from "@arbor/core/internal";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { legacyPageIDCandidate, relativeLogicalReference, resolveLogicalURL } from "@arbor/core/logical-url";
import { parseMarkdown } from "./markdown.ts";

export interface CompleteDirectoryDocument {
  source: string;
  document: MarkdownDocument;
  addedChildren: string[];
}

function compareUTF8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function appendSeparator(source: string): string {
  if (!source) return "";
  if (source.endsWith("\n\n") || source.endsWith("\r\n\r\n")) return "";
  if (source.endsWith("\n") || source.endsWith("\r")) return source.endsWith("\r\n") ? "\r\n" : "\n";
  return source.includes("\r\n") ? "\r\n\r\n" : "\n\n";
}

/**
 * Return the complete operational Markdown for a physical directory.
 * Existing source is never rewritten. The first standalone link resolving to
 * each immediate child claims it; one ordinary link is appended for every
 * unmatched child in unsigned UTF-8 logical-path order.
 */
export function completeDirectoryDocument(
  directoryInput: string,
  source: string,
  children: readonly TreeChild[],
): CompleteDirectoryDocument {
  const directory = canonicalNodePath(directoryInput);
  const document = parseMarkdown(source);
  const childByPath = new Map<string, TreeChild>();
  const childByPageID = new Map<string, TreeChild>();
  for (const child of children) {
    childByPath.set(canonicalNodePath(child.path), child);
    if (child.pageID) childByPageID.set(child.pageID, child);
  }

  const matched = new Set<TreeChild>();
  const walk = (blocks: MarkdownDocument["blocks"]): void => {
    for (const block of blocks) {
      if (block.type === "standaloneLink") {
        const resolved = resolveLogicalURL(directory, String(block.props?.path ?? ""));
        if (resolved?.kind === "local") {
          const pageID = legacyPageIDCandidate(resolved);
          const child = (pageID && childByPageID.get(pageID)) ?? childByPath.get(resolved.path);
          if (child) matched.add(child);
        }
      }
      walk(block.children);
    }
  };
  walk(document.blocks);

  const missing = children
    .filter((child) => !matched.has(child))
    .sort((left, right) => compareUTF8(canonicalNodePath(left.path), canonicalNodePath(right.path)));
  if (!missing.length) return { source, document, addedChildren: [] };

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const appended = missing
    .map((child) => `[${escapeLabel(child.name)}](${relativeLogicalReference(directory, child.path)})`)
    .join(`${newline}${newline}`) + newline;
  const complete = `${source}${appendSeparator(source)}${appended}`;
  return {
    source: complete,
    document: parseMarkdown(complete),
    addedChildren: missing.map((child) => canonicalNodePath(child.path)),
  };
}
