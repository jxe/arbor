/** Fixed-size exact-basis edit with increasing unrelated retained history.
 * bun tests/performance/benchmark-history-maps.ts
 * No accepted data is read or changed. Setup and reference evaluation are
 * outside the timer; compare answer digests across implementations. */
import { hashObject, stableJSONString } from "@ovst/protocol";
import { mergeIntent } from "../../packages/overstoryd-merge/src/intent-engine.ts";
import { historyMapDiagnostics, resetHistoryMapDiagnostics, retainState } from "../../packages/overstoryd-merge/src/retained-state.ts";
import { Fixture } from "../unit/overstoryd-merge/fixture.ts";

const counts = (process.env.COUNTS ?? "1000,10000").split(",").map(Number);
const repeats = Number(process.env.REPEATS ?? 20);
for (const count of counts) {
  const f = new Fixture(), root = f.tree({ "a.md": "abc\n" });
  const initial = await f.run(f.request(root, f.tree({ "a.md": "Abc\n" }), [
    { kind: "editSource", key: "edit", source: f.ref("/a.md", "abc\n", [0, 1]), text: "A" },
  ], "initial"));
  const seed = f.state(initial.result);
  for (const field of ["changes", "effects", "outputs", "origins"] as const) {
    const map = seed[field] as Record<string, unknown>, value = Object.values(map)[0];
    if (value === undefined) throw Error(`Missing seed ${field}`);
    for (let i = 0; i < count; i++) map[`unrelated-${i}`] = value;
  }
  const basis = { object: initial.result.object, state: retainState(f.states, seed, initial.result.object, true).id };
  const request = f.request(basis, f.tree({ "a.md": "ABc\n" }), [
    { kind: "editSource", key: "edit", source: f.ref("/a.md", "Abc\n", [1, 2]), text: "B" },
  ], "next");
  const objects = { read: async (hash: string) => f.objects.get(hash)!, states: f.states,
    store: async (values: Array<{ hash: string; bytes: Uint8Array }>) => { for (const v of values) f.objects.set(v.hash, v.bytes); } };
  const reference = await mergeIntent(request, objects, { incremental: false, eager: true });
  const times: number[] = [];
  for (let i = 0; i < repeats + 3; i++) {
    resetHistoryMapDiagnostics();
    const start = performance.now(), result = await mergeIntent(request, objects);
    const elapsed = performance.now() - start;
    if (stableJSONString(result) !== stableJSONString(reference)) throw Error("Reference answer differs");
    if (i >= 3) times.push(elapsed);
  }
  times.sort((a,b) => a-b);
  console.log(JSON.stringify({ count, repeats, medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.min(times.length - 1, Math.ceil(times.length * .95) - 1)],
    historyWork: { ...historyMapDiagnostics }, answerDigest: hashObject(Buffer.from(stableJSONString(reference))), peakRSS: process.resourceUsage().maxRSS }));
}
