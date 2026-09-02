import type { IfMatch, ObjectHash } from "@arbor/wire";

export type UpdateDecision = "current" | "accept" | "reject" | "reconcile";

/**
 * The identity-only part of the updates-v1 state machine. `reject` is a
 * `bytesHash` match that no longer holds; `reconcile` is a `modelHash` match
 * that the node-level merge must evaluate.
 */
export function decideUpdate(base: ObjectHash, candidate: ObjectHash, current: ObjectHash, ifMatch: IfMatch = "modelHash"): UpdateDecision {
  if (candidate === current || candidate === base) return "current";
  if (current === base) return "accept";
  return ifMatch === "bytesHash" ? "reject" : "reconcile";
}
