import { createContext, useContext, useState } from "react";
import {
  BlockNoteEditor,
  BlockNoteSchema,
  createExtension,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
  type PartialBlock,
} from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { Plugin } from "@tiptap/pm/state";
import katex from "katex";
import {
  AddBlockButton,
  BasicTextStyleButton,
  createReactBlockSpec,
  createReactInlineContentSpec,
  DragHandleButton,
  FormattingToolbar,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  SideMenu,
  type DefaultReactSuggestionItem,
  useComponentsContext,
  useEditorChange,
  useExtensionState,
} from "@blocknote/react";
import type { ArborBlock } from "@arbor/core";
import "katex/dist/katex.min.css";

const RawMarkdownBlock = createReactBlockSpec(
  {
    type: "rawMarkdown",
    propSchema: {
      blank: { default: false },
      arborChildrenMarker: { default: false },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef }) => block.props.arborChildrenMarker
      ? <div className="arbor-children-marker" contentEditable={false}><span>Children</span><span className="managed-hidden-content" ref={contentRef} /></div>
      : block.props.blank
      ? <div className="raw-blank" ref={contentRef} />
      : <div className="raw-markdown"><span className="raw-label">Markdown</span><pre ref={contentRef} /></div>,
    toExternalHTML: ({ contentRef }) => <pre data-arbor-raw="true" ref={contentRef} />,
  },
)();

function renderedLatex(formula: string, displayMode: boolean): string {
  return katex.renderToString(formula || "\\text{Equation}", {
    displayMode,
    throwOnError: false,
    strict: "warn",
    trust: false,
  });
}

function footnoteLabels(editor: BlockNoteEditor<any, any, any>): string[] {
  const referenced: string[] = [];
  const defined: string[] = [];
  const add = (target: string[], label: string) => {
    if (label && !target.includes(label)) target.push(label);
  };
  const visit = (blocks: any[]) => blocks.forEach((block) => {
    if (Array.isArray(block.content)) {
      block.content.forEach((item: any) => {
        if (item.type === "footnoteReference") add(referenced, String(item.props?.label ?? ""));
      });
    }
    if (block.type === "footnoteDefinition") add(defined, String(block.props?.label ?? ""));
    visit(block.children ?? []);
  });
  visit(editor.document);
  return [...referenced, ...defined.filter((label) => !referenced.includes(label))];
}

function footnoteDefinitions(editor: BlockNoteEditor<any, any, any>): Set<string> {
  const result = new Set<string>();
  const visit = (blocks: any[]) => blocks.forEach((block) => {
    if (block.type === "footnoteDefinition") result.add(String(block.props?.label ?? ""));
    visit(block.children ?? []);
  });
  visit(editor.document);
  return result;
}

function useFootnoteNumber(editor: BlockNoteEditor<any, any, any>, label: string): number {
  const [, render] = useState(0);
  useEditorChange(() => render((value) => value + 1), editor);
  return Math.max(1, footnoteLabels(editor).indexOf(label) + 1);
}

function visitFootnoteBlocks(editor: BlockNoteEditor<any, any, any>, callback: (block: any) => void): void {
  const visit = (blocks: any[]) => blocks.forEach((block) => {
    callback(block);
    visit(block.children ?? []);
  });
  visit(editor.document);
}

function renameFootnote(editor: BlockNoteEditor<any, any, any>, label: string, nextLabel: string): void {
  editor.transact(() => {
    visitFootnoteBlocks(editor, (block) => {
      if (Array.isArray(block.content)) {
        const content = block.content.map((item: any) => item.type === "footnoteReference" && item.props?.label === label
          ? { ...item, props: { ...item.props, label: nextLabel } }
          : item);
        if (content.some((item: any, index: number) => item !== block.content[index])) {
          editor.updateBlock(block, { content });
        }
      }
      if (block.type === "footnoteDefinition" && block.props?.label === label) {
        editor.updateBlock(block, { props: { label: nextLabel } });
      }
    });
  });
}

function deleteFootnote(editor: BlockNoteEditor<any, any, any>, label: string): void {
  editor.transact(() => {
    const definitions: string[] = [];
    visitFootnoteBlocks(editor, (block) => {
      if (Array.isArray(block.content)) {
        const content = block.content.filter((item: any) =>
          item.type !== "footnoteReference" || item.props?.label !== label
        );
        if (content.length !== block.content.length) editor.updateBlock(block, { content });
      }
      if (block.type === "footnoteDefinition" && block.props?.label === label) definitions.push(block.id);
    });
    if (definitions.length) editor.removeBlocks(definitions);
  });
}

