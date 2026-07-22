import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import type { ArborBlock } from "@arbor/core";

const RawMarkdownBlock = createReactBlockSpec(
  { type: "rawMarkdown", propSchema: { blank: { default: false } }, content: "inline" },
  {
    render: ({ block, contentRef }) => block.props.blank
      ? <div className="raw-blank" ref={contentRef} />
      : <div className="raw-markdown"><span className="raw-label">Markdown</span><pre ref={contentRef} /></div>,
    toExternalHTML: ({ contentRef }) => <pre data-arbor-raw="true" ref={contentRef} />,
  },
)();

const ChildPageBlock = createReactBlockSpec(
  { type: "childPage", propSchema: { path: { default: "" } }, content: "inline" },
  {
    render: ({ block, contentRef }) => <a className="child-page" href={block.props.path}><span>↗</span><span ref={contentRef} /><small>{block.props.path}</small></a>,
    toExternalHTML: ({ block, contentRef }) => <a href={block.props.path} ref={contentRef} />,
  },
)();

export const arborSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, rawMarkdown: RawMarkdownBlock, childPage: ChildPageBlock },
});

export type ArborEditorBlock = (typeof arborSchema.Block) & { type: string };

function textOf(content: ArborEditorBlock["content"]): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => item.type === "text" ? item.text : item.type === "link" ? item.content.map((part) => part.text).join("") : "").join("");
}

function markdownOf(content: ArborEditorBlock["content"]): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => item.type === "text"
    ? item.text
    : item.type === "link"
      ? `[${item.content.map((part) => part.text).join("")}](${item.href})`
      : "").join("");
}

function inlineMarkdown(source: string): any[] {
  const result: any[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) result.push({ type: "text", text: source.slice(cursor, index), styles: {} });
    result.push({ type: "link", href: match[2]!, content: [{ type: "text", text: match[1]!, styles: {} }] });
    cursor = index + match[0].length;
  }
  if (cursor < source.length) result.push({ type: "text", text: source.slice(cursor), styles: {} });
  return result.length ? result : [{ type: "text", text: source, styles: {} }];
}

export function blockText(block: ArborEditorBlock): string { return textOf(block.content); }

export function toBlockNote(block: ArborBlock): PartialBlock<typeof arborSchema.blockSchema> {
  const children = block.children.map(toBlockNote);
  switch (block.type) {
    case "toggle": return { id: block.id, type: "toggleListItem", content: inlineMarkdown(block.content ?? ""), children };
    case "heading": return { id: block.id, type: "heading", props: { level: Number(block.props?.level ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 }, content: inlineMarkdown(block.content ?? ""), children };
    case "bulletListItem": return { id: block.id, type: "bulletListItem", content: inlineMarkdown(block.content ?? ""), children };
    case "numberedListItem": return { id: block.id, type: "numberedListItem", content: inlineMarkdown(block.content ?? ""), children };
    case "checkListItem": return { id: block.id, type: "checkListItem", props: { checked: Boolean(block.props?.checked) }, content: inlineMarkdown(block.content ?? ""), children };
    case "quote": return { id: block.id, type: "quote", content: inlineMarkdown(block.content ?? "") };
    case "codeBlock": return { id: block.id, type: "codeBlock", props: { language: String(block.props?.language ?? "") }, content: block.content ?? "" };
    case "divider": return { id: block.id, type: "divider" };
    case "image": return { id: block.id, type: "image", props: { url: String(block.props?.url ?? ""), caption: String(block.props?.caption ?? "") } };
    case "childPage": return { id: block.id, type: "childPage", props: { path: String(block.props?.path ?? "") }, content: block.content ?? "" };
    case "rawMarkdown": return { id: block.id, type: "rawMarkdown", props: { blank: Boolean(block.props?.blank) }, content: block.content ?? "" };
    default: return { id: block.id, type: "paragraph", content: inlineMarkdown(block.content ?? ""), children };
  }
}

export function fromBlockNote(block: ArborEditorBlock, originals: Map<string, ArborBlock>): ArborBlock {
  const original = originals.get(block.id);
  const children = block.children.map((child) => fromBlockNote(child as ArborEditorBlock, originals));
  let type: ArborBlock["type"];
  switch (block.type) {
    case "toggleListItem": type = "toggle"; break;
    case "heading": type = "heading"; break;
    case "bulletListItem": type = "bulletListItem"; break;
    case "numberedListItem": type = "numberedListItem"; break;
    case "checkListItem": type = "checkListItem"; break;
    case "quote": type = "quote"; break;
    case "codeBlock": type = "codeBlock"; break;
    case "divider": type = "divider"; break;
    case "image": type = "image"; break;
    case "rawMarkdown": type = "rawMarkdown"; break;
    case "childPage": type = "childPage"; break;
    default: type = original?.type === "rawMarkdown" && original.props?.blank ? "rawMarkdown" : "paragraph";
  }
  const props: Record<string, string | number | boolean> = {};
  if (block.type === "heading") props.level = block.props.level;
  if (block.type === "checkListItem") props.checked = block.props.checked;
  if (block.type === "codeBlock") props.language = block.props.language;
  if (block.type === "image") { props.url = block.props.url; props.caption = block.props.caption; }
  if (block.type === "rawMarkdown") props.blank = block.props.blank;
  if (block.type === "childPage") props.path = block.props.path;
  return {
    id: block.id,
    type,
    content: block.type === "image" || block.type === "divider" ? "" : markdownOf(block.content),
    props,
    children,
    source: original?.source,
    sourceHash: original?.sourceHash,
  };
}

export function originalMap(blocks: ArborBlock[]): Map<string, ArborBlock> {
  const result = new Map<string, ArborBlock>();
  const visit = (items: ArborBlock[]) => items.forEach((item) => { result.set(item.id, item); visit(item.children); });
  visit(blocks);
  return result;
}
