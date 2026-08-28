import { parseDocument, type Document as YamlDocument } from "yaml";
import { sha256 } from "../../core/src/hash.ts";
import type { ArborBlock, MarkdownDocument } from "@arbor/core";

interface SourceLine {
  text: string;
  eol: string;
  full: string;
}

function linesOf(source: string): SourceLine[] {
  const matches = source.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
  return matches
    .filter((value, index) => value.length > 0 || index < matches.length - 1)
    .map((full) => {
      const eol = full.endsWith("\r\n") ? "\r\n" : full.endsWith("\n") ? "\n" : full.endsWith("\r") ? "\r" : "";
      return { full, eol, text: eol ? full.slice(0, -eol.length) : full };
    });
}

function semanticValue(block: ArborBlock): unknown {
  return {
    type: block.type,
    content: block.content ?? "",
    props: block.props ?? {},
    children: block.children.map(semanticValue),
  };
}

export function blockFingerprint(block: ArborBlock): string {
  return sha256(JSON.stringify(semanticValue(block)));
}

function makeBlock(
  type: ArborBlock["type"],
  source: string,
  content = "",
  props: ArborBlock["props"] = {},
  children: ArborBlock[] = [],
  ordinal = 0,
): ArborBlock {
  const block: ArborBlock = {
    id: `b-${sha256(`${ordinal}\0${source}`).slice(0, 12)}`,
    type,
    content,
    props,
    children,
    source,
  };
  block.sourceHash = blockFingerprint(block);
  return block;
}

function indentation(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === " ") count += 1;
    else if (character === "\t") count += 2;
    else break;
  }
  return count;
}

function isFence(text: string): { marker: "`" | "~"; length: number } | null {
  const match = text.trimStart().match(/^(`{3,}|~{3,})/);
  return match?.[1] ? { marker: match[1][0] as "`" | "~", length: match[1].length } : null;
}

function isClosingFence(text: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const pattern = fence.marker === "`" ? /^`+\s*$/ : /^~+\s*$/;
  const trimmed = text.trimStart();
  return pattern.test(trimmed) && trimmed.match(/^[`~]+/)![0].length >= fence.length;
}

function consumeTrailingBlank(lines: SourceLine[], end: number): number {
  while (end < lines.length && lines[end]!.text.trim() === "") end += 1;
  return end;
}

function dedent(source: string, spaces: number): string {
  return linesOf(source)
    .map((line) => {
      if (!line.text.trim()) return line.full;
      let removed = 0;
      let index = 0;
      while (index < line.text.length && removed < spaces) {
        if (line.text[index] === " ") removed += 1;
        else if (line.text[index] === "\t") removed += 2;
        else break;
        index += 1;
      }
      return line.text.slice(index) + line.eol;
    })
    .join("");
}

function toggleExtent(lines: SourceLine[], start: number, baseIndent: number): number {
  return indentedExtent(lines, start, baseIndent + 2);
}

