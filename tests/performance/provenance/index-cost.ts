/** Performance 004 calculations: replay a tree's chain and, for each entry,
 * encode the provenance index its state implies (tree-shaped records, piece
 * lists in content-defined chunks), counting new records and bytes per entry,
 * total index size, and piece counts per file over time.
 *   bun tests/performance/provenance/index-cost.ts <data-root> <tree> <out.json> [chunk-mask]
 * Read-only: the data root is opened read-only and nothing is written there. */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { acceptedEntries } from "../../support/log-entries.ts";
import { sidecar } from "../../support/replay-check.ts";
import { DEFAULT_RULES, unbudgeted } from "./unbudgeted.ts";
import { viewState } from "../../../packages/overstoryd-merge/src/retained-state.ts";
import type { Node, Piece } from "../../../packages/overstoryd-merge/src/intent-model.ts";

const [root, tree, out, maskArg] = process.argv.slice(2);
if (!root || !tree || !out) throw Error("usage: index-cost.ts <data-root> <tree> <out.json> [chunk-mask]");
// A chunk ends after a piece whose identity hashes to 0 under the mask: about
// one piece in (mask + 1).
const MASK = Number(maskArg ?? 31);
const entries = acceptedEntries(root, tree);
const s = unbudgeted(sidecar(root)) as unknown as {
  stateOf(hash: string, rules: unknown): Promise<{ object: string; state: string }>;
  recorded: Map<string, Parameters<typeof viewState>[0]>;
  states: Map<string, unknown>; clear(): void;
};
const rules = DEFAULT_RULES;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const stored = new Map<string, number>(); // record hash -> bytes
let totalBytes = 0;
const put = (value: unknown, fresh: { records: number; bytes: number }) => {
  const text = JSON.stringify(value), hash = sha(text);
  if (!stored.has(hash)) { stored.set(hash, text.length); totalBytes += text.length; fresh.records++; fresh.bytes += text.length; }
  return hash;
};
const boundary = (p: Piece) => (parseInt(sha(`${p.origin}\0${p.start}`).slice(0, 8), 16) & MASK) === 0;
const chunked = (pieces: Piece[]) => {
  const chunks: Piece[][] = [[]];
  for (const p of pieces) { chunks.at(-1)!.push(p); if (boundary(p)) chunks.push([]); }
  if (!chunks.at(-1)!.length) chunks.pop();
  return chunks;
};
// Per-entry facts
const perEntry: Array<{ index: number; kind: string; records: number; bytes: number; files: number; pieces: number; maxPieces: number; ms: number }> = [];
const maxPiecesByPath = new Map<string, number>();
const series = new Map<string, Array<[number, number]>>(); // path -> [index, pieces] when changed
const memo = new WeakMap<object, string>(); // node object -> record hash (frozen nodes are shared across states)
const started = performance.now();
for (const [index, { hash, entry }] of entries.entries()) {
  const t = performance.now();
  const cached = await s.stateOf(hash, rules);
  const ms = performance.now() - t;
  const state = viewState(s.recorded.get(cached.state)!);
  const children = new Map<string, Node[]>();
  for (const node of Object.values(state.nodes) as Node[])
    if (node.active && node.parent !== null) {
      const list = children.get(node.parent) ?? []; list.push(node); children.set(node.parent, list);
    }
  const fresh = { records: 0, bytes: 0 };
  let files = 0, pieces = 0, maxPieces = 0;
  const encode = (node: Node, path: string): string => {
    if (node.pieces) {
      files++; pieces += node.pieces.length; maxPieces = Math.max(maxPieces, node.pieces.length);
      const previous = maxPiecesByPath.get(path) ?? 0;
      if (node.pieces.length !== (series.get(path)?.at(-1)?.[1])) {
        const list = series.get(path) ?? []; list.push([index, node.pieces.length]); series.set(path, list);
      }
      if (node.pieces.length > previous) maxPiecesByPath.set(path, node.pieces.length);
      const known = memo.get(node); if (known) return known;
      const record = put({ node: node.id, kind: node.kind,
        chunks: chunked(node.pieces).map((c) => put(c.map((p) => [p.origin, p.start, p.object, p.offset, p.length]), fresh)) }, fresh);
      memo.set(node, record);
      return record;
    }
    const list = (children.get(node.id) ?? []).sort((a, b) => (a.name < b.name ? -1 : 1));
    return put({ node: node.id, kind: node.kind, entries: list.map((c) => [c.name, encode(c, `${path}/${c.name}`)]) }, fresh);
  };
  encode(state.nodes[state.root] as Node, "");
  const kind = !entry.previous ? "genesis" : entry.trace === null ? "snapshot" : entry.asked ? "asked" : "fast-forward";
  perEntry.push({ index, kind, ...fresh, files, pieces, maxPieces, ms: Math.round(ms * 10) / 10 });
  if (index % 1000 === 0) console.error(`${index}/${entries.length} ${Math.round((performance.now() - started) / 1000)}s records=${stored.size} bytes=${totalBytes}`);
}
const top = [...maxPiecesByPath].sort((a, b) => b[1] - a[1]).slice(0, 15);
writeFileSync(out, JSON.stringify({
  mask: MASK, entries: entries.length, replaySeconds: (performance.now() - started) / 1000,
  totalRecords: stored.size, totalBytes, perEntry,
  top: top.map(([path, max]) => ({ path, max, series: series.get(path) })),
}));
console.error(`done ${entries.length} in ${Math.round((performance.now() - started) / 1000)}s records=${stored.size} bytes=${totalBytes}`);
