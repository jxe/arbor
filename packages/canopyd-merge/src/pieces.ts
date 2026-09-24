import { IntentError } from "./intent-model.ts";
import type { Piece } from "./intent-model.ts";
export const pieceLength = (pieces: Piece[]) =>
  pieces.reduce((n, p) => n + p.length, 0);
export function pieceSlice(
  pieces: Piece[],
  start: number,
  end: number,
): Piece[] {
  const out: Piece[] = [];
  let offset = 0;
  for (const p of pieces) {
    const a = Math.max(0, start - offset),
      b = Math.min(p.length, end - offset);
    if (b > a)
      out.push({
        ...p,
        start: p.start + a,
        offset: p.offset + a,
        length: b - a,
      });
    offset += p.length;
  }
  return out;
}
/** The origin coordinates `a` and `b` share, if they share any. */
export function intersect(a: Piece, b: Piece): [number, number] | undefined {
  if (a.origin !== b.origin) return undefined;
  const from = Math.max(a.start, b.start),
    to = Math.min(a.start + a.length, b.start + b.length);
  return to > from ? [from, to] : undefined;
}
/** Merge adjacent pieces that continue one origin and one object; drop empty ones. */
export function normalizePieces(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (!p.length) continue;
    const prior = out.at(-1);
    if (
      prior &&
      prior.origin === p.origin &&
      prior.start + prior.length === p.start &&
      prior.object === p.object &&
      prior.offset + prior.length === p.offset
    )
      prior.length += p.length;
    else out.push({ ...p });
  }
  return out;
}
/** `pieces` with the byte range `[start, end)` replaced by `inserted`. */
export const replacePieces = (
  pieces: Piece[],
  start: number,
  end: number,
  inserted: Piece[] = [],
): Piece[] =>
  normalizePieces([
    ...pieceSlice(pieces, 0, start),
    ...inserted,
    ...pieceSlice(pieces, end, pieceLength(pieces)),
  ]);
/** `pieces` without the origin coordinates any of `without` covers. */
export function subtractPieces(pieces: Piece[], without: Piece[]): Piece[] {
  if (!without.length) return pieces;
  return pieces.flatMap((piece) => {
    let parts = [piece];
    for (const cut of without) {
      if (cut.origin !== piece.origin) continue;
      parts = parts.flatMap((part) => {
        const shared = intersect(part, cut);
        if (!shared) return [part];
        const keep = (from: number, to: number) => ({
          ...part, start: from, offset: part.offset + (from - part.start), length: to - from,
        });
        return [keep(part.start, shared[0]), keep(shared[1], part.start + part.length)].filter((p) => p.length > 0);
      });
    }
    return parts;
  });
}
export interface PieceEdit {
  range: [number, number];
  pieces: Piece[];
  attachment?: boolean;
}
/** Exact shared-origin correspondence. Reorders remain a bounded atomic transformation. */
export function pieceEdits(base: Piece[], changed: Piece[]): PieceEdit[] {
  if (base.length * changed.length > 2_000_000)
    throw new IntentError(
      "limit",
      "Source correspondence work budget exceeded",
    );
  const matches: Array<{ a: number; b: number; n: number }> = [];
  let a = 0;
  for (const x of base) {
    let b = 0;
    for (const y of changed) {
      const shared = intersect(x, y);
      if (shared)
        matches.push({
          a: a + shared[0] - x.start,
          b: b + shared[0] - y.start,
          n: shared[1] - shared[0],
        });
      b += y.length;
    }
    a += x.length;
  }
  matches.sort((x, y) => x.a - y.a);
  // Only anchor correspondences that no other shared identity crosses. A
  // reordered region remains atomic, while stable source before, between and
  // after reorders continues to delimit independent edits. This is identity
  // order, not a longest-subsequence guess about which occurrence was moved.
  const following = new Array<number>(matches.length + 1).fill(Infinity);
  for (let i = matches.length - 1; i >= 0; i--)
    following[i] = Math.min(following[i + 1]!, matches[i]!.b);
  let priorA = 0, priorB = 0, old = 0, updated = 0;
  const edits: PieceEdit[] = [];
  for (const [index, m] of matches.entries()) {
    const anchored = m.a >= priorA && m.b >= priorB &&
      m.a + m.n <= (matches[index + 1]?.a ?? Infinity) &&
      m.b + m.n <= following[index + 1]!;
    priorA = Math.max(priorA, m.a + m.n);
    priorB = Math.max(priorB, m.b + m.n);
    if (!anchored) continue;
    if (m.a > old || m.b > updated)
      edits.push({
        range: [old, m.a],
        pieces: pieceSlice(changed, updated, m.b),
      });
    old = m.a + m.n;
    updated = m.b + m.n;
  }
  if (old < pieceLength(base) || updated < pieceLength(changed))
    edits.push({
      range: [old, pieceLength(base)],
      pieces: pieceSlice(changed, updated, pieceLength(changed)),
    });
  return edits;
}
export function overlap(a: PieceEdit, b: PieceEdit): boolean {
  if (
    (a.attachment &&
      a.range[0] === a.range[1] &&
      b.range[0] < b.range[1] &&
      a.range[0] === b.range[0]) ||
    (b.attachment &&
      b.range[0] === b.range[1] &&
      a.range[0] < a.range[1] &&
      b.range[0] === a.range[0])
  )
    return false;
  return (
    a.range[0] === b.range[0] ||
    (a.range[0] < b.range[1] && b.range[0] < a.range[1])
  );
}
export function applyPieceEdits(base: Piece[], edits: PieceEdit[]): Piece[] {
  let cursor = 0;
  const out: Piece[] = [];
  for (const e of [...edits].sort(
    (a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1],
  )) {
    out.push(...pieceSlice(base, cursor, e.range[0]), ...e.pieces);
    cursor = e.range[1];
  }
  out.push(...pieceSlice(base, cursor, pieceLength(base)));
  return out;
}
