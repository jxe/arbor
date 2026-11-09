/** Diagnostic for Merge 002: what common editor bursts cost on the wire, one
 * local record per editor generation, on one long Markdown page.
 *
 * For each burst it prints the encoded request bytes (CBOR body, objects,
 * deltas and trace included), update/frame/operation counts and the time the
 * publication compiler takes, three ways: every record as its own update
 * (uncoalesced), and the compiled publication (`publication` then the same
 * transport compaction the coordinator applies).
 *
 *   bun tests/performance/coalescing-bursts.ts
 *   PAGE_KB=64 bun tests/performance/coalescing-bursts.ts
 */
import { applySourceChange, decodeBase64, decodeTreeSnapshotJSON, encodeProtocolDirectory, hashObject, type SourceMove, type TreeSnapshot } from "@ovst/protocol";
import { prepareSourceChange, type LocalChange } from "@ovst/working-tree";
import { encodeAttempt } from "../../packages/working-tree/src/control.ts";
import { compactTransport, dropIntermediates, publication } from "../../packages/working-tree/src/publication.ts";

const pageKB = Number(process.env.PAGE_KB ?? 64);
type Step = { edits?: Array<{ offset: number; length: number; replacement: string }>; moves?: SourceMove[] };

const lines: string[] = [];
for (let index = 0; lines.join("\n").length < pageKB * 1024; index++)
  lines.push(index % 12 === 0 ? `## Section ${index}` : `- [ ] Item ${index}: ${"some words about the task ".repeat(1 + (index % 4))}`);
const initial = lines.join("\n") + "\n";
const encoder = new TextEncoder();
const offsetOfLine = (source: string, line: number) => { let at = 0; for (let i = 0; i < line; i++) at = source.indexOf("\n", at) + 1; return at; };
const lineEnd = (source: string, line: number) => source.indexOf("\n", offsetOfLine(source, line));

export function recordsFor(source: string, steps: Step[], path = "/note.md"): LocalChange[] {
  const bytes = encoder.encode(source), file = hashObject(bytes);
  const directory = encodeProtocolDirectory({ type: "directory", entries: [{ name: path.slice(1), file }] }), root = hashObject(directory);
  let graph: TreeSnapshot = { root, objects: new Map([[file, bytes], [root, directory]]) };
  const result: LocalChange[] = [];
  for (const [index, step] of steps.entries()) {
    const edits = step.edits ?? [], next = applySourceChange(source, edits, step.moves);
    const record = prepareSourceChange({ change: `c${index}`, tree: "tr_bursts", graph, sourcePath: path,
      basis: index ? { kind: "authored", change: `c${index - 1}` } : { kind: "accepted", root: graph.root, update: "up_initial" },
      intent: { basis: { tree: "tr_bursts", path, revision: `r${index}`, source }, edits, moves: step.moves, source: next } });
    result.push(record); graph = decodeTreeSnapshotJSON(record.candidate); source = next;
  }
  return result;
}

