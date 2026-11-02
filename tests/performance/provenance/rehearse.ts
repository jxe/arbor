/** Performance 004 step 4 rehearsal: each asked entry's question answered by a
 * cold sidecar (no cached or saved state) that starts from provenance
 * indexes, under the live budgets: the recorded rules' evaluation budget and
 * the 10 s replay deadline, retried as overstoryd retries "retry to
 * continue". Compares each answer with the accepted entry.
 *   bun tests/performance/provenance/rehearse.ts <data-root> <tree> <out.jsonl> [last-n]
 * The data root must hold the tree's indexes (provenance/v1). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ObjectStore, holdsObject } from "@ovst/object-store";
import { stableJSONString } from "@ovst/protocol";
import { acceptedEntries } from "../../support/log-entries.ts";
import { recordedQuestion } from "../../support/replay-check.ts";
import { Sidecar } from "../../../packages/overstoryd-merge/src/sidecar.ts";
import { provenanceIn } from "../../../packages/overstoryd-merge/src/provenance.ts";

const [root, tree, out, lastArg] = process.argv.slice(2);
if (!root || !tree || !out) throw Error("usage: rehearse.ts <data-root> <tree> <out.jsonl> [last-n]");
const entries = acceptedEntries(root, tree);
const shared = new ObjectStore(join(root, "objects"), { cacheBytes: 256 * 1024 * 1024 });
const staged = new Map<string, Uint8Array>();
const stores = {
  shared: { find: (hash: string) => shared.find(hash), has: (hash: string) => holdsObject(shared, hash) },
  staging: { find: async (hash: string) => staged.get(hash) ?? null, stage: async (values: Array<{ hash: string; bytes: Uint8Array }>) => { for (const v of values) staged.set(v.hash, v.bytes); } },
  provenance: provenanceIn(join(root, "provenance"), (hash) => shared.find(hash)),
};
const first = Math.max(0, entries.length - Number(lastArg ?? entries.length));
writeFileSync(out, "");
let n = 0, same = 0, failed = 0;
const started = performance.now();
for (const [index, { id, entry }] of entries.entries()) {
  if (index < first || !entry.previous || !entry.asked) continue;
  // A fresh process per question: nothing cached, nothing saved.
  const sidecar = new Sidecar(stores, 512 * 1024 * 1024);
  const t = performance.now();
  let attempts = 0, result: Record<string, unknown> = {}, slowest = 0;
  for (;;) {
    attempts++;
    const a = performance.now();
    try {
      const answer = await sidecar.answer(recordedQuestion(entry));
      result = { same: answer.root === entry.root && stableJSONString(answer.decisions) === stableJSONString(entry.decisions),
        root: answer.root === entry.root };
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/retry to continue/.test(message) && attempts < 200) { slowest = Math.max(slowest, performance.now() - a); continue; }
      result = { same: false, error: message.slice(0, 200) };
      break;
    } finally { slowest = Math.max(slowest, performance.now() - a); }
  }
  n++; if (result.same) same++; if (result.error) failed++;
  appendFileSync(out, JSON.stringify({ index, ordinal: Number(id), kind: entry.trace === null ? "snapshot" : "traced",
    window: index - 1 - entries.findIndex((e) => e.hash === (entry.asked!.base ?? entry.previous)),
    attempts, slowestAttemptMs: Math.round(slowest), ms: Math.round(performance.now() - t),
    indexed: sidecar.indexedCount, seeded: sidecar.seededCount, ...result }) + "\n");
  if (n % 10 === 0) console.error(`${n} questions, ${same} same, ${failed} failed, ${Math.round((performance.now() - started) / 1000)} s`);
}
console.error(`done: ${n} questions, ${same} same as accepted, ${failed} failed`);
