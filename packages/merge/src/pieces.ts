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
export interface PieceEdit {
  range: [number, number];
  pieces: Piece[];
  attachment?: boolean;
}
/** Exact shared-origin correspondence. Reorders remain an atomic transformation. */
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
      if (x.origin === y.origin) {
        const from = Math.max(x.start, y.start),
          to = Math.min(x.start + x.length, y.start + y.length);
        if (to > from)
          matches.push({
            a: a + from - x.start,
            b: b + from - y.start,
            n: to - from,
          });
      }
      b += y.length;
    }
    a += x.length;
  }
  matches.sort((x, y) => x.a - y.a);
  let old = 0,
    updated = 0;
  const edits: PieceEdit[] = [];
  for (const m of matches) {
    if (m.a < old || m.b < updated)
      return [{ range: [0, pieceLength(base)], pieces: changed }];
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
