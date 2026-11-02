/** Diagnostic: object reads a cold merge helper makes per question, split
 * into provenance index reads and tree/engine reads, with an optional delay
 * per read to model a slow volume. Fresh store (no read cache) per question.
 *   DELAY_MS=2 bun tests/performance/provenance/cold-reads.ts <data-root> <tree> [last-n] */
import { join } from "node:path";
import { ObjectStore, holdsObject } from "@ovst/object-store";
import { acceptedEntries } from "../../support/log-entries.ts";
import { recordedQuestion } from "../../support/replay-check.ts";
import { Sidecar } from "../../../packages/overstoryd-merge/src/sidecar.ts";
import { provenanceIn } from "../../../packages/overstoryd-merge/src/provenance.ts";

const [root, tree, lastArg] = process.argv.slice(2);
if (!root || !tree) throw Error("usage: cold-reads.ts <data-root> <tree> [last-n]");
const delay = Number(process.env.DELAY_MS ?? 0);
const entries = acceptedEntries(root, tree);
const asked = entries.filter(({ entry }) => entry.previous && entry.asked).slice(-Number(lastArg ?? 40));
const rows: Array<{ ms: number; index: number; other: number; indexBytes: number; seeded: number; replayed: number }> = [];
for (const { entry } of asked) {
  const store = new ObjectStore(join(root, "objects"), { cacheBytes: 0 });
  const counts = { index: 0, other: 0, indexBytes: 0 };
  const read = (kind: "index" | "other") => async (hash: string) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const bytes = await store.find(hash);
    counts[kind]++; if (kind === "index") counts.indexBytes += bytes?.length ?? 0;
    return bytes;
  };
  const staged = new Map<string, Uint8Array>();
  const sidecar = new Sidecar({
    shared: { find: read("other"), has: (hash) => holdsObject(store, hash) },
    staging: { find: async (h) => staged.get(h) ?? null, stage: async (v) => { for (const o of v) staged.set(o.hash, o.bytes); } },
    provenance: provenanceIn(join(root, "provenance"), read("index")),
  }, 512 * 1024 * 1024);
  const t = performance.now();
  try { await sidecar.answer(recordedQuestion(entry)); } catch { continue; }
  rows.push({ ms: performance.now() - t, ...counts, seeded: sidecar.seededCount, replayed: sidecar.replayed });
}
const med = (k: keyof typeof rows[number]) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return Math.round(v[v.length >> 1]!); };
const max = (k: keyof typeof rows[number]) => Math.round(Math.max(...rows.map((r) => r[k])));
console.log(JSON.stringify({ delay, n: rows.length, ms: med("ms"), msMax: max("ms"), indexReads: med("index"), indexReadsMax: max("index"),
  indexKB: Math.round(med("indexBytes") / 1024), otherReads: med("other"), otherMax: max("other"), replayed: med("replayed") }));
