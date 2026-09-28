import { expect, test } from "bun:test";
import { applyObjectDelta } from "../../../packages/protocol/src/updates/apply.ts";
import { encodeAcceptedTransitionJSON, decodeUpdateResponseJSON, encodeUpdateResponseJSON, decodeObjectEnvelopes, verifyTreeSnapshotGraph } from "../../../packages/protocol/src/updates/json.ts";
import { hashObject, type ObjectHash } from "../../../packages/protocol/src/objects.ts";
import type { AcceptedTransition } from "../../../packages/protocol/src/updates/types.ts";
import vectors from "../../../docs/overstory-spec/conformance/protocol-accepted-transport.json";
import { decodeAcceptedWatchChange } from "../../../packages/protocol/src/updates/accepted-contract.ts";

type StateLink = { id: string; root: string };

/** A watch case is a run of frames: each one transition, whose basis is the one before it. */
function decodeFrames(frames: unknown[], basis: StateLink | undefined): AcceptedTransition[] {
  return frames.map((frame) => {
    const { transition } = decodeAcceptedWatchChange(frame, vectors.tree, basis);
    basis = { id: transition.update.id, root: transition.update.root };
    return transition;
  });
}

for (const c of vectors.cases) test(`accepted transport: ${c.name}`, () => {
  const value = structuredClone(c.value) as any;
  const decode = () => {
    // Decoding then encoding again must reproduce the vector exactly.
    if (c.kind === "watch") {
      const transitions = decodeFrames(value, c.basis);
      return value.map((frame: object, index: number) => ({ ...frame, transition: encodeAcceptedTransitionJSON(transitions[index]!) }));
    }
    return encodeUpdateResponseJSON(decodeUpdateResponseJSON(value));
  };
  if (c.valid) expect<unknown>(decode()).toEqual(value);
  else expect(decode).toThrow();
});

test("complete and sparse frame runs reconstruct exact bytes after a same-root decision", () => {
  const outcomes = vectors.cases.slice(0, 2).map(c => {
    const transitions = decodeFrames(c.value as unknown[], c.basis);
    let root = vectors.snapshot.root;
    let objects = new Map(decodeObjectEnvelopes(vectors.snapshot.objects).map(o => [o.hash, o.bytes]));
    for (const transition of transitions) {
      expect(transition.update.previous!.root).toBe(root);
      const supplied = new Map(transition.objects.map(o => [o.hash, o.bytes]));
      for (const delta of transition.deltas) {
        const bytes = applyObjectDelta(objects.get(delta.base)!, delta);
        expect(hashObject(bytes)).toBe(delta.result);
        supplied.set(delta.result, bytes);
      }
      if (transition.update.root !== root) {
        // The fixture replaces its entire small graph; verify the resulting graph
        // rather than treating a matching claimed root as proof of correspondence.
        objects = verifyTreeSnapshotGraph({ root: transition.update.root as ObjectHash, objects: supplied }).objects;
      } else expect(supplied.size).toBe(0);
      root = transition.update.root;
    }
    expect(transitions[0]!.update.conflicted).toBe(true);
    return { root, objects };
  });
  expect(outcomes[0]).toEqual(outcomes[1]);
});
