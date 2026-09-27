import { expect, test } from "bun:test";
import { applyObjectDelta } from "../../../packages/protocol/src/updates/apply.ts";
import { encodeAcceptedTransitionJSON, decodeUpdateResponseJSON, encodeUpdateResponseJSON, decodeObjectEnvelopes, verifyTreeSnapshotGraph } from "../../../packages/protocol/src/updates/json.ts";
import { hashObject, type ObjectHash } from "../../../packages/protocol/src/objects.ts";
import vectors from "../../../docs/overstory-spec/conformance/protocol-accepted-transport.json";
import { decodeAcceptedWatchChange } from "../../../packages/protocol/src/updates/accepted-contract.ts";
for (const c of vectors.cases) test(`accepted transport: ${c.name}`, () => {
  const value = structuredClone(c.value);
  const decode = () => {
    // Decoding then encoding again must reproduce the vector exactly.
    if (c.kind === "watch") {
      const change = decodeAcceptedWatchChange(value, vectors.tree, c.basis);
      return { ...value, transitions: change.transitions.map(encodeAcceptedTransitionJSON) };
    }
    return encodeUpdateResponseJSON(decodeUpdateResponseJSON(value));
  };
  if (c.valid) expect<unknown>(decode()).toEqual(value);
  else expect(decode).toThrow();
});

test("complete and sparse batches reconstruct exact bytes after a same-root decision", () => {
  const outcomes = vectors.cases.slice(0, 2).map(c => {
    const change = decodeAcceptedWatchChange(c.value, vectors.tree, c.basis);
    let root = vectors.snapshot.root;
    let objects = new Map(decodeObjectEnvelopes(vectors.snapshot.objects).map(o => [o.hash, o.bytes]));
    for (const transition of change.transitions) {
      expect(transition.update.previous!.root).toBe(root);
      const payload = transition;
      const supplied = new Map(payload.objects.map(o => [o.hash, o.bytes]));
      for (const delta of payload.deltas) {
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
    expect(change.transitions[0]!.update.conflicted).toBe(true);
    return { root, objects };
  });
  expect(outcomes[0]).toEqual(outcomes[1]);
});
