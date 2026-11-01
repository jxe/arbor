/**
 * Markdown as blocks (overstoryd 017). A version of a document is read as
 * blocks: front matter, headings, paragraphs, list items, block quotes, fenced
 * and indented code, tables, HTML blocks and thematic breaks. Each block has
 * the attributes its author gave it (kind, heading level, list marker, task
 * state, fence language, container) and inline content.
 *
 * Blocks are matched across versions by piece identity: a block is named by
 * the origin coordinate of its first content byte, so a moved, renumbered or
 * re-indented block keeps its name. A merge is valid when every block of the
 * result has the attributes and inline structure its last editor gave it, no
 * block appears that neither side wrote, and no block that both sides kept
 * disappears. Anything else is a conflict about the blocks involved, never
 * about the whole document.
 */
import type { Piece } from "./intent-model.ts";
import { elementMerge, type Element, type ElementReader, type ElementVerdict } from "./elements.ts";

export interface MarkdownBlock extends Element {
  /** Byte range of the whole block, markers and continuation lines included. */
  start: number;
  end: number;
  /** First byte of the block's content (after its markers). */
  content: number;
  kind: string;
  /** Kind-specific attributes: heading level, list marker, task state, fence. */
  attributes: string;
  /** The containing list item or block quote, by index, or -1 at top level. */
  parent: number;
  /** The block's inline syntax: content with plain text removed. */
  inline: string;
  /** Fenced code and front matter: the language of the embedded source. */
  language?: string;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

interface Container {
  index: number;
  kind: "item" | "quote";
  /** Columns a continuation line must be indented by to stay inside an item. */
  indent: number;
}

/** The blocks of `source`, or null when it holds an unclosed fence or front matter. */
export function markdownBlocks(source: string): MarkdownBlock[] | null {
  const blocks: MarkdownBlock[] = [];
  const lines = source.split(/(?<=\n)/);
  let offset = 0;
  const stack: Container[] = [];
  /** The paragraph, fence or table a following line may continue. */
  let open: { index: number; kind: "paragraph" | "fence" | "table" | "html" | "code" | "front"; marker?: string; indent?: number } | undefined;
  let blank = false;
  const close = (at: number) => {
    if (open) blocks[open.index]!.end = at;
    open = undefined;
  };
  const extend = (index: number, end: number) => {
    for (let i: number = index; i >= 0; i = blocks[i]!.parent) blocks[i]!.end = Math.max(blocks[i]!.end, end);
  };
  const push = (block: Omit<MarkdownBlock, "parent">, lineEnd: number) => {
    const parent = stack.at(-1)?.index ?? -1;
    blocks.push({ ...block, parent });
    extend(parent, lineEnd);
    return blocks.length - 1;
  };
  for (const [number, line] of lines.entries()) {
    const ending = /\r?\n$/.exec(line)?.[0] ?? "";
    const body = line.slice(0, line.length - ending.length);
    const lineStart = offset, lineEnd = offset + bytes(line);
    offset = lineEnd;
    // Front matter and fences take every line until they close.
    if (open?.kind === "front") {
      if (body === "---" || body === "...") { blocks[open.index]!.end = lineEnd; open = undefined; }
      else blocks[open.index]!.end = lineEnd;
      continue;
    }
    if (open?.kind === "fence") {
      const block = blocks[open.index]!;
      block.end = lineEnd; extend(block.parent, lineEnd);
      const closing = new RegExp(`^ {0,3}${open.marker![0] === "`" ? "`" : "~"}{${open.marker!.length},}\\s*$`);
      if (closing.test(body.slice(Math.min(open.indent ?? 0, leading(body))))) open = undefined;
      continue;
    }
    if (number === 0 && body === "---") {
      open = { index: push({ start: lineStart, end: lineEnd, content: lineEnd, kind: "front", attributes: "", inline: "", language: "yaml" }, lineEnd), kind: "front" };
      continue;
    }
    if (!body.trim()) {
      if (open?.kind === "paragraph" || open?.kind === "table" || open?.kind === "html") close(lineStart);
      blank = true;
      continue;
    }
    // Leave containers this line is not indented into (a quote needs its marker).
    let column = leading(body), rest = body, restStart = lineStart;
    let depth = 0;
    for (const container of stack) {
      if (container.kind === "quote") {
        const quote = /^ {0,3}> ?/.exec(rest);
        if (!quote) break;
        rest = rest.slice(quote[0].length); restStart += bytes(quote[0]);
      } else {
        if (leading(rest) < container.indent) {
          // A lazy continuation of an open paragraph stays where it is.
          if (open?.kind === "paragraph" && !blank && !startsBlock(rest)) { depth = stack.length; break; }
          break;
        }
        rest = rest.slice(container.indent); restStart += container.indent;
      }
      depth++;
    }
    if (depth < stack.length) {
      close(lineStart);
      stack.length = depth;
    }
    column = leading(rest);
    // Lazy and ordinary paragraph continuation.
    if (open?.kind === "paragraph" && !blank && !startsBlock(rest)) {
      const block = blocks[open.index]!;
      block.end = lineEnd; extend(block.parent, lineEnd);
      block.inline += inlineSyntax(rest.trim());
      continue;
    }
    if (open?.kind === "table" && !blank && rest.includes("|")) {
      const block = blocks[open.index]!;
      block.end = lineEnd; extend(block.parent, lineEnd);
      block.inline += "\n" + tableShape(rest);
      continue;
    }
    if (open?.kind === "html" && !blank) {
      const block = blocks[open.index]!;
      block.end = lineEnd; extend(block.parent, lineEnd);
      continue;
    }
    close(lineStart);
    blank = false;
    // Container starts: block quotes and list items, possibly several on one line.
    for (;;) {
      const quote = /^ {0,3}> ?/.exec(rest);
      if (quote) {
        const index = push({ start: restStart, end: lineEnd, content: restStart + bytes(quote[0]), kind: "quote", attributes: "", inline: "" }, lineEnd);
        stack.push({ index, kind: "quote", indent: 0 });
        rest = rest.slice(quote[0].length); restStart += bytes(quote[0]);
        continue;
      }
      const item = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)(\[[ xX]\]( |$))?/.exec(rest);
      if (item && !/^ {0,3}([-*_])( *\1){2,} *$/.test(rest)) {
        const marker = item[2]!, ordered = /\d/.test(marker);
        const spaces = item[3]!.length > 4 ? 1 : Math.max(1, item[3]!.length);
        const width = item[1]!.length + marker.length + spaces;
        const task = item[4] ? (/[xX]/.test(item[4]) ? "done" : "open") : "";
        const prefix = item[0]!;
        const attributes = JSON.stringify([ordered ? marker.slice(-1) : marker, ordered ? Number(marker.slice(0, -1)) : null, task]);
        const index = push({ start: restStart, end: lineEnd, content: restStart + bytes(prefix), kind: "item", attributes, inline: "" }, lineEnd);
        stack.push({ index, kind: "item", indent: width });
        rest = rest.slice(prefix.length); restStart += bytes(prefix);
        if (!rest.trim()) break;
        continue;
      }
      break;
    }
    if (!rest.trim()) continue;
    column = leading(rest);
    const content = restStart + bytes(rest.slice(column));
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(rest);
    if (fence) {
      open = { index: push({ start: restStart, end: lineEnd, content: lineEnd, kind: "fence", attributes: JSON.stringify([fence[2]]), inline: "", language: fence[2] ?? "" }, lineEnd), kind: "fence", marker: fence[1]!, indent: column };
      continue;
    }
    if (column >= 4 && open === undefined && !stack.length) {
      push({ start: restStart, end: lineEnd, content, kind: "code", attributes: "", inline: "" }, lineEnd);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(rest);
    if (heading) {
      push({ start: restStart, end: lineEnd, content: restStart + bytes(heading[0]), kind: "heading", attributes: String(heading[1]!.length), inline: inlineSyntax(rest.slice(heading[0].length)) }, lineEnd);
      continue;
    }
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(rest)) {
      // A `---` under a paragraph would be a setext heading; an empty line separates them here.
      push({ start: restStart, end: lineEnd, content, kind: "break", attributes: "", inline: "" }, lineEnd);
      continue;
    }
    if (/^ {0,3}</.test(rest)) {
      open = { index: push({ start: restStart, end: lineEnd, content, kind: "html", attributes: "", inline: "" }, lineEnd), kind: "html" };
      continue;
    }
    const next = lines[number + 1]?.replace(/\r?\n$/, "");
    if (rest.includes("|") && next !== undefined && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(next)) {
      open = { index: push({ start: restStart, end: lineEnd, content, kind: "table", attributes: "", inline: tableShape(rest) }, lineEnd), kind: "table" };
      continue;
    }
    open = { index: push({ start: restStart, end: lineEnd, content, kind: "paragraph", attributes: "", inline: inlineSyntax(rest.trim()) }, lineEnd), kind: "paragraph" };
  }
  if (open?.kind === "front" || open?.kind === "fence") return null;
  return blocks;
}

