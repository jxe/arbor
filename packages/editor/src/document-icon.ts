import type { ArborBlock, MarkdownDocument } from "@arbor/core";
import { serializeMarkdown } from "./markdown.ts";

const emojiPattern = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;

function firstGrapheme(value: string): string | null {
  const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)[Symbol.iterator]().next();
  return segment.done ? null : segment.value.segment;
}

export function leadingDocumentEmoji(value: string): string | null {
  const grapheme = firstGrapheme(value.trimStart());
  return grapheme && emojiPattern.test(grapheme) ? grapheme : null;
}

export function documentIcon(document: MarkdownDocument): string | null {
  const heading = document.blocks.find((block) =>
    block.type === "heading" && Number(block.props?.level ?? 1) === 1
  );
  return heading ? leadingDocumentEmoji(String(heading.content ?? "")) : null;
}

/**
 * Return an exact-source mutation that changes only the first H1. If the
 * document has no H1, setting an icon prepends one using the display name.
 */
export function sourceSettingDocumentIcon(
  document: MarkdownDocument,
  icon: string | null,
  displayName: string,
  createBlockID: () => string = () => `heading-${crypto.randomUUID()}`,
): string {
  const blocks = structuredClone(document.blocks);
  const heading = blocks.find((block) =>
    block.type === "heading" && Number(block.props?.level ?? 1) === 1
  );
  if (!heading) {
    if (!icon) return document.source;
    blocks.unshift({
      id: createBlockID(),
      type: "heading",
      content: `${icon} ${displayName}`,
      props: { level: 1 },
      children: [],
    } satisfies ArborBlock);
    return serializeMarkdown(document, blocks);
  }

  const content = String(heading.content ?? "");
  const existing = leadingDocumentEmoji(content);
  const withoutIcon = existing
    ? content.trimStart().slice(existing.length).replace(/^\s+/u, "")
    : content;
  heading.content = icon ? `${icon}${withoutIcon ? ` ${withoutIcon}` : ""}` : withoutIcon;
  return serializeMarkdown(document, blocks);
}
