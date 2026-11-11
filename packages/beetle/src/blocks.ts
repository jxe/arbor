// View blocks in pages (spec 1.5 §3.7): fenced code blocks whose info string is `view`.
// All of a page's blocks are one source; positions stay the page's own lines.

import type { Diagnostic, Span, ViewFile } from "./ast.ts";
import { parseView } from "./parse.ts";

export interface ViewBlock {
  /** The block's text, without its fences. */
  text: string;
  /** The page line (1-based) of the block's first line of text. */
  line: number;
}

export interface PageSource {
  file: ViewFile;
  diagnostics: Diagnostic[];
  blocks: { span: Span; elements: number }[];
}

/** The page's view blocks, in order. */
export function viewBlocks(markdown: string): ViewBlock[] {
  const lines = markdown.split("\n").map((line) => line.replace(/\r$/, ""));
  const blocks: ViewBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    let end = i + 1;
    while (end < lines.length && !new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[end]!)) end += 1;
    if (open[2] === "view") blocks.push({ text: lines.slice(i + 1, end).join("\n"), line: i + 2 });
    i = end;
  }
  return blocks;
}

/** Moves every position in `value` down by `lines`. */
function shift<T>(value: T, lines: number): T {
  if (Array.isArray(value)) {
    for (const item of value) shift(item, lines);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.line === "number") record.line += lines;
    if (typeof record.endLine === "number") record.endLine += lines;
    for (const [key, child] of Object.entries(record)) if (key !== "line" && key !== "endLine") shift(child, lines);
  }
  return value;
}

/** A page's view blocks as one source. */
export function pageSource(markdown: string): PageSource {
  const file: ViewFile = { declarations: [] };
  const diagnostics: Diagnostic[] = [];
  const blocks: PageSource["blocks"] = [];
  for (const block of viewBlocks(markdown)) {
    const parsed = parseView(block.text);
    shift(parsed.file, block.line - 1);
    shift(parsed.diagnostics, block.line - 1);
    file.declarations.push(...parsed.file.declarations);
    diagnostics.push(...parsed.diagnostics);
    const lineCount = block.text.split("\n").length;
    blocks.push({
      span: { line: block.line - 1, column: 1, endLine: block.line + lineCount, endColumn: 4 },
      elements: parsed.file.declarations.filter((d) => d.decl.kind === "element").length,
    });
  }
  return { file, diagnostics, blocks };
}

/** The page with each view block's text in the conventional form; prose is untouched. */
export function formatPage(markdown: string, format: (text: string) => string): string {
  const lines = markdown.split("\n");
  for (const block of [...viewBlocks(markdown)].reverse()) {
    const count = block.text.split("\n").length;
    const formatted = format(block.text).replace(/\n$/, "");
    lines.splice(block.line - 1, count, ...formatted.split("\n"));
  }
  return lines.join("\n");
}
