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

export interface MarkdownBlock {
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

/** Origin coordinates of each byte of a version, as pieces describe them. */
function coordinates(pieces: Piece[]) {
  const starts: number[] = [];
  let offset = 0;
  for (const piece of pieces) { starts.push(offset); offset += piece.length; }
  return (at: number): string | undefined => {
    let low = 0, high = pieces.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1, piece = pieces[middle]!, start = starts[middle]!;
      if (at < start) high = middle - 1;
      else if (at >= start + piece.length) low = middle + 1;
      else return `${piece.origin}\u0000${piece.start + at - start}`;
    }
    return undefined;
  };
}

/** A version read for the block check: its blocks, by identity. */
interface Reading {
  blocks: MarkdownBlock[];
  keys: string[];
  byKey: Map<string, number>;
}
/** Where base blocks' coordinates are: leaf content, and container markers. */
interface BaseIndex {
  leaf: Map<string, number>;
  container: Map<string, number>;
}
const isContainer = (b: MarkdownBlock) => b.kind === "item" || b.kind === "quote";
/** The bytes that say which block a block is: a container's marker, a leaf's content. */
const region = (b: MarkdownBlock): [number, number] =>
  isContainer(b) ? [b.start, b.content] : b.content < b.end ? [b.content, b.end] : [b.start, b.end];

/**
 * Read a version as blocks and name each block. Base blocks are named by
 * position. A block of another version is the base block of its kind class
 * whose coordinates it shares most (so an edited first word, an outdent or a
 * new list marker keep its name), or else a new block named by its first
 * coordinate, which the same new block has in every version that holds it.
 */
function read(source: string, pieces: Piece[], base?: BaseIndex): (Reading & { index?: BaseIndex }) | null {
  const blocks = markdownBlocks(source);
  if (!blocks) return null;
  const at = coordinates(pieces);
  if (!base) {
    const index: BaseIndex = { leaf: new Map(), container: new Map() };
    for (const [i, b] of blocks.entries()) {
      const [s, e] = region(b), map = isContainer(b) ? index.container : index.leaf;
      for (let o = s; o < e; o++) { const c = at(o); if (c) map.set(c, i); }
    }
    const keys = blocks.map((_, i) => `b:${i}`);
    return { blocks, keys, byKey: new Map(keys.map((k, i) => [k, i])), index };
  }
  const claims = blocks.map((b) => {
    const [s, e] = region(b), map = isContainer(b) ? base.container : base.leaf;
    const counts = new Map<number, number>();
    let first: string | undefined;
    for (let o = s; o < e; o++) {
      const c = at(o);
      if (!c) continue;
      first ??= c;
      const hit = map.get(c);
      if (hit !== undefined) counts.set(hit, (counts.get(hit) ?? 0) + 1);
    }
    let best: number | undefined, most = 0;
    for (const [hit, count] of counts) if (count > most || (count === most && hit < best!)) { best = hit; most = count; }
    return { best, most, fresh: `n:${first ?? "empty"}:${isContainer(b) ? "c" : "b"}` };
  });
  // Two blocks claiming one base block (a split paragraph): the larger share keeps it.
  const owner = new Map<number, number>();
  for (const [i, claim] of claims.entries())
    if (claim.best !== undefined && (!owner.has(claim.best) || claims[owner.get(claim.best)!]!.most < claim.most)) owner.set(claim.best, i);
  const keys = claims.map((claim, i) => claim.best !== undefined && owner.get(claim.best) === i ? `b:${claim.best}` : claim.fresh);
  const byKey = new Map<string, number>();
  for (const [i, key] of keys.entries()) {
    if (byKey.has(key)) return null;
    byKey.set(key, i);
  }
  return { blocks, keys, byKey };
}

/** What a block is, for comparing its versions: kind, attributes, container. */
const shape = (r: Reading, i: number) => {
  const b = r.blocks[i]!;
  return JSON.stringify([b.kind, b.attributes, b.parent < 0 ? "" : r.keys[b.parent]]);
};

export interface BlockVerdict {
  /** The blocks that need review, as base byte ranges; empty when it merges. */
  conflicts: Array<[number, number]>;
  reason: string;
  /** Fenced code and front matter both sides changed, by base range and language. */
  embedded: Array<{ base: [number, number]; language: string; texts: string[] }>;
}

/**
 * Check a proposed merge block by block. `sources` and `pieces` are base,
 * current, incoming and proposed. Returns null when a version cannot be read
 * as blocks (an unclosed fence), which the caller treats as unsupported.
 */
