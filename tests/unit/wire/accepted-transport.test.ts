import { expect, test } from "bun:test";
import { applyObjectDelta } from "../../../packages/wire/src/updates/apply.ts";
import { decodeAcceptedTransitionJSON, decodeUpdateResponseJSON, decodeObjectEnvelopes, decodeTransitionPayloadJSON, verifyTreeSnapshotGraph } from "../../../packages/wire/src/updates/json.ts";
import { hashObject, type ObjectHash } from "../../../packages/wire/src/objects.ts";
import vectors from "../../../conformance/wire-accepted-transport.json";
import { decodeAcceptedWatchChange, decodeSubmissionResponse } from "../../../packages/wire/src/updates/accepted-contract.ts";
for (const c of vectors.cases) test(`accepted transport: ${c.name}`, () => {
  const value = structuredClone(c.value);
  const decode = () => {
    if (c.kind === "watch") {
      const change = decodeAcceptedWatchChange(value, vectors.tree, c.basis);
      change.transitions.forEach(decodeAcceptedTransitionJSON);
      return change;
    }
    decodeUpdateResponseJSON(value);
    return decodeSubmissionResponse(value);
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
      const payload = decodeTransitionPayloadJSON(transition);
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
