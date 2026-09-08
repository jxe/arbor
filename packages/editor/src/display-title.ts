import type { MarkdownDocument } from "@arbor/core";

/** Plain presentation text for the small inline-Markdown subset used in page titles. */
export function plainMarkdownTitle(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`$]/g, "")
    .trim();
}

/** The authored first H1, including its emoji, or the logical filename fallback. */
export function markdownDisplayTitle(document: MarkdownDocument, fallback: string): string {
  const heading = document.blocks.find(
    (block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1,
  );
  return plainMarkdownTitle(heading?.content ?? "") || fallback;
}