export function markdownBlockMerge(sources: string[], pieces: Piece[][]): BlockVerdict | null {
  const base = read(sources[0]!, pieces[0]!);
  if (!base?.index) return null;
  const others = [1, 2, 3].map((i) => read(sources[i]!, pieces[i]!, base.index));
  if (others.some((r) => !r)) return null;
  const [current, incoming, proposed] = others as [Reading, Reading, Reading];
  const conflicts: Array<[number, number]> = [];
  const reasons = new Set<string>();
  /** Base range of a block of `r`: its own when base has it, else between the base bytes around it. */
  const scope = (r: Reading, version: number, i: number): [number, number] => {
    const key = r.keys[i]!;
    const own = base.byKey.get(key);
    if (own !== undefined) return [base.blocks[own]!.start, base.blocks[own]!.end];
    const b = r.blocks[i]!, at = coordinates(pieces[version]!);
    const located = (offset: number) => {
      const coordinate = at(offset);
      if (!coordinate) return undefined;
      const [origin, start] = coordinate.split("\u0000");
      // Find the base piece that holds this coordinate.
      let position = 0;
      for (const p of pieces[0]!) {
        if (p.origin === origin && Number(start) >= p.start && Number(start) < p.start + p.length) return position + Number(start) - p.start;
        position += p.length;
      }
      return undefined;
    };
    let before: number | undefined, after: number | undefined;
    for (let o = b.start - 1; o >= 0 && before === undefined; o--) before = located(o);
    const length = sources[version]!.length;
    for (let o = b.end; o < length + 4 && after === undefined; o++) after = located(o);
    const s = before === undefined ? 0 : before + 1, e = after === undefined ? Buffer.byteLength(sources[0]!) : after;
    return [Math.min(s, e), Math.max(s, e)];
  };
  const conflict = (r: Reading, version: number, i: number, reason: string) => {
    conflicts.push(scope(r, version, i));
    reasons.add(reason);
  };
  /** The three-way value: what the side that changed it gave it. */
  const expect = (b: string | undefined, c: string | undefined, n: string | undefined): string | undefined | null => {
    if (c !== undefined && n !== undefined) {
      if (c === b) return n;
      if (n === b || n === c) return c;
      return null;
    }
    return c ?? n;
  };
  const embedded: BlockVerdict["embedded"] = [];
  for (const [i, key] of proposed.keys.entries()) {
    const at = (r: Reading) => r.byKey.get(key);
    const [b, c, n] = [at(base), at(current), at(incoming)];
    if (c === undefined && n === undefined) {
      conflict(proposed, 3, i, "A merged block neither side wrote");
      continue;
    }
    const wanted = expect(
      b === undefined ? undefined : shape(base, b),
      c === undefined ? undefined : shape(current, c),
      n === undefined ? undefined : shape(incoming, n),
    );
    if (wanted === null) { conflict(proposed, 3, i, "Both sides changed a block's kind or place differently"); continue; }
    if (shape(proposed, i) !== wanted) { conflict(proposed, 3, i, "A block reads differently than its author wrote it"); continue; }
    const inline = expect(
      b === undefined ? undefined : base.blocks[b]!.inline,
      c === undefined ? undefined : current.blocks[c]!.inline,
      n === undefined ? undefined : incoming.blocks[n]!.inline,
    );
    if (inline === null || proposed.blocks[i]!.inline !== inline) { conflict(proposed, 3, i, "Both sides changed a block's inline syntax"); continue; }
    const block = proposed.blocks[i]!;
    if (block.language !== undefined && b !== undefined && c !== undefined && n !== undefined) {
      const text = (r: Reading, version: number, index: number) => slice(sources[version]!, r.blocks[index]!.start, r.blocks[index]!.end);
      const texts = [text(base, 0, b), text(current, 1, c), text(incoming, 2, n), text(proposed, 3, i)];
      if (texts[1] !== texts[0] && texts[2] !== texts[0] && texts[1] !== texts[2])
        embedded.push({ base: [base.blocks[b]!.start, base.blocks[b]!.end], language: block.language, texts });
    }
  }
  // Blocks that vanished: kept by both sides, or new on one side, yet gone.
  for (const [version, r] of [[1, current], [2, incoming]] as const) {
    const other = version === 1 ? incoming : current;
    for (const [i, key] of r.keys.entries()) {
      if (proposed.byKey.has(key)) continue;
      const inBase = base.byKey.has(key), inOther = other.byKey.has(key);
      if (inBase && !inOther) continue;
      conflict(r, version, i, "A block one side kept is missing from the merge");
    }
  }
  // Splits and joins: text one side holds in one block must stay in one block,
  // unless the other side split it, and text a side holds apart must stay
  // apart, unless the other side joined it.
  const readingsByVersion = [base, current, incoming, proposed];
  const leaves = readingsByVersion.map((r, version) => {
    const at = coordinates(pieces[version]!), map = new Map<string, number>();
    for (const [i, b] of r.blocks.entries()) {
      if (isContainer(b)) continue;
      const [s, e] = region(b);
      for (let o = s; o < e; o++) { const c = at(o); if (c) map.set(c, i); }
    }
    return map;
  });
  const coordinatesOf = (version: number, i: number) => {
    const at = coordinates(pieces[version]!), [s, e] = region(readingsByVersion[version]!.blocks[i]!), found: string[] = [];
    for (let o = s; o < e; o++) { const c = at(o); if (c) found.push(c); }
    return found;
  };
  const apart = (version: number, coords: string[]) => {
    const blocks = new Set<number>();
    for (const c of coords) { const b = leaves[version]!.get(c); if (b !== undefined) blocks.add(b); }
    return blocks.size;
  };
  for (const version of [1, 2]) {
    const other = 3 - version, r = readingsByVersion[version]!;
    for (const [i, b] of r.blocks.entries()) {
      if (isContainer(b)) continue;
      const coords = coordinatesOf(version, i);
      if (apart(3, coords) > 1 && (apart(other, coords) <= 1 || apart(0, coords) > 1))
        conflict(r, version, i, "A block one side wrote is split in the merge");
    }
  }
  for (const [i, b] of proposed.blocks.entries()) {
    if (isContainer(b)) continue;
    const coords = coordinatesOf(3, i);
    for (const version of [1, 2])
      if (apart(version, coords) > 1 && (apart(0, coords) <= 1 || apart(3 - version, coords) > 1)) {
        conflict(proposed, 3, i, "Blocks one side kept apart are joined in the merge");
        break;
      }
  }
  return {
    conflicts,
    reason: conflicts.length ? [...reasons].sort().join("; ") : "Every block keeps the kind, place and inline syntax its last editor gave it",
    embedded,
  };
}

const slice = (source: string, start: number, end: number) =>
  Buffer.from(source).subarray(start, end).toString("utf8");