function revealFootnote(label: string, destination: "definition" | "reference"): void {
  const selector = destination === "definition" ? ".footnote-definition" : ".footnote-reference";
  const target = [...document.querySelectorAll<HTMLElement>(selector)]
    .find((element) => element.dataset.footnoteLabel === label);
  if (!target) return;
  target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  target.classList.add("footnote-linked");
  window.setTimeout(() => target.classList.remove("footnote-linked"), 1200);
}

const InlineMath = createReactInlineContentSpec(
  {
    type: "inlineMath",
    propSchema: { formula: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent, updateInlineContent }) => {
      const formula = inlineContent.props.formula;
      return <span
        className="inline-math"
        contentEditable={false}
        title={`$${formula}$ — double-click to edit`}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const next = window.prompt("Inline LaTeX", formula);
          if (next !== null) updateInlineContent({ type: "inlineMath", props: { formula: next } });
        }}
        dangerouslySetInnerHTML={{ __html: renderedLatex(formula, false) }}
      />;
    },
    toExternalHTML: ({ inlineContent }) => <span data-arbor-inline-math={inlineContent.props.formula}>{`$${inlineContent.props.formula}$`}</span>,
    parse: (element) => {
      const formula = element.getAttribute("data-arbor-inline-math");
      return formula === null ? undefined : { formula };
    },
  },
);

const FootnoteReference = createReactInlineContentSpec(
  {
    type: "footnoteReference",
    propSchema: { label: { default: "1" } },
    content: "none",
  },
  {
    render: ({ inlineContent, editor }) => {
      const label = inlineContent.props.label;
      const number = useFootnoteNumber(editor, label);
      const missing = !footnoteDefinitions(editor).has(label);
      return <sup
        className={`footnote-reference${missing ? " missing" : ""}`}
        contentEditable={false}
        data-footnote-label={label}
        title={missing ? `Missing footnote definition [^${label}]` : `Footnote ${number} [^${label}]`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          revealFootnote(label, "definition");
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const next = window.prompt("Footnote label", label)?.trim();
          if (next && next !== label) renameFootnote(editor, label, next);
        }}
      >{missing ? `${number}?` : number}</sup>;
    },
    toExternalHTML: ({ inlineContent }) => <sup data-arbor-footnote={inlineContent.props.label}>{`[^${inlineContent.props.label}]`}</sup>,
    parse: (element) => {
      const label = element.getAttribute("data-arbor-footnote");
      return label ? { label } : undefined;
    },
  },
);

const MathBlock = createReactBlockSpec(
  { type: "mathBlock", propSchema: { formula: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => <div
      className="math-block"
      contentEditable={false}
      title="Double-click to edit LaTeX"
      onDoubleClick={() => {
        const next = window.prompt("Display LaTeX", block.props.formula);
        if (next !== null) editor.updateBlock(block, { props: { formula: next } });
      }}
      dangerouslySetInnerHTML={{ __html: renderedLatex(block.props.formula, true) }}
    />,
    toExternalHTML: ({ block }) => <div data-arbor-math="true">{`$$\n${block.props.formula}\n$$`}</div>,
  },
)();

const FootnoteDefinitionBlock = createReactBlockSpec(
  { type: "footnoteDefinition", propSchema: { label: { default: "1" } }, content: "inline" },
  {
    render: ({ block, editor, contentRef }) => {
      const number = useFootnoteNumber(editor, block.props.label);
      const referenced = (() => {
        let found = false;
        visitFootnoteBlocks(editor, (candidate) => {
          if (Array.isArray(candidate.content) && candidate.content.some((item: any) =>
            item.type === "footnoteReference" && item.props?.label === block.props.label
          )) found = true;
        });
        return found;
      })();
      return <div
        className={`footnote-definition${!referenced ? " orphan" : ""}`}
        data-footnote-block={block.id}
        data-footnote-label={block.props.label}
        data-footnote-referenced={referenced ? "true" : "false"}
      >
        <span className="footnote-definition-number" contentEditable={false} title={`[^${block.props.label}]`}>{number}.</span>
        <span className="footnote-definition-content" ref={contentRef} />
        <span className="footnote-definition-actions" contentEditable={false}>
          {!referenced && <span className="footnote-orphan-label">Unreferenced</span>}
          {referenced && <button
            type="button"
            aria-label={`Return to footnote ${number} reference`}
            title="Return to reference"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              revealFootnote(block.props.label, "reference");
            }}
          >↩</button>}
          <button
            type="button"
            className="footnote-delete"
            aria-label={`Delete footnote ${number}`}
            title="Delete footnote and all references"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (window.confirm(`Delete footnote ${number} and all of its references?`)) {
                deleteFootnote(editor, block.props.label);
              }
            }}
          >×</button>
        </span>
      </div>;
    },
    toExternalHTML: ({ block, contentRef }) => <div data-arbor-footnote-definition={block.props.label}><sup>{block.props.label}</sup><span ref={contentRef} /></div>,
  },
)();