function indentedExtent(lines: SourceLine[], start: number, minimumIndent: number): number {
  let index = start + 1;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  while (index < lines.length) {
    const line = lines[index]!;
    if (fence) {
      if (isClosingFence(line.text, fence)) fence = null;
      index += 1;
      continue;
    }
    const opening = isFence(line.text);
    if (opening && indentation(line.text) >= minimumIndent) {
      fence = opening;
      index += 1;
      continue;
    }
    if (!line.text.trim() || indentation(line.text) >= minimumIndent) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function isBlockStart(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    /^#{1,6}\s/.test(trimmed) ||
    /^▸\s/.test(trimmed) ||
    /^([-+*])\s/.test(trimmed) ||
    /^\d+[.)]\s/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^\[\^[^\]\s]+\]:/.test(trimmed) ||
    /^\$\$/.test(trimmed) ||
    /^(`{3,}|~{3,})/.test(trimmed) ||
    /^<([A-Za-z][\w-]*)(\s|>|$)/.test(trimmed) ||
    /^(---+|___+|\*\*\*+)\s*$/.test(trimmed)
  );
}

function parseBlocks(source: string): ArborBlock[] {
  const lines = linesOf(source);
  const blocks: ArborBlock[] = [];
  let index = 0;
  let ordinal = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.text.trimStart();
    const baseIndent = indentation(line.text);

    if (!trimmed) {
      const start = index;
      while (index < lines.length && !lines[index]!.text.trim()) index += 1;
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("rawMarkdown", raw, raw, { blank: true }, [], ordinal++));
      continue;
    }

    const toggle = trimmed.match(/^▸\s(.*)$/);
    if (toggle) {
      const end = toggleExtent(lines, index, baseIndent);
      const raw = lines.slice(index, end).map((value) => value.full).join("");
      const childRaw = lines.slice(index + 1, end).map((value) => value.full).join("");
      const children = childRaw ? parseBlocks(dedent(childRaw, baseIndent + 2)) : [];
      blocks.push(makeBlock("toggle", raw, toggle[1] ?? "", {}, children, ordinal++));
      index = end;
      continue;
    }

    const fence = isFence(line.text);
    if (fence) {
      const start = index++;
      while (index < lines.length) {
        const current = lines[index++]!;
        if (isClosingFence(current.text, fence)) break;
      }
      index = consumeTrailingBlank(lines, index);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      const rawLines = lines.slice(start, index);
      const first = rawLines[0]!.text.trimStart();
      const language = first.slice(fence.length).trim();
      let codeEnd = rawLines.length;
      while (codeEnd > 1 && !rawLines[codeEnd - 1]!.text.trim()) codeEnd -= 1;
      if (codeEnd > 1 && isClosingFence(rawLines[codeEnd - 1]!.text, fence)) codeEnd -= 1;
      const content = rawLines.slice(1, codeEnd).map((value) => value.full).join("").replace(/(?:\r\n|\n|\r)$/, "");
      blocks.push(makeBlock("codeBlock", raw, content, { language }, [], ordinal++));
      continue;
    }

    const oneLineMath = trimmed.match(/^\$\$\s*(.*?)\s*\$\$\s*$/);
    if (oneLineMath && oneLineMath[1]) {
      const start = index;
      index = consumeTrailingBlank(lines, index + 1);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("mathBlock", raw, oneLineMath[1], {}, [], ordinal++));
      continue;
    }

    if (/^\$\$\s*$/.test(trimmed)) {
      const start = index++;
      while (index < lines.length && !/^\$\$\s*$/.test(lines[index]!.text.trimStart())) index += 1;
      if (index < lines.length) index += 1;
      index = consumeTrailingBlank(lines, index);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      const rawLines = lines.slice(start, index);
      let mathEnd = rawLines.length;
      while (mathEnd > 1 && !rawLines[mathEnd - 1]!.text.trim()) mathEnd -= 1;
      if (mathEnd > 1 && /^\$\$\s*$/.test(rawLines[mathEnd - 1]!.text.trimStart())) mathEnd -= 1;
      const content = rawLines.slice(1, mathEnd).map((value) => value.full).join("").replace(/(?:\r\n|\n|\r)$/, "");
      blocks.push(makeBlock("mathBlock", raw, content, {}, [], ordinal++));
      continue;
    }

    const footnote = trimmed.match(/^\[\^([^\]\s]+)\]:\s*(.*)$/);
    if (footnote) {
      const start = index;
      const end = indentedExtent(lines, index, baseIndent + 4);
      const raw = lines.slice(start, end).map((value) => value.full).join("");
      let childEnd = end;
      while (childEnd > start + 1 && !lines[childEnd - 1]!.text.trim()) childEnd -= 1;
      const childRaw = lines.slice(start + 1, childEnd).map((value) => value.full).join("");
      const children = childRaw ? parseBlocks(dedent(childRaw, baseIndent + 4)) : [];
      blocks.push(makeBlock(
        "footnoteDefinition",
        raw,
        footnote[2] ?? "",
        { label: footnote[1] ?? "" },
        children,
        ordinal++,
      ));
      index = end;
      continue;
    }

    if (/^<details(?:\s|>)/i.test(trimmed)) {
      const start = index++;
      while (index < lines.length && !/<\/details\s*>/i.test(lines[index - 1]!.text)) index += 1;
      index = consumeTrailingBlank(lines, index);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("rawMarkdown", raw, raw, { format: "html" }, [], ordinal++));
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const start = index;
      index = consumeTrailingBlank(lines, index + 1);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("heading", raw, heading[2] ?? "", { level: heading[1]!.length }, [], ordinal++));
      continue;
    }

    const task = trimmed.match(/^[-+*]\s+\[([ xX])\]\s+(.*)$/);
    const bullet = trimmed.match(/^[-+*]\s+(.*)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (task || bullet || numbered) {
      const start = index;
      const end = toggleExtent(lines, index, baseIndent);
      const raw = lines.slice(start, end).map((value) => value.full).join("");
      const childRaw = lines.slice(start + 1, end).map((value) => value.full).join("");
      const children = childRaw ? parseBlocks(dedent(childRaw, baseIndent + 2)) : [];
      if (task) blocks.push(makeBlock("checkListItem", raw, task[2] ?? "", { checked: task[1]!.toLowerCase() === "x" }, children, ordinal++));
      else if (numbered) blocks.push(makeBlock("numberedListItem", raw, numbered[1] ?? "", {}, children, ordinal++));
      else blocks.push(makeBlock("bulletListItem", raw, bullet?.[1] ?? "", {}, children, ordinal++));
      index = end;
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      const start = index;
      index = consumeTrailingBlank(lines, index + 1);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("quote", raw, quote[1] ?? "", {}, [], ordinal++));
      continue;
    }

    if (/^(---+|___+|\*\*\*+)\s*$/.test(trimmed)) {
      const start = index;
      index = consumeTrailingBlank(lines, index + 1);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("divider", raw, "", {}, [], ordinal++));
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (image) {
      const start = index;
      index = consumeTrailingBlank(lines, index + 1);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("image", raw, "", { caption: image[1] ?? "", url: image[2] ?? "" }, [], ordinal++));
      continue;
    }

    const child = trimmed.match(/^\[([^\]]+)\]\(((?![a-z][a-z0-9+.-]*:|#)[^)]+)\)\s*$/i);
    if (child) {
      const start = index;
      index = consumeTrailingBlank(lines, index + 1);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("standaloneLink", raw, child[1] ?? "", { path: child[2] ?? "" }, [], ordinal++));
      continue;
    }

    if (/^(<|:::)/.test(trimmed) || /^\|.*\|\s*$/.test(trimmed)) {
      const start = index++;
      while (index < lines.length && lines[index]!.text.trim()) index += 1;
      index = consumeTrailingBlank(lines, index);
      const raw = lines.slice(start, index).map((value) => value.full).join("");
      blocks.push(makeBlock("rawMarkdown", raw, raw, {}, [], ordinal++));
      continue;
    }

    const start = index++;
    while (index < lines.length && lines[index]!.text.trim() && !isBlockStart(lines[index]!.text)) index += 1;
    index = consumeTrailingBlank(lines, index);
    const raw = lines.slice(start, index).map((value) => value.full).join("");
    const content = lines.slice(start, index).map((value) => value.text).join("\n").trimEnd();
    blocks.push(makeBlock("paragraph", raw, content, {}, [], ordinal++));
  }
  return blocks;
}

export function parseMarkdown(source: string): MarkdownDocument {
  const envelope = splitFrontmatter(source);
  let frontmatter: Record<string, unknown> = {};
  if (envelope.frontmatterBody !== null) {
    try {
      const parsed = parseDocument(envelope.frontmatterBody, { keepSourceTokens: true });
      if (!parsed.errors.length) frontmatter = (parsed.toJS() as Record<string, unknown> | null) ?? {};
    } catch {}
  }
  return {
    source,
    frontmatter,
    frontmatterSource: envelope.frontmatterSource,
    bodySource: envelope.body,
    blocks: parseBlocks(envelope.body),
  };
}

function splitFrontmatter(source: string): {
  frontmatterSource: string | null;
  frontmatterBody: string | null;
  body: string;
} {
  const lines = linesOf(source);
  if (lines[0]?.text.trim() !== "---") return { frontmatterSource: null, frontmatterBody: null, body: source };
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.text.trim() !== "---") continue;
    return {
      frontmatterSource: lines.slice(0, index + 1).map((line) => line.full).join(""),
      frontmatterBody: lines.slice(1, index).map((line) => line.full).join(""),
      body: lines.slice(index + 1).map((line) => line.full).join(""),
    };
  }
  return { frontmatterSource: null, frontmatterBody: null, body: source };
}

function indentSource(source: string, depth: number): string {
  if (depth === 0) return source;
  const prefix = "  ".repeat(depth);
  return linesOf(source).map((line) => line.text.trim() ? `${prefix}${line.full}` : line.full).join("");
}

function serializeBlockAtDepth(block: ArborBlock, depth: number): string {
  if (block.props?.arborGenerated === true) return "";
  if (block.source && block.sourceHash === blockFingerprint(block)) return indentSource(block.source, depth);
  return serializeCanonical(block, depth);
}

function serializeCanonical(block: ArborBlock, depth = 0): string {
  const prefix = "  ".repeat(depth);
  const children = block.children.map((child) => serializeBlockAtDepth(child, depth + 1)).join("");
  switch (block.type) {
    case "toggle":
      return `${prefix}▸ ${block.content ?? ""}\n${children}`;
    case "heading":
      return `${prefix}${"#".repeat(Number(block.props?.level ?? 1))} ${block.content ?? ""}\n\n${children}`;
    case "bulletListItem":
      return `${prefix}- ${block.content ?? ""}\n${children}`;
    case "numberedListItem":
      return `${prefix}1. ${block.content ?? ""}\n${children}`;
    case "checkListItem":
      return `${prefix}- [${block.props?.checked ? "x" : " "}] ${block.content ?? ""}\n${children}`;
    case "quote":
      return `${prefix}> ${block.content ?? ""}\n\n`;
    case "codeBlock": {
      const language = String(block.props?.language ?? "");
      return `${prefix}\`\`\`${language}\n${block.content ?? ""}\n${prefix}\`\`\`\n\n`;
    }
    case "divider":
      return `${prefix}---\n\n`;
    case "mathBlock":
      return `${prefix}$$\n${block.content ?? ""}\n${prefix}$$\n\n`;
    case "footnoteDefinition": {
      const footnoteChildren = block.children.map((child) => serializeBlockAtDepth(child, depth + 2)).join("");
      return `${prefix}[^${String(block.props?.label ?? "1")}]: ${block.content ?? ""}\n${footnoteChildren || "\n"}`;
    }
    case "image":
      return `${prefix}![${String(block.props?.caption ?? "")}](${String(block.props?.url ?? "")})\n\n`;
    case "standaloneLink":
      return `${prefix}[${block.content ?? ""}](${String(block.props?.path ?? "")})\n\n`;
    case "rawMarkdown":
      return block.content ?? block.source ?? "";
    case "paragraph":
    default:
      return `${prefix}${block.content ?? ""}\n\n${children}`;
  }
}

