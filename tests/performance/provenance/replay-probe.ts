/** Performance 004 spike: replay a tree's whole chain in one warm sidecar and
 * record, per entry, which history records its evaluation read.
 *   bun tests/performance/provenance/replay-probe.ts <data-root> <tree> <out.jsonl> [limit]
 * Each line: the entry's ordinal, kind, base depth, timing, and per history
 * field the distinct keys read (found or missing) and whole-map enumerations. */
import { appendFileSync, writeFileSync } from "node:fs";
import { acceptedEntries } from "../../support/log-entries.ts";
import { sidecar } from "../../support/replay-check.ts";
import { DEFAULT_RULES, unbudgeted } from "./unbudgeted.ts";
import { historyProbe } from "../../../packages/overstoryd-merge/src/retained-state.ts";
import { engineDiagnostics } from "../../../packages/overstoryd-merge/src/intent-engine.ts";

const [root, tree, out, limitArg] = process.argv.slice(2);
if (!root || !tree || !out) throw Error("usage: replay-probe.ts <data-root> <tree> <out.jsonl> [limit]");
const entries = acceptedEntries(root, tree);
const limit = Number(limitArg ?? entries.length);
const position = new Map(entries.map((e, i) => [e.hash, i]));
const answering = unbudgeted(sidecar(root)) as unknown as { stateOf(hash: string, rules: unknown): Promise<unknown> };
const rules = DEFAULT_RULES;
writeFileSync(out, "");
type Reads = Record<string, { found: Set<string>; missing: Set<string>; enumerated: number[] }>;
let reads: Reads = {};
historyProbe.read = (field, kind, key, found) => {
  const r = (reads[field] ??= { found: new Set(), missing: new Set(), enumerated: [] });
  if (kind === "enumerate") r.enumerated.push(Number(key));
  else (found ? r.found : r.missing).add(key!);
};
const started = performance.now();
for (const [index, { id, hash, entry }] of entries.slice(0, limit).entries()) {
  reads = {};
  const t = performance.now();
  await answering.stateOf(hash, rules);
  const ms = performance.now() - t;
  const kind = !entry.previous ? "genesis" : entry.trace === null ? (entry.asked ? "snapshot-asked" : "snapshot-ff")
    : !entry.asked ? "fast-forward" : entry.asked.base && entry.asked.base !== entry.previous ? "asked-old-basis" : "asked-head-basis";
  const base = entry.asked?.base ?? entry.previous;
  appendFileSync(out, JSON.stringify({
    index, ordinal: Number(id), change: entry.change, kind, ms: Math.round(ms * 10) / 10,
    base: base ? position.get(base) : null, path: engineDiagnostics.path,
    decisions: entry.decisions.length,
    reads: Object.fromEntries(Object.entries(reads).map(([f, r]) => [f, { found: [...r.found], missing: [...r.missing], enumerated: r.enumerated }])),
  }) + "\n");
  if (index % 500 === 0) console.error(`${index}/${limit} ${Math.round((performance.now() - started) / 1000)}s`);
}
console.error(`done ${limit} in ${Math.round((performance.now() - started) / 1000)}s`);