const leading = (text: string) => /^[ \t]*/.exec(text)![0].replace(/\t/g, "    ").length;
/** Whether a line opens a block that interrupts a paragraph. */
const startsBlock = (text: string) =>
  /^ {0,3}(#{1,6}(\s|$)|>|`{3,}|~{3,}|[-+*](\s|$)|1[.)](\s|$)|([-*_])( *\5){2,} *$|<)/.test(text);
/** Inline syntax that changes how a block reads: emphasis, code, links, HTML. */
const inlineSyntax = (text: string) => text.replace(/[^`*_\[\]()<>\\!]/g, "");
const tableShape = (row: string) => row.split("|").map((cell) => (/^\s*:?-+:?\s*$/.test(cell) ? cell.trim() : cell.trim() ? "c" : "")).join("|");


/** Markdown as elements: its blocks, with headings opening sections. */
export const markdownReader: ElementReader = {
  read: (source) => markdownBlocks(source)?.map((b) => ({ ...b, container: b.kind === "item" || b.kind === "quote" })) ?? null,
  sections: new Set(["heading"]),
  splits: true,
  merged: "Every block keeps the kind, place and inline syntax its last editor gave it",
};

export type BlockVerdict = ElementVerdict;
/** Check a proposed Markdown merge block by block. */
export const markdownBlockMerge = (sources: string[], pieces: Piece[][]): BlockVerdict | null =>
  elementMerge(sources, pieces, markdownReader);