export interface ManagedRowsController {
  resolve(rawPath: string, blockID: string): string | null;
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
  const path = block?.type === "standaloneLink"
    ? controller?.resolve(String(block.props.path ?? ""), block.id) ?? null
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
  const path = block?.type === "standaloneLink"
    ? controller?.resolve(String(block.props.path ?? ""), block.id) ?? null
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
  {
    type: "standaloneLink",
    propSchema: {
      path: { default: "" },
      arborGenerated: { default: false },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef }) => {
      const controller = useContext(ManagedRowsContext);
      const path = controller?.resolve(block.props.path, block.id) ?? null;
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
  blockSpecs: {
    ...defaultBlockSpecs,
    rawMarkdown: RawMarkdownBlock,
    standaloneLink: ChildPageBlock,
    mathBlock: MathBlock,
    footnoteDefinition: FootnoteDefinitionBlock,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    inlineMath: InlineMath,
    footnoteReference: FootnoteReference,
  },
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
  createExtension({
    key: "arbor-markdown-extensions",
    inputRules: [
      {
        find: /^\$\$\s$/,
        replace: () => ({ type: "mathBlock", props: { formula: "" } }),
      },
      {
        find: /^\[\^([^\]\s]+)\]:\s$/,
        replace: ({ match }) => ({
          type: "footnoteDefinition",
          props: { label: match[1] ?? "1" },
        }),
      },
    ],
    plugins: [
      new Plugin({
        props: {
          handleTextInput(view, from, to, text) {
            const resolved = view.state.doc.resolve(from);
            if (!resolved.parent.isTextblock) return false;
            const before = resolved.parent.textBetween(0, resolved.parentOffset, "\n", "\ufffc");
            if (text === "]") {
              const match = before.match(/\[\^([A-Za-z0-9][\w.-]*)$/);
              const nodeType = view.state.schema.nodes.footnoteReference;
              if (match && nodeType) {
                view.dispatch(view.state.tr.replaceWith(
                  from - match[0].length,
                  to,
                  nodeType.create({ label: match[1] }),
                ));
                return true;
              }
            }
            if (text === "$") {
              const opener = before.lastIndexOf("$");
              const formula = opener >= 0 ? before.slice(opener + 1) : "";
              const previous = opener > 0 ? before[opener - 1] : "";
              const nodeType = view.state.schema.nodes.inlineMath;
              if (opener >= 0 && formula && previous !== "\\" && previous !== "$" && !formula.includes("$") && nodeType) {
                view.dispatch(view.state.tr.replaceWith(
                  from - formula.length - 1,
                  to,
                  nodeType.create({ formula }),
                ));
                return true;
              }
            }
            return false;
          },
        },
      }),
    ],
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

export function getArborSlashMenuItems(editor: ArborBlockNoteEditor): DefaultReactSuggestionItem[] {
  const insertEquation = (display: boolean) => {
    const formula = window.prompt(display ? "Display LaTeX" : "Inline LaTeX", "");
    if (formula === null) return;
    if (display) {
      editor.updateBlock(editor.getTextCursorPosition().block, {
        type: "mathBlock",
        props: { formula },
      });
    } else {
      editor.insertInlineContent([
        { type: "inlineMath", props: { formula } },
        " ",
      ]);
    }
  };
  return [
    ...getDefaultReactSlashMenuItems(editor),
    {
      title: "Equation",
      subtext: "A displayed LaTeX equation",
      aliases: ["latex", "math", "formula"],
      group: "Other",
      icon: <span className="slash-symbol">∑</span>,
      onItemClick: () => insertEquation(true),
    },
    {
      title: "Inline equation",
      subtext: "LaTeX within the current paragraph",
      aliases: ["latex", "math", "formula"],
      group: "Other",
      icon: <span className="slash-symbol">𝑥</span>,
      onItemClick: () => insertEquation(false),
    },
    {
      title: "Footnote",
      subtext: "Insert a reference and its definition",
      aliases: ["note", "citation", "reference"],
      group: "Other",
      icon: <span className="slash-symbol">¹</span>,
      onItemClick: () => {
        const labels = footnoteLabels(editor);
        let ordinal = 1;
        while (labels.includes(String(ordinal))) ordinal += 1;
        const label = String(ordinal);
        const note = window.prompt("Footnote text", "");
        if (note === null) return;
        editor.insertInlineContent([{ type: "footnoteReference", props: { label } }, " "]);
        editor.insertBlocks(
          [{ type: "footnoteDefinition", props: { label }, content: note }],
          editor.document.at(-1)!,
          "after",
        );
      },
    },
  ];
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

interface ProtectedInlineToken {
  source: string;
  content: {
    type: "inlineMath" | "footnoteReference";
    props: { formula?: string; label?: string };
  };
}

function backtickRun(source: string, start: number): number {
  let end = start;
  while (source[end] === "`") end += 1;
  return end - start;
}

function codeSpanEnd(source: string, start: number, length: number): number {
  let cursor = start + length;
  while (cursor < source.length) {
    if (source[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const run = backtickRun(source, cursor);
    if (run === length) return cursor + length;
    cursor += run;
  }
  return start + length;
}

function protectArborInlineSyntax(source: string): {
  markdown: string;
  tokens: Map<string, ProtectedInlineToken>;
} {
  const tokens = new Map<string, ProtectedInlineToken>();
  let markdown = "";
  let cursor = 0;
  const addToken = (token: ProtectedInlineToken) => {
    let placeholder = `ARBORNOTETOKEN${tokens.size}X`;
    while (source.includes(placeholder) || markdown.includes(placeholder)) placeholder += "X";
    tokens.set(placeholder, token);
    markdown += placeholder;
  };

  while (cursor < source.length) {
    const character = source[cursor]!;
    if (character === "\\") {
      markdown += source.slice(cursor, Math.min(source.length, cursor + 2));
      cursor += 2;
      continue;
    }
    if (character === "`") {
      const length = backtickRun(source, cursor);
      const end = codeSpanEnd(source, cursor, length);
      markdown += source.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (source.startsWith("[^", cursor)) {
      const match = source.slice(cursor).match(/^\[\^([^\]\s]+)\]/);
      if (match) {
        addToken({
          source: match[0],
          content: { type: "footnoteReference", props: { label: match[1] ?? "" } },
        });
        cursor += match[0].length;
        continue;
      }
    }
    if (character === "$" && source[cursor + 1] === "$") {
      markdown += "$$";
      cursor += 2;
      continue;
    }
    if (character === "$") {
      let end = cursor + 1;
      while (end < source.length && source[end] !== "\n") {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === "$") break;
        end += 1;
      }
      if (end < source.length && end > cursor + 1 && source[end] === "$") {
        const formula = source.slice(cursor + 1, end);
        addToken({
          source: source.slice(cursor, end + 1),
          content: { type: "inlineMath", props: { formula } },
        });
        cursor = end + 1;
        continue;
      }
    }
    markdown += character;
    cursor += 1;
  }

  return { markdown, tokens };
}

function restoreTextTokens(item: any, tokens: Map<string, ProtectedInlineToken>, customContent: boolean): any[] {
  const restored: any[] = [];
  let text = item.text;
  while (text) {
    let found: { index: number; placeholder: string; token: ProtectedInlineToken } | null = null;
    for (const [placeholder, token] of tokens) {
      const index = text.indexOf(placeholder);
      if (index >= 0 && (!found || index < found.index)) found = { index, placeholder, token };
    }
    if (!found) {
      restored.push({ ...item, text });
      break;
    }
    if (found.index > 0) restored.push({ ...item, text: text.slice(0, found.index) });
    restored.push(customContent ? found.token.content : { ...item, text: found.token.source });
    text = text.slice(found.index + found.placeholder.length);
  }
  return restored;
}

function restoreArborInlineSyntax(content: any[], tokens: Map<string, ProtectedInlineToken>): any[] {
  const restored: any[] = [];
  for (const item of content) {
    if (item.type === "text") {
      restored.push(...restoreTextTokens(item, tokens, true));
    } else if (item.type === "link" && Array.isArray(item.content)) {
      restored.push({
        ...item,
        content: item.content.flatMap((part: any) =>
          part.type === "text" ? restoreTextTokens(part, tokens, false) : [part]
        ),
      });
    } else {
      restored.push(item);
    }
  }
  return restored;
}

function inlineMarkdown(editor: ArborBlockNoteEditor, source: string): any[] {
  const protectedSource = protectArborInlineSyntax(source);
  const parsed = editor.tryParseMarkdownToBlocks(`${inlineMarkdownPrefix}${protectedSource.markdown}`);
  const content = parsed[0]?.content;
  if (!Array.isArray(content)) return plainInlineContent(source);
  const result = structuredClone(content) as any[];
  const first = result[0];
  if (first?.type !== "text" || typeof first.text !== "string" || !first.text.startsWith(inlineMarkdownPrefix)) {
    return plainInlineContent(source);
  }
  first.text = first.text.slice(inlineMarkdownPrefix.length);
  if (!first.text) result.shift();
  return restoreArborInlineSyntax(result, protectedSource.tokens);
}

function inlineMarkdownOf(editor: ArborBlockNoteEditor, content: ArborEditorBlock["content"], original?: ArborBlock): string {
  if (!Array.isArray(content)) return "";
  if (original && JSON.stringify(content) === JSON.stringify(inlineMarkdown(editor, original.content ?? ""))) {
    return original.content ?? "";
  }
  const replacements = new Map<string, string>();
  const markdownContent = content.map((item: any, index) => {
    if (item.type !== "inlineMath" && item.type !== "footnoteReference") return item;
    const token = `ARBORINLINE${index}PLACEHOLDER`;
    replacements.set(token, item.type === "inlineMath"
      ? `$${String(item.props?.formula ?? "")}$`
      : `[^${String(item.props?.label ?? "1")}]`);
    return { type: "text", text: token, styles: {} };
  });
  let markdown = editor.blocksToMarkdownLossy([{ type: "paragraph", content: markdownContent }]).replace(/\r?\n+$/, "");
  for (const [token, replacement] of replacements) markdown = markdown.replaceAll(token, replacement);
  return markdown;
}

function literalContentOf(content: ArborEditorBlock["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => item.type === "text"
    ? item.text
    : item.type === "link"
      ? item.content.map((part: { text: string }) => part.text).join("")
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
    case "mathBlock": return { id: block.id, type: "mathBlock", props: { formula: block.content ?? "" } };
    case "footnoteDefinition": return {
      id: block.id,
      type: "footnoteDefinition",
      props: { label: String(block.props?.label ?? "1") },
      content: inlineMarkdown(editor, block.content ?? ""),
      children,
    };
    case "image": return { id: block.id, type: "image", props: { url: String(block.props?.url ?? ""), caption: String(block.props?.caption ?? "") } };
    case "standaloneLink": return {
      id: block.id,
      type: "standaloneLink",
      props: {
        path: String(block.props?.path ?? ""),
        arborGenerated: Boolean(block.props?.arborGenerated),
      },
      content: inlineMarkdown(editor, block.content ?? ""),
    };
    case "rawMarkdown": return {
      id: block.id,
      type: "rawMarkdown",
      props: {
        blank: Boolean(block.props?.blank),
        arborChildrenMarker: Boolean(block.props?.arborChildrenMarker),
      },
      content: block.content ?? "",
    };
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
    case "mathBlock": type = "mathBlock"; break;
    case "footnoteDefinition": type = "footnoteDefinition"; break;
    case "image": type = "image"; break;
    case "rawMarkdown": type = "rawMarkdown"; break;
    case "standaloneLink": type = "standaloneLink"; break;
    default: type = original?.type === "rawMarkdown" && original.props?.blank ? "rawMarkdown" : "paragraph";
  }
  const props: Record<string, string | number | boolean> = {};
  if (block.type === "heading") props.level = block.props.level;
  if (block.type === "checkListItem") props.checked = block.props.checked;
  if (block.type === "codeBlock") props.language = block.props.language;
  if (block.type === "footnoteDefinition") props.label = block.props.label;
  if (block.type === "image") { props.url = block.props.url; props.caption = block.props.caption; }
  if (block.type === "rawMarkdown") {
    props.blank = block.props.blank;
    props.arborChildrenMarker = block.props.arborChildrenMarker;
  }
  if (block.type === "standaloneLink") {
    props.path = block.props.path;
    props.arborGenerated = block.props.arborGenerated;
  }
  return {
    id: block.id,
    type,
    content: block.type === "image" || block.type === "divider"
      ? ""
      : block.type === "mathBlock"
        ? block.props.formula
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
