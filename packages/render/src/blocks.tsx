import { createContext, useContext } from "react";
import { BlockNoteSchema, createExtension, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  AddBlockButton,
  createReactBlockSpec,
  DragHandleButton,
  SideMenu,
  useComponentsContext,
  useExtensionState,
} from "@blocknote/react";
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

export interface ManagedRowsController {
  resolve(rawPath: string): string | null;
  kind(path: string): "file" | "markdown" | "directory" | "collection" | "postgres" | null;
  selected(path: string): boolean;
  select(path: string, event: React.MouseEvent): void;
  rename(path: string): void;
  trash(path: string): void;
  drop(path: string, kind: "before" | "after" | "inside", event: React.DragEvent): void;
  renamingPath: string | null;
  renameValue: string;
  setRenameValue(value: string): void;
  commitRename(): void;
  cancelRename(): void;
}

export const ManagedRowsContext = createContext<ManagedRowsController | null>(null);

function ArborDragHandleMenu() {
  const controller = useContext(ManagedRowsContext);
  const Components = useComponentsContext();
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });
  const path = block?.type === "childPage"
    ? controller?.resolve(String(block.props.path ?? "")) ?? null
    : null;
  if (!controller || !Components || !path) return null;

  return <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-drag-handle-menu">
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => controller.rename(path)}>
      Rename
    </Components.Generic.Menu.Item>
    <Components.Generic.Menu.Item className="bn-menu-item danger" onClick={() => controller.trash(path)}>
      Move to Trash
    </Components.Generic.Menu.Item>
  </Components.Generic.Menu.Dropdown>;
}

export function ArborSideMenu() {
  const controller = useContext(ManagedRowsContext);
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });
  const path = block?.type === "childPage"
    ? controller?.resolve(String(block.props.path ?? "")) ?? null
    : null;

  if (!controller || !block || !path) return <SideMenu />;

  return <SideMenu>
    <AddBlockButton />
    <span className="arbor-managed-drag-handle" data-arbor-managed-handle={path}>
      <DragHandleButton dragHandleMenu={ArborDragHandleMenu} />
    </span>
  </SideMenu>;
}

const ChildPageBlock = createReactBlockSpec(
  { type: "childPage", propSchema: { path: { default: "" } }, content: "inline" },
  {
    render: ({ block, contentRef }) => {
      const controller = useContext(ManagedRowsContext);
      const path = controller?.resolve(block.props.path) ?? null;
      const kind = path ? controller?.kind(path) ?? null : null;
      if (!controller || !path || !kind) {
        return <a className="child-page" href={block.props.path}><span>↗</span><span ref={contentRef} /><small>{block.props.path}</small></a>;
      }
      const renaming = controller.renamingPath === path;
      return <div
        className={`child-page managed-child-page${controller.selected(path) ? " selected" : ""}`}
        data-managed-row={path}
        contentEditable={false}
        onClick={(event) => {
          if (event.currentTarget.dataset.suppressClick === "true") {
            delete event.currentTarget.dataset.suppressClick;
            return;
          }
          if ((event.target as Element).closest("a, input")) return;
          controller.select(path, event);
        }}
        onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onDrop={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
          const position = kind === "directory" || kind === "collection"
            ? ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside"
            : ratio > 0.5 ? "after" : "before";
          controller.drop(path, position, event);
        }}
      >
        <span className="child-page-kind" aria-hidden="true">{kind === "directory" || kind === "collection" ? "▸" : "↗"}</span>
        {renaming ? <>
          <span className="managed-hidden-content" ref={contentRef} />
          <input
            autoFocus
            aria-label={`Rename ${path}`}
            value={controller.renameValue}
            onChange={(event) => controller.setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); controller.commitRename(); }
              if (event.key === "Escape") { event.preventDefault(); controller.cancelRename(); }
            }}
            onBlur={() => controller.commitRename()}
          />
        </> : <a href={block.props.path}><span ref={contentRef} /></a>}
        <small>{path}</small>
      </div>;
    },
    toExternalHTML: ({ block, contentRef }) => <a href={block.props.path} ref={contentRef} />,
  },
)();

export const arborSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, rawMarkdown: RawMarkdownBlock, childPage: ChildPageBlock },
});

export const arborEditorExtensions = [
  createExtension({
    key: "arbor-toggle-shorthand",
    inputRules: [{
      find: /^▸\s$/,
      replace: () => ({ type: "toggleListItem", props: {} }),
    }],
  }),
];

export type ArborEditorBlock = (typeof arborSchema.Block) & { type: string };

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
