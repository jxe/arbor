/**
 * Merging as elements (overstoryd 017). A format's reader reads a version of
 * a document as elements: Markdown blocks, keyed members of a data file, rows
 * of a table. Each has a kind, attributes, a container and a structural
 * signature of its content, and either a name the format gives it (a key
 * path) or none, in which case it is named by piece identity: the base
 * element whose coordinates it shares most, or a new element named by its
 * first coordinate.
 *
 * A merge is valid when every element of the result has the kind,
 * attributes, container, section and signature its last editor gave it, no
 * element appears that neither side wrote, no element both sides kept
 * disappears, and (for formats whose elements hold running text) no text one
 * side holds in one element is split, nor text a side holds apart joined,
 * unless the other side did it. Anything else is a conflict about the
 * elements involved, never about the whole document.
 */
import type { Piece } from "./intent-model.ts";

export interface Element {
  /** Byte range of the whole element. */
  start: number;
  end: number;
  /** First byte of its content (after markers or its key). */
  content: number;
  kind: string;
  /** Kind-specific attributes: heading level, list marker, value type. */
  attributes: string;
  /** The containing element, by index, or -1 at top level. */
  parent: number;
  /** A structural signature of the content: inline syntax, a row's shape. */
  inline: string;
  /** Embedded source in another language (a fence, front matter). */
  language?: string;
  /** A name the format gives the element, such as a key path. */
  name?: string;
  /** Named by its markers rather than its content (a list item, a quote). */
  container?: boolean;
}

export interface ElementReader {
  /** The elements of `source`, or null when it cannot be read. */
  read(source: string): Element[] | null;
  /** Kinds that open a section for the elements after them. */
  sections?: Set<string>;
  /** Whether elements hold running text that a merge could split or join. */
  splits?: boolean;
  /** Elements of a merged source that are invalid where they are. */
  invalid?(source: string, elements: Element[]): number[];
  /** The evidence reason for a merge that passes. */
  merged: string;
}

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
  blocks: Element[];
  keys: string[];
  byKey: Map<string, number>;
  /** Elements whose name another element of this version already has. */
  duplicates?: number[];
}
/** Where base blocks' coordinates are: leaf content, and container markers. */
interface BaseIndex {
  leaf: Map<string, number>;
  container: Map<string, number>;
}
const isContainer = (b: Element) => b.container === true;
/** The bytes that say which block a block is: a container's marker, a leaf's content. */
const region = (b: Element): [number, number] =>
  isContainer(b) ? [b.start, b.content] : b.content < b.end ? [b.content, b.end] : [b.start, b.end];

/**
 * Read a version as blocks and name each block. Base blocks are named by
 * position. A block of another version is the base block of its kind class
 * whose coordinates it shares most (so an edited first word, an outdent or a
 * new list marker keep its name), or else a new block named by its first
 * coordinate, which the same new block has in every version that holds it.
 */
