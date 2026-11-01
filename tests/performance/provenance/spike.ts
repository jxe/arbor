/** Performance 004 spike: can a question be answered from the index alone?
 *   bun tests/performance/provenance/spike.ts <data-root> <tree> <out.jsonl> [origins|bare] [from-index]
 *
 * A warm sidecar replays the whole chain once (the reference). Then each
 * asked entry's question is answered again by a fresh sidecar that knows,
 * for every entry at or before the question's base, only what the index
 * would give it: nodes and pieces (plus the engine's retained decisions),
 * with every history map emptied. Entries between base and head are
 * replayed from there, as their traces allow. With `origins`, the origins
 * map is kept, standing in for lineage the engine derives on demand.
 * Each line compares the answer with the accepted entry. */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ObjectStore, holdsObject } from "@ovst/object-store";
import { hashObject, stableJSONString } from "@ovst/protocol";
import { acceptedEntries } from "../../support/log-entries.ts";
import { recordedQuestion } from "../../support/replay-check.ts";
import { DEFAULT_RULES, unbudgeted } from "./unbudgeted.ts";
import { Sidecar } from "../../../packages/overstoryd-merge/src/sidecar.ts";
import type { RetainedState, Bucket } from "../../../packages/overstoryd-merge/src/retained-state.ts";

const [root, tree, out, variantArg = "bare", onlyArg] = process.argv.slice(2);
if (!root || !tree || !out) throw Error("usage: spike.ts <data-root> <tree> <out.jsonl> [bare|origins|full[,…]] [index,index,…]");
// bare: every history map emptied; origins: origins kept (derived lineage);
// full: nothing emptied, a control for the harness itself.
const variants = variantArg.split(",");
const rules = DEFAULT_RULES;
const entries = acceptedEntries(root, tree);
const position = new Map(entries.map((e, i) => [e.hash, i]));
const shared = new ObjectStore(join(root, "objects"));
const staged = new Map<string, Uint8Array>();
const stores = {
  shared: { find: (hash: string) => shared.find(hash), has: (hash: string) => holdsObject(shared, hash) },
  staging: { find: async (hash: string) => staged.get(hash) ?? null, stage: async (values: Array<{ hash: string; bytes: Uint8Array }>) => { for (const v of values) staged.set(v.hash, v.bytes); } },
};
type Cached = { object: string; state: string; decisions: unknown[] };
type Internals = { stateOf(hash: string, rules: unknown): Promise<Cached>; recorded: Map<string, RetainedState>; states: Map<string, Cached>;
  memory: Map<string, Uint8Array>; entries: Map<string, unknown>; replayed: number };
const warm = unbudgeted(new Sidecar(stores, Infinity, undefined, Infinity)) as unknown as Internals;
const started = performance.now();
for (const [index, { hash }] of entries.entries()) {
  await warm.stateOf(hash, rules);
  if (index % 1000 === 0) console.error(`reference ${index}/${entries.length} ${Math.round((performance.now() - started) / 1000)}s`);
}
console.error(`reference replay ${Math.round((performance.now() - started) / 1000)}s`);

const empty: Bucket = { entries: [], hash: hashObject(new TextEncoder().encode("L")), size: 0, count: 0 };
const strippedStates = new Map<string, RetainedState>();
const strip = (variant: string, id: string): string => {
  if (variant === "full") return id;
  const sid = `stripped:${variant}:${id}`;
  if (!strippedStates.has(sid)) {
    const r = warm.recorded.get(id)!;
    strippedStates.set(sid, { ...r, history: { outputs: empty, effects: empty, alternatives: empty, changes: empty,
      origins: variant === "origins" ? r.history.origins : empty } });
  }
  return sid;
};
/** The fresh sidecar's states: its own, else the index's view of any entry at or before `upto`. */
class IndexStates extends Map<string, Cached> {
  constructor(private upto: number, private variant: string) { super(); }
  override has(hash: string) { return super.has(hash) || (position.get(hash) ?? Infinity) <= this.upto; }
  override get(hash: string) {
    const own = super.get(hash); if (own) return own;
    if ((position.get(hash) ?? Infinity) > this.upto) return undefined;
    const c = warm.states.get(hash)!;
    const value = { ...c, state: strip(this.variant, c.state) };
    super.set(hash, value);
    return value;
  }
}
class Recorded extends Map<string, RetainedState> {
  override get(id: string) { return super.get(id) ?? strippedStates.get(id) ?? warm.recorded.get(id); }
  override has(id: string) { return super.has(id) || strippedStates.has(id) || warm.recorded.has(id); }
}
writeFileSync(out, "");
const only = onlyArg ? new Set(onlyArg.split(",").map(Number)) : undefined;
let n = 0, matched = 0;
for (const [index, { id, entry }] of entries.entries()) {
  if ((only && !only.has(index)) || !entry.previous || !entry.asked) continue;
  const base = position.get(entry.asked.base ?? entry.previous)!;
  for (const variant of variants) {
  const fresh = unbudgeted(new Sidecar(stores, Infinity, undefined, Infinity)) as unknown as Internals;
  fresh.memory = warm.memory; fresh.entries = warm.entries;
  fresh.recorded = new Recorded(); fresh.states = new IndexStates(base, variant);
  const t = performance.now();
  let result: Record<string, unknown>;
  try {
    const answer = await (fresh as unknown as Sidecar).answer(recordedQuestion(entry));
    const same = answer.root === entry.root && stableJSONString(answer.decisions) === stableJSONString(entry.decisions);
    result = { same, root: answer.root === entry.root, decisions: stableJSONString(answer.decisions) === stableJSONString(entry.decisions),
      answer: hashObject(new TextEncoder().encode(stableJSONString({ root: answer.root, decisions: answer.decisions }))).slice(7, 23) };
  } catch (error) {
    result = { same: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
  n++; if (result.same) matched++;
  appendFileSync(out, JSON.stringify({ variant, index, ordinal: Number(id), kind: entry.trace === null ? "snapshot" : "traced",
    window: index - 1 - base, replayed: fresh.replayed, ms: Math.round(performance.now() - t), ...result }) + "\n");
  if (n % 50 === 0) console.error(`${n} questions, ${matched} same`);
  }
}
console.error(`done: ${n} questions, ${matched} same as accepted`);