export function serializeBlocks(blocks: ArborBlock[]): string {
  return blocks.map((block) => serializeBlockAtDepth(block, 0)).join("");
}

export function patchFrontmatter(
  source: string | null,
  patch: Record<string, unknown | null>,
): string | null {
  if (!Object.keys(patch).length) return source;
  const newline = source?.includes("\r\n") ? "\r\n" : "\n";
  let document: YamlDocument;
  if (source) {
    const split = splitFrontmatter(source);
    document = parseDocument(split.frontmatterBody ?? "", { keepSourceTokens: true });
  } else {
    document = parseDocument("");
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) document.delete(key);
    else document.set(key, value);
  }
  const yaml = document.toString({ lineWidth: 0 }).replaceAll("\n", newline);
  return `---${newline}${yaml}${yaml.endsWith(newline) ? "" : newline}---${newline}`;
}

/** Replace the complete frontmatter map while preserving its YAML source style where possible. */
export function replaceFrontmatter(
  source: string | null,
  properties: Record<string, unknown>,
): string | null {
  if (!source && !Object.keys(properties).length) return null;
  const newline = source?.includes("\r\n") ? "\r\n" : "\n";
  const split = source ? splitFrontmatter(source) : null;
  const document = parseDocument(split?.frontmatterBody ?? "", { keepSourceTokens: true });
  const current = document.toJSON();
  for (const key of current && typeof current === "object" && !Array.isArray(current)
    ? Object.keys(current as Record<string, unknown>)
    : []) if (!Object.hasOwn(properties, key)) document.delete(key);
  for (const [key, value] of Object.entries(properties)) document.set(key, value);
  const yaml = document.toString({ lineWidth: 0 }).replaceAll("\n", newline);
  return `---${newline}${yaml}${yaml.endsWith(newline) ? "" : newline}---${newline}`;
}

export function serializeMarkdown(
  document: MarkdownDocument,
  blocks: ArborBlock[],
  frontmatterPatch: Record<string, unknown | null> = {},
): string {
  return `${patchFrontmatter(document.frontmatterSource, frontmatterPatch) ?? ""}${serializeBlocks(blocks)}`;
}

export function mintPageID(existing: Set<string>): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let value = "";
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    for (const byte of bytes) value += alphabet[byte! % alphabet.length];
    if (!existing.has(value)) return value;
  }
}