function read(reader: ElementReader, source: string, pieces: Piece[], base?: BaseIndex): (Reading & { index?: BaseIndex }) | null {
  const blocks = reader.read(source);
  if (!blocks) return null;
  const at = coordinates(pieces);
  if (!base) {
    const index: BaseIndex = { leaf: new Map(), container: new Map() };
    // Named elements need no identity. An unnamed one holds its coordinates
    // except those of unnamed elements inside it, which come later.
    for (const [i, b] of blocks.entries()) {
      if (b.name !== undefined) continue;
      const [s, e] = region(b), map = isContainer(b) ? index.container : index.leaf;
      for (let o = s; o < e; o++) { const c = at(o); if (c) map.set(c, i); }
    }
    const keys = blocks.map((b, i) => b.name !== undefined ? `k:${b.name}` : `b:${i}`);
    const byKey = new Map<string, number>();
    for (const [i, key] of keys.entries()) { if (byKey.has(key)) return null; byKey.set(key, i); }
    return { blocks, keys, byKey, index };
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
  const keys = claims.map((claim, i) => {
    const named = blocks[i]!.name;
    if (named !== undefined) return `k:${named}`;
    return claim.best !== undefined && owner.get(claim.best) === i ? `b:${claim.best}` : claim.fresh;
  });
  const byKey = new Map<string, number>(), duplicates: number[] = [];
  for (const [i, key] of keys.entries()) {
    if (byKey.has(key)) {
      // Two elements of one name are a fact about the version; two of one
      // identity mean identity cannot tell them apart.
      if (!key.startsWith("k:")) return null;
      duplicates.push(i);
      continue;
    }
    byKey.set(key, i);
  }
  return { blocks, keys, byKey, duplicates };
}

/** What a block is, for comparing its versions: kind, attributes, container. */
const shape = (reader: ElementReader, r: Reading, i: number) => {
  const b = r.blocks[i]!;
  return JSON.stringify([b.kind, b.attributes, b.parent < 0 ? "" : r.keys[b.parent], section(reader, r, i)]);
};
/** The section an element falls under: the nearest element before it of a
 * kind that opens one (a Markdown heading). Such an element is not in its own
 * section, so moving text across a heading, or a heading across text,
 * changes which section the text is in. */
const section = (reader: ElementReader, r: Reading, i: number) => {
  if (!reader.sections) return "";
  for (let j = i - 1; j >= 0; j--) if (reader.sections.has(r.blocks[j]!.kind)) return r.keys[j];
  return "";
};

export interface ElementVerdict {
  /** The blocks that need review, as base byte ranges; empty when it merges. */
  conflicts: Array<[number, number]>;
  reason: string;
  /** Fenced code and front matter both sides changed, by base range and language. */
  embedded: Array<{ base: [number, number]; language: string; texts: string[] }>;
  /** The merged source could not be read at all; no element can be named. */
  unreadable?: boolean;
}

/**
 * Check a proposed merge element by element. `sources` and `pieces` are base,
 * current, incoming and proposed. Returns null when base or a side cannot be
 * read (an unclosed fence, invalid syntax), which the caller treats as
 * unsupported; a merge that cannot be read is reported as `unreadable`.
 */
export function elementMerge(sources: string[], pieces: Piece[][], reader: ElementReader): ElementVerdict | null {
  const base = read(reader, sources[0]!, pieces[0]!);
  if (!base?.index) return null;
  const sides = [1, 2].map((i) => read(reader, sources[i]!, pieces[i]!, base.index));
  if (sides.some((r) => !r || r.duplicates?.length)) return null;
  const [current, incoming] = sides as [Reading, Reading];
  const proposed = read(reader, sources[3]!, pieces[3]!, base.index);
  if (!proposed) return { conflicts: [], reason: "The merged source does not parse", embedded: [], unreadable: true };
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
  const embedded: ElementVerdict["embedded"] = [];
  for (const i of proposed.duplicates ?? []) conflict(proposed, 3, i, "Both sides added an element of one name");
  for (const i of reader.invalid?.(sources[3]!, proposed.blocks) ?? []) conflict(proposed, 3, i, "The merged element is not valid where it landed");
  for (const [i, key] of proposed.keys.entries()) {
    if (proposed.duplicates?.includes(i)) continue;
    const at = (r: Reading) => r.byKey.get(key);
    const [b, c, n] = [at(base), at(current), at(incoming)];
    if (c === undefined && n === undefined) {
      conflict(proposed, 3, i, "A merged block neither side wrote");
      continue;
    }
    const wanted = expect(
      b === undefined ? undefined : shape(reader, base, b),
      c === undefined ? undefined : shape(reader, current, c),
      n === undefined ? undefined : shape(reader, incoming, n),
    );
    if (wanted === null) { conflict(proposed, 3, i, "Both sides changed a block's kind or place differently"); continue; }
    if (shape(reader, proposed, i) !== wanted) { conflict(proposed, 3, i, "A block reads differently than its author wrote it"); continue; }
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
      if (isContainer(b) || !reader.splits) continue;
      const coords = coordinatesOf(version, i);
      if (apart(3, coords) > 1 && (apart(other, coords) <= 1 || apart(0, coords) > 1))
        conflict(r, version, i, "A block one side wrote is split in the merge");
    }
  }
  for (const [i, b] of proposed.blocks.entries()) {
    if (isContainer(b) || !reader.splits) continue;
    const coords = coordinatesOf(3, i);
    for (const version of [1, 2])
      if (apart(version, coords) > 1 && (apart(0, coords) <= 1 || apart(3 - version, coords) > 1)) {
        conflict(proposed, 3, i, "Blocks one side kept apart are joined in the merge");
        break;
      }
  }
  return {
    conflicts,
    reason: conflicts.length ? [...reasons].sort().join("; ") : reader.merged,
    embedded,
  };
}

const slice = (source: string, start: number, end: number) =>
  Buffer.from(source).subarray(start, end).toString("utf8");
