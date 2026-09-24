import type { ObjectHash } from "@overstory/protocol";
import type { ObjectStore } from "@overstory/object-store";
export { checkpointIntent, mergeIntent } from "./intent-engine.ts";
export type { CheckpointRequest, CheckpointResponse } from "./engine-contract.ts";
export type { Frame, IntentRequest, IntentRequestInput, IntentResponse } from "./intent-model.ts";
import type { RetainedStates } from "./retained-state.ts";

/** Immutable object IO for the engine: no accepted-state or database access.
 * `read` reports an absent object as a `missing-context` `MergeRefusal` (as
 * the sidecar's reader does) or an `ENOENT` error (as `ObjectStore.read`
 * does); any other failure is the store's own and propagates. Bytes it
 * returns are the object's: every production reader verifies them. */
export interface MergeObjects {
  read(hash: ObjectHash): Promise<Uint8Array>;
  store: ObjectStore["store"];
  /** The engine states recorded so far, kept by identity. */
  states: RetainedStates;
}
