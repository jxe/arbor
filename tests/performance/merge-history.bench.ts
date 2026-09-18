/** Synthetic, in-memory diagnostic: one file, one-byte append per update.
 * No server, live data, cross-request cache, or network is involved. */
import { Fixture } from "../unit/merge/fixture.ts";
import { loadIntentState } from "../../packages/merge/src/state-storage.ts";
import { validateIntentState } from "../../packages/merge/src/intent-engine.ts";

const fixture = new Fixture();
let text = "a";
let current: string | { object: string; state: string } = fixture.tree({
  "a.md": text,
});
const checkpoints = new Set([16, 32, 64, 128, 256]);
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
  if (!checkpoints.has(edit)) continue;
  const state = await loadIntentState(
    current.state,
    async (hash) => fixture.objects.get(hash)!,
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
      validationReads: reads,
      validationBytes: bytes,
      validationMs: performance.now() - start,
    }),
  );
}
