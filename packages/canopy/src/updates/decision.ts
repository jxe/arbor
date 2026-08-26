import type { ObjectHash } from "@arbor/wire";

export type UpdateDecision = "current" | "accept" | "merge";

/** The complete identity-only updates-v1 state machine. */
export function decideUpdate(base: ObjectHash, candidate: ObjectHash, current: ObjectHash): UpdateDecision {
  if (candidate === current || candidate === base) return "current";
  if (current === base) return "accept";
  return "merge";
}
