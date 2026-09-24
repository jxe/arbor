import { hashObject } from "@overstory/protocol";
import { MergeRefusal } from "@overstory/merge-protocol";
import { mergeIntent } from "../../packages/canopyd-merge/src/intent-engine.ts";
import type { IntentRequestInput } from "../../packages/canopyd-merge/src/intent-model.ts";
import type { IntentEvaluation } from "../../packages/canopyd-merge/src/engine-contract.ts";
import type { RetainedState } from "../../packages/canopyd-merge/src/retained-state.ts";

const recorded = new WeakMap<ReadonlyMap<string, Uint8Array>, Map<string, RetainedState>>();

/** Run the sidecar's engine in process over a map of objects: an authored
 * evaluation, as the sidecar makes one for a traced question. New objects go
 * into the returned map; the input map is left alone. The engine states it
 * records are kept per input map, so a later evaluation over the same map can
 * name them as a basis. */
export async function evaluateIntent(
  request: IntentRequestInput,
  inputs: ReadonlyMap<string, Uint8Array>,
): Promise<{ response: IntentEvaluation; objects: Map<string, Uint8Array> }> {
  const objects = new Map<string, Uint8Array>();
  const response = await mergeIntent(request, {
    // Verifies as the sidecar's stores do: the engine does not hash again.
    read: async (hash) => {
      const bytes = objects.get(hash) ?? inputs.get(hash);
      if (!bytes) throw new MergeRefusal("missing-context", `Object is unavailable: ${hash}`);
      if (hashObject(bytes) !== hash) throw new Error(`Stored object hash mismatch: ${hash}`);
      return bytes;
    },
    states: recorded.get(inputs) ?? recorded.set(inputs, new Map()).get(inputs)!,
    store: async (values) => {
      for (const { hash, bytes } of values) {
        if (hashObject(bytes) !== hash) throw new Error("Object hash mismatch");
        objects.set(hash, bytes);
      }
    },
  });
  if (response.outcome !== "evaluated") throw new Error(`${response.outcome}: ${response.message}`);
  return { response, objects };
}
