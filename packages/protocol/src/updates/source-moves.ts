/** Exact execution of source moves beside ordinary replacements, all stated in
 * basis coordinates. This is the byte-level meaning of a frame whose
 * `moveSource` operations precede its `editSource` operations; the merge
 * engine executes the same frame by material identity and must agree.
 *
 * A move relocates non-empty basis material beside an anchor: basis material
 * that stays where it is, or the whole source of an earlier move in the same
 * frame (so several moved spans can land one after another). A replacement
 * either lies inside one moved span, and then edits that material wherever it
 * lands, or outside every moved span. Anything whose order would be ambiguous
 * (two moves at one place, an insertion at a moved span's edge, a replacement
 * across an anchor edge) is refused as unsupported; an ordered trace can still
 * state it, but not in this form.
 */

export interface SourceSpan { path: string; range: [number, number] }
export interface SourceMoveEffect { source: SourceSpan; anchor: SourceSpan; side: "before" | "after" }
export interface SourceReplacement { path: string; range: [number, number]; text: Uint8Array }

/** A well-formed arrangement this executor declines because its order is not
 * determined by basis coordinates alone. */
export class UnsupportedSourceMove extends Error {}

function invalid(message: string): never { throw new Error(`Invalid source move: ${message}`); }
function unsupported(message: string): never { throw new UnsupportedSourceMove(message); }

function checkRange(bytes: Uint8Array | undefined, span: SourceSpan, what: string): Uint8Array {
  if (!bytes) invalid(`${what} path is not a source`);
  const [start, end] = span.range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.length) invalid(`${what} range outside source`);
  for (const offset of span.range) if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) invalid(`${what} range splits a UTF-8 scalar`);
  return bytes;
}
const within = (inner: SourceSpan, outer: SourceSpan) =>
  inner.path === outer.path && inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
const overlaps = (a: SourceSpan, b: SourceSpan) =>
  a.path === b.path && a.range[0] < b.range[1] && b.range[0] < a.range[1];
const sameSpan = (a: SourceSpan, b: SourceSpan) =>
  a.path === b.path && a.range[0] === b.range[0] && a.range[1] === b.range[1];

/** Apply `moves` (in order) and then `edits` to `files`, returning every file
 * the arrangement touches. Edits are ascending and disjoint within a path. */
