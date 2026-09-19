/** Synthetic, in-memory diagnostic: one file, one-byte append per update.
 * No server, live data, cross-request cache, or network is involved. */
import { Fixture } from "../unit/merge/fixture.ts";
import { loadIntentState } from "../../packages/merge/src/state-storage.ts";
import { mergeIntent, validateIntentState } from "../../packages/merge/src/intent-engine.ts";
import type { IntentRequestInput } from "../../packages/merge/src/intent-model.ts";

/** Full-evaluator cost of one request, eager (reads all history) vs lazy. */
async function evaluate(request: IntentRequestInput) {
  const out: Record<string, number> = {};
  for (const eager of [true, false]) {
    let bytes = 0;
    const start = performance.now();
    const response = await mergeIntent(request, {
      read: async (hash) => {
        const value = fixture.objects.get(hash)!;
        bytes += value.length;
        return value;
      },
      store: async (values) => {
        for (const value of values) fixture.objects.set(value.hash, value.bytes);
      },
    }, { incremental: false, eager });
    if (response.outcome !== "evaluated") throw Error(JSON.stringify(response));
    out[eager ? "eagerBytes" : "lazyBytes"] = bytes;
    out[eager ? "eagerMs" : "lazyMs"] = Math.round(performance.now() - start);
  }
  return out;
}
const edit1 = (base: string, text: string, at: number, inserted: string, remove = 0) =>
  ({ next: text.slice(0, at) + inserted + text.slice(at + remove), op: {
    kind: "editSource" as const, key: "edit",
    source: fixture.ref("/a.md", text, [at, at + remove]), text: inserted } });

const fixture = new Fixture();
let text = "a";
let current: string | { object: string; state: string } = fixture.tree({
  "a.md": text,
});
const checkpoints = new Set([16, 32, 64, 128, 256]);
const history: Array<{ text: string; state: { object: string; state: string } }> = [];
for (let edit = 1; edit <= 256; edit++) {
  const next = text + "x";
  current = (
    await fixture.run(
      fixture.request(
        current,
        fixture.tree({ "a.md": next }),
        [
          {
            kind: "editSource",
            key: "append",
            source: fixture.ref("/a.md", text, [text.length, text.length]),
            text: "x",
          },
        ],
        `edit-${edit}`,
      ),
    )
  ).result;
  text = next;
  history.push({ text, state: current as { object: string; state: string } });
  if (!checkpoints.has(edit)) continue;
  let stateBytes = 0;
  const loadStart = performance.now();
  const state = await loadIntentState(
    current.state,
    async (hash) => fixture.objects.get(hash)!,
    undefined,
    undefined,
    { bytes: (count) => (stateBytes = count), references: () => {} },
  );
  const loadMs = performance.now() - loadStart;
  // Entries per history field: what a full evaluator materializes today and
  // what lazy loading (plan 010, Phase 4) must stop touching whole.
  const historyEntries = Object.fromEntries(
    (["outputs", "effects", "origins", "alternatives", "changes"] as const).map(
      (field) => [field, Object.keys(state[field]).length],
    ),
  );
  const effectNodes = Object.values(state.effects).flatMap((effect) => [
    ...Object.values(effect.before),
    ...Object.values(effect.after),
  ]);
  const historicalPieces = effectNodes.flatMap((node) => node.pieces ?? []);
  let reads = 0,
    bytes = 0;
  const start = performance.now();
  await validateIntentState(current, "tree", {
    read: async (hash) => {
      const value = fixture.objects.get(hash)!;
      reads++;
      bytes += value.length;
      return value;
    },
    store: async () => {},
  });
  console.log(
    JSON.stringify({
      edits: edit,
      nodes: Object.keys(state.nodes).length,
      currentPieces: Object.values(state.nodes).reduce(
        (sum, node) => sum + (node.pieces?.length ?? 0),
        0,
      ),
      historicalPieces: historicalPieces.length,
      uniqueHistoricalPieces: new Set(
        historicalPieces.map((piece) => JSON.stringify(piece)),
      ).size,
      effectBytes: new TextEncoder().encode(JSON.stringify(state.effects))
        .length,
      historyEntries,
      stateBytes,
      stateLoadMs: loadMs,
      validationReads: reads,
      validationBytes: bytes,
      coldValidationMs: performance.now() - start,
    }),
  );
  const head = current as { object: string; state: string };
  // A divergent edit based four updates back.
  const old = history.at(-5)!;
  const divergent = edit1("", old.text, 0, "D");
  const merge = await evaluate(fixture.request(old.state, fixture.tree({ "a.md": divergent.next }), [divergent.op], `divergent-${edit}`, head));
  // A live decision on head, then an unrelated edit on top of it.
  const a = edit1("", text, 0, "A", 1), b = edit1("", text, 0, "B", 1);
  const withA = await fixture.run(fixture.request(head, fixture.tree({ "a.md": a.next }), [a.op], `a-${edit}`));
  const conflicted = await fixture.run(fixture.request(head, fixture.tree({ "a.md": b.next }), [b.op], `b-${edit}`, withA.result));
  const visible = fixture.content(conflicted.result.object, "a.md");
  const later = edit1("", visible, visible.length, "z");
  const decision = await evaluate(fixture.request(conflicted.result, fixture.tree({ "a.md": later.next }), [later.op], `later-${edit}`));
  console.log(JSON.stringify({ edits: edit, divergent: merge, liveDecision: { decisions: conflicted.decisions.length, ...decision } }));
}