/** The bursts, each as editor generations over the page. */
export function bursts(source: string): Record<string, Step[]> {
  const typed = "Call the plumber about the kitchen sink tomorrow";
  const end = lineEnd(source, 5);
  const typing: Step[] = [...typed].map((c, i) => ({ edits: [{ offset: end + i, length: 0, replacement: c }] }));
  const backspace: Step[] = Array.from({ length: 20 }, (_, i) => ({ edits: [{ offset: end - 1 - i, length: 1, replacement: "" }] }));
  const wordAt = source.indexOf("words", offsetOfLine(source, 7));
  const replacement = "phrases";
  const replace: Step[] = [...replacement].map((c, i) => ({ edits: [{ offset: wordAt + i, length: i ? 0 : 5, replacement: c }] }));
  const correction: Step[] = [];
  { let at = lineEnd(source, 9);
    for (const c of " teh") correction.push({ edits: [{ offset: at++, length: 0, replacement: c }] });
    for (let i = 0; i < 2; i++) correction.push({ edits: [{ offset: --at, length: 1, replacement: "" }] });
    for (const c of "he cat") correction.push({ edits: [{ offset: at++, length: 0, replacement: c }] }); }
  const indent: Step[] = [10, 11, 12, 13].map(line => ({ edits: [{ offset: offsetOfLine(source, line), length: 0, replacement: "  " }] }));
  // Option-arrow: one block moves down past ten neighbours, one per generation.
  const blockMoves: Step[] = [];
  { let current = source, line = 20;
    for (let i = 0; i < 10; i++) {
      const s = offsetOfLine(current, line), e = offsetOfLine(current, line + 1), n = offsetOfLine(current, line + 2);
      const move = { source: [s, e] as [number, number], anchor: [e, n] as [number, number], side: "after" as const };
      blockMoves.push({ moves: [move] }); current = applySourceChange(current, [], [move]); line++;
    } }
  // A selection of three blocks moves down five times.
  const selectionMoves: Step[] = [];
  { let current = source, line = 40;
    for (let i = 0; i < 5; i++) {
      const s = offsetOfLine(current, line), e = offsetOfLine(current, line + 3), n = offsetOfLine(current, line + 4);
      const move = { source: [s, e] as [number, number], anchor: [e, n] as [number, number], side: "after" as const };
      selectionMoves.push({ moves: [move] }); current = applySourceChange(current, [], [move]); line++;
    } }
  // Move a block, then indent it and type in it: move plus edits.
  const moveThenEdit: Step[] = [];
  { const s = offsetOfLine(source, 60), e = offsetOfLine(source, 61), n = offsetOfLine(source, 62);
    const move = { source: [s, e] as [number, number], anchor: [e, n] as [number, number], side: "after" as const };
    moveThenEdit.push({ moves: [move] });
    const moved = applySourceChange(source, [], [move]), at = offsetOfLine(moved, 61);
    moveThenEdit.push({ edits: [{ offset: at, length: 0, replacement: "  " }] });
    const lineStop = lineEnd(applySourceChange(moved, [{ offset: at, length: 0, replacement: "  " }]), 61);
    for (const [i, c] of [..."!!"].entries()) moveThenEdit.push({ edits: [{ offset: lineStop + i, length: 0, replacement: c }] }); }
  // Option-arrow five times, type a word in the block, five more moves.
  const movesAroundTyping: Step[] = [];
  { let current = source, line = 80;
    const down = () => { const s = offsetOfLine(current, line), e = offsetOfLine(current, line + 1), n = offsetOfLine(current, line + 2);
      const move = { source: [s, e] as [number, number], anchor: [e, n] as [number, number], side: "after" as const };
      movesAroundTyping.push({ moves: [move] }); current = applySourceChange(current, [], [move]); line++; };
    for (let i = 0; i < 5; i++) down();
    for (const c of " now") { const at = lineEnd(current, line); const edits = [{ offset: at, length: 0, replacement: c }]; movesAroundTyping.push({ edits }); current = applySourceChange(current, edits); }
    for (let i = 0; i < 5; i++) down(); }
  return { "moves around typing": movesAroundTyping, typing, backspace, "word replacement": replace, correction, indentation: indent, "block moves": blockMoves, "selection moves": selectionMoves, "move then edits": moveThenEdit };
}

const wire = (records: LocalChange[], updates: LocalChange["update"][]) => decodeBase64(encodeAttempt("tr_bursts", { root: records[0]!.graph.root, update: "up_initial" }, { base: "up_initial", updates }).body).length;
const counts = (updates: LocalChange["update"][]) => ({ updates: updates.length,
  frames: updates.reduce((n, u) => n + (u.trace?.length ?? 0), 0), operations: updates.reduce((n, u) => n + (u.trace ?? []).reduce((m, f) => m + f.operations.length, 0), 0) });

if (import.meta.main) {
  console.log(`page ${Math.round(encoder.encode(initial).length / 1024)} KB`);
  for (const [name, steps] of Object.entries(bursts(initial))) {
    const records = recordsFor(initial, steps);
    // Uncoalesced: each record compacted against the previous candidate, as the coordinator does.
    const separate = records.map((record, i) => compactTransport(record.update, i ? records[i - 1]!.candidate : record.graph, record.candidate));
    const started = performance.now();
    const compiled = publication(records, []);
    const compiledUpdates = compiled ? [compactTransport(compiled.update, records[0]!.graph, records.at(-1)!.candidate)] : separate;
    const ms = performance.now() - started;
    const kinds = [...new Set(compiledUpdates.flatMap(u => (u.trace ?? []).flatMap(f => f.operations.map(o => o.kind))))].join("+");
    console.log(JSON.stringify({ burst: name, records: records.length,
      uncoalesced: { bytes: wire(records, separate), ...counts(separate) },
      published: { bytes: wire(records, compiledUpdates), ...counts(compiledUpdates), kinds, ms: Math.round(ms * 10) / 10 } }));
    void dropIntermediates;
  }
}
