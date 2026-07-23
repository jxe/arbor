import { createContext, useContext } from "react";
import {
  BlockNoteEditor,
  BlockNoteSchema,
  createExtension,
  defaultBlockSpecs,
  defaultStyleSpecs,
  type PartialBlock,
} from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  AddBlockButton,
  BasicTextStyleButton,
  createReactBlockSpec,
  DragHandleButton,
  FormattingToolbar,
  getFormattingToolbarItems,
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

function ChildPageIcon({ folder = false }: { folder?: boolean }) {
  return <svg
    aria-hidden="true"
    className="child-page-icon"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {folder
      ? <>
        <path d="M1.75 4.25h4l1.4 1.5h7.1v6.75a1.25 1.25 0 0 1-1.25 1.25H3a1.25 1.25 0 0 1-1.25-1.25z" />
        <path d="M1.75 4.25V3.5A1.25 1.25 0 0 1 3 2.25h2.35l1.4 1.5h6A1.25 1.25 0 0 1 14 5" />
      </>
      : <>
        <path d="M3 1.75h6l4 4v8.5H3z" />
        <path d="M9 1.75v4h4M5.25 9h5.5M5.25 11.5h4" />
      </>}
  </svg>;
}

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
        return <a className="child-page" href={block.props.path} title={block.props.path}><span className="child-page-kind"><ChildPageIcon /></span><span ref={contentRef} /><small>{block.props.path}</small></a>;
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
        <span className="child-page-kind"><ChildPageIcon folder={kind === "directory" || kind === "collection"} /></span>
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
        </> : <a href={block.props.path} title={path}><span ref={contentRef} /></a>}
        <small>{path}</small>
      </div>;
    },
    toExternalHTML: ({ block, contentRef }) => <a href={block.props.path} ref={contentRef} />,
  },
)();

export const arborSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, rawMarkdown: RawMarkdownBlock, childPage: ChildPageBlock },
  styleSpecs: {
    bold: defaultStyleSpecs.bold,
    italic: defaultStyleSpecs.italic,
    strike: defaultStyleSpecs.strike,
    code: defaultStyleSpecs.code,
  },
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

const omittedFormattingToolbarItems = new Set([
  "underlineStyleButton",
  "textAlignLeftButton",
  "textAlignCenterButton",
  "textAlignRightButton",
  "colorStyleButton",
]);

export function ArborFormattingToolbar() {
  const items = getFormattingToolbarItems().filter((item) => !omittedFormattingToolbarItems.has(String(item.key)));
  const strikeIndex = items.findIndex((item) => item.key === "strikeStyleButton");
  items.splice(strikeIndex + 1, 0, <BasicTextStyleButton basicTextStyle="code" key="codeStyleButton" />);
  return <FormattingToolbar>{items}</FormattingToolbar>;
}

export type ArborBlockNoteEditor = BlockNoteEditor<
  typeof arborSchema.blockSchema,
  typeof arborSchema.inlineContentSchema,
  typeof arborSchema.styleSchema
>;
export type ArborEditorBlock = (typeof arborSchema.Block) & { type: string };

const inlineMarkdownPrefix = "arbor-inline-boundary ";

function plainInlineContent(source: string): any[] {
  return source ? [{ type: "text", text: source, styles: {} }] : [];
}

function inlineMarkdown(editor: ArborBlockNoteEditor, source: string): any[] {
  const parsed = editor.tryParseMarkdownToBlocks(`${inlineMarkdownPrefix}${source}`);
  const content = parsed[0]?.content;
  if (!Array.isArray(content)) return plainInlineContent(source);
  const result = structuredClone(content) as any[];
  const first = result[0];
  if (first?.type !== "text" || typeof first.text !== "string" || !first.text.startsWith(inlineMarkdownPrefix)) {
    return plainInlineContent(source);
  }
  first.text = first.text.slice(inlineMarkdownPrefix.length);
  if (!first.text) result.shift();
  return result;
}

function inlineMarkdownOf(editor: ArborBlockNoteEditor, content: ArborEditorBlock["content"], original?: ArborBlock): string {
  if (!Array.isArray(content)) return "";
  if (original && JSON.stringify(content) === JSON.stringify(inlineMarkdown(editor, original.content ?? ""))) {
    return original.content ?? "";
  }
  return editor.blocksToMarkdownLossy([{ type: "paragraph", content }]).replace(/\r?\n+$/, "");
}

function literalContentOf(content: ArborEditorBlock["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => item.type === "text"
    ? item.text
    : item.type === "link"
      ? item.content.map((part) => part.text).join("")
      : "").join("");
}

export function toBlockNote(block: ArborBlock, editor: ArborBlockNoteEditor): PartialBlock<typeof arborSchema.blockSchema> {
  const children = block.children.map((child) => toBlockNote(child, editor));
  switch (block.type) {
    case "toggle": return { id: block.id, type: "toggleListItem", content: inlineMarkdown(editor, block.content ?? ""), children };
    case "heading": return { id: block.id, type: "heading", props: { level: Number(block.props?.level ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 }, content: inlineMarkdown(editor, block.content ?? ""), children };
    case "bulletListItem": return { id: block.id, type: "bulletListItem", content: inlineMarkdown(editor, block.content ?? ""), children };
    case "numberedListItem": return { id: block.id, type: "numberedListItem", content: inlineMarkdown(editor, block.content ?? ""), children };
    case "checkListItem": return { id: block.id, type: "checkListItem", props: { checked: Boolean(block.props?.checked) }, content: inlineMarkdown(editor, block.content ?? ""), children };
    case "quote": return { id: block.id, type: "quote", content: inlineMarkdown(editor, block.content ?? "") };
    case "codeBlock": return { id: block.id, type: "codeBlock", props: { language: String(block.props?.language ?? "") }, content: block.content ?? "" };
    case "divider": return { id: block.id, type: "divider" };
    case "image": return { id: block.id, type: "image", props: { url: String(block.props?.url ?? ""), caption: String(block.props?.caption ?? "") } };
    case "childPage": return { id: block.id, type: "childPage", props: { path: String(block.props?.path ?? "") }, content: inlineMarkdown(editor, block.content ?? "") };
    case "rawMarkdown": return { id: block.id, type: "rawMarkdown", props: { blank: Boolean(block.props?.blank) }, content: block.content ?? "" };
    default: return { id: block.id, type: "paragraph", content: inlineMarkdown(editor, block.content ?? ""), children };
  }
}

export function fromBlockNote(block: ArborEditorBlock, originals: Map<string, ArborBlock>, editor: ArborBlockNoteEditor): ArborBlock {
  const original = originals.get(block.id);
  const children = block.children.map((child) => fromBlockNote(child as ArborEditorBlock, originals, editor));
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
    content: block.type === "image" || block.type === "divider"
      ? ""
      : block.type === "codeBlock" || block.type === "rawMarkdown"
        ? literalContentOf(block.content)
        : inlineMarkdownOf(editor, block.content, original),
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