export function arrangeSources(
  files: ReadonlyMap<string, Uint8Array>,
  moves: readonly SourceMoveEffect[],
  edits: readonly SourceReplacement[],
): Map<string, Uint8Array> {
  // Where each move lands: beside stationary material (path and offset) or
  // beside an earlier move's material.
  const slots = new Map<string, number>();
  for (const [index, move] of moves.entries()) {
    checkRange(files.get(move.source.path), move.source, "move source");
    checkRange(files.get(move.anchor.path), move.anchor, "move anchor");
    if (move.source.range[0] === move.source.range[1]) invalid("move source is empty");
    if (move.anchor.range[0] === move.anchor.range[1]) invalid("move anchor is empty");
    if (move.side !== "before" && move.side !== "after") invalid("move side");
    for (const other of moves.slice(0, index)) if (overlaps(other.source, move.source)) invalid("moves overlap");
    let key: string;
    const chained = moves.findIndex((other, j) => j < index && sameSpan(other.source, move.anchor));
    if (chained >= 0) key = `move:${chained}:${move.side}`;
    else {
      if (overlaps(move.anchor, move.source)) invalid("move destination is inside its source");
      if (moves.some(other => overlaps(other.source, move.anchor))) unsupported("anchor is moved material other than an earlier move's whole source");
      key = `at:${move.anchor.path}:${move.side === "before" ? move.anchor.range[0] : move.anchor.range[1]}`;
    }
    if (slots.has(key)) unsupported("two moves land at one place");
    slots.set(key, index);
  }
  // Each edit belongs to one moved span or to stationary material.
  const inside = new Map<number, SourceReplacement[]>(), stationary = new Map<string, SourceReplacement[]>();
  const priorEnd = new Map<string, number>();
  for (const edit of edits) {
    checkRange(files.get(edit.path), edit, "edit");
    if (edit.range[0] < (priorEnd.get(edit.path) ?? 0)) invalid("edits overlap or are out of order");
    priorEnd.set(edit.path, edit.range[1]);
    const owner = moves.findIndex(move => within(edit, move.source));
    const empty = edit.range[0] === edit.range[1];
    if (owner >= 0) {
      const [start, end] = moves[owner]!.source.range;
      if (empty && (edit.range[0] === start || edit.range[0] === end)) unsupported("insertion at a moved span's edge");
      inside.set(owner, [...(inside.get(owner) ?? []), edit]);
      continue;
    }
    for (const move of moves) {
      if (overlaps(edit, move.source)) unsupported("edit crosses a moved span");
      if (empty && edit.path === move.source.path && (edit.range[0] === move.source.range[0] || edit.range[0] === move.source.range[1]))
        unsupported("insertion at a moved span's edge");
    }
    for (const key of slots.keys()) {
      if (!key.startsWith("at:")) continue;
      const separator = key.lastIndexOf(":"), path = key.slice(3, separator), position = Number(key.slice(separator + 1));
      if (path !== edit.path) continue;
      if (empty ? edit.range[0] === position : edit.range[0] < position && position < edit.range[1]) unsupported("edit at a move's landing place");
    }
    stationary.set(edit.path, [...(stationary.get(edit.path) ?? []), edit]);
  }
  const rendered = new Set<number>();
  const payload = (index: number, out: Uint8Array[]) => {
    if (rendered.has(index)) invalid("move rendered twice");
    rendered.add(index);
    slot(`move:${index}:before`, out);
    const move = moves[index]!, bytes = files.get(move.source.path)!;
    let cursor = move.source.range[0];
    for (const edit of inside.get(index) ?? []) {
      out.push(bytes.subarray(cursor, edit.range[0]), edit.text);
      cursor = edit.range[1];
    }
    out.push(bytes.subarray(cursor, move.source.range[1]));
    slot(`move:${index}:after`, out);
  };
  const slot = (key: string, out: Uint8Array[]) => { const index = slots.get(key); if (index !== undefined) payload(index, out); };
  const touched = new Set([...moves.flatMap(m => [m.source.path, m.anchor.path]), ...edits.map(e => e.path)]);
  const result = new Map<string, Uint8Array>();
  for (const path of touched) {
    const bytes = files.get(path)!, out: Uint8Array[] = [];
    // Stationary breakpoints: moved-out spans are skipped, edits replace, and
    // a landing place emits its moved material before the byte at it.
    const cuts = moves.filter(m => m.source.path === path).map(m => m.source.range).sort((a, b) => a[0] - b[0]);
    const replaced = stationary.get(path) ?? [];
    let cursor = 0, cut = 0, edit = 0;
    const landings = [...slots.keys()].filter(k => k.startsWith(`at:${path}:`)).map(k => Number(k.slice(k.lastIndexOf(":") + 1))).sort((a, b) => a - b);
    let landing = 0;
    while (true) {
      const next = Math.min(cuts[cut]?.[0] ?? Infinity, replaced[edit]?.range[0] ?? Infinity, landings[landing] ?? Infinity, bytes.length);
      out.push(bytes.subarray(cursor, next));
      cursor = next;
      if (landings[landing] === cursor) { slot(`at:${path}:${cursor}`, out); landing++; continue; }
      if (cuts[cut]?.[0] === cursor) { cursor = cuts[cut]![1]; cut++; continue; }
      if (replaced[edit]?.range[0] === cursor) { out.push(replaced[edit]!.text); cursor = replaced[edit]!.range[1]; edit++; continue; }
      break;
    }
    if (landing < landings.length) invalid("move landing place is outside its source");
    const size = out.reduce((n, chunk) => n + chunk.length, 0), joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of out) { joined.set(chunk, offset); offset += chunk.length; }
    result.set(path, joined);
  }
  if (rendered.size !== moves.length) invalid("a move does not land in any source");
  return result;
}
