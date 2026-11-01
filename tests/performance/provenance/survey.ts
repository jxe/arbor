/** Read-only survey of a data root's accepted history (Performance 004 step 1).
 *   bun tests/performance/provenance/survey.ts <data-root> [tree]
 * Counts, per tree, the chain from its head: fast-forwards, asked entries,
 * old-basis questions, snapshots, and operation kinds. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readLogEntry } from "../../support/log-entries.ts";

const [root, only] = process.argv.slice(2);
if (!root) throw Error("usage: survey.ts <data-root> [tree]");
const db = new Database(join(root, "overstoryd.sqlite3"), { readonly: true });
const trees = db.query("SELECT tree_id AS id, entry AS ref FROM accepted_updates WHERE ordinal IN (SELECT max(ordinal) FROM accepted_updates GROUP BY tree_id) ORDER BY ordinal").all() as Array<{ id: string; ref: string }>;
for (const { id, ref } of trees) {
  if (only && id !== only) continue;
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  let chain = 0, oldBasisDepths: number[] = [];
  const order: string[] = [];
  for (let at: string | null = ref; at; ) {
    const e = readLogEntry(root, at);
    order.push(at);
    chain++;
    if (!e.previous) bump("genesis");
    else if (e.trace === null) bump(e.asked ? "snapshot-asked" : "snapshot-ff");
    else if (!e.asked) bump("fast-forward");
    else if (e.asked.base && e.asked.base !== e.previous) bump("asked-old-basis");
    else bump("asked-head-basis");
    if (e.decisions.length) bump("with-decisions");
    if (e.asked?.prefix?.length) bump("with-prefix");
    for (const f of e.trace ?? []) for (const op of f.operations) bump(`op:${(op as { kind: string }).kind}`);
    at = e.previous;
  }
  // depth of old bases (entries between base and previous)
  const index = new Map(order.map((h, i) => [h, i]));
  for (const h of order) {
    const e = readLogEntry(root, h);
    if (e.asked?.base && e.asked.base !== e.previous) oldBasisDepths.push((index.get(e.asked.base) ?? NaN) - (index.get(h) ?? 0) - 1);
  }
  oldBasisDepths.sort((a, b) => a - b);
  const q = (p: number) => oldBasisDepths[Math.floor(p * (oldBasisDepths.length - 1))];
  console.log(JSON.stringify({ tree: id, chain, ...counts, oldBasisDepth: oldBasisDepths.length ? { p50: q(0.5), p90: q(0.9), max: q(1) } : null }));
}
