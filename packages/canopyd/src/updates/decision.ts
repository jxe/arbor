import type { ObjectHash } from "@overstory/protocol";

export type UpdateDecision = "current" | "accept" | "reconcile";

/** Identity-only snapshot fast paths; concurrent work always reconciles. */
export function decideUpdate(base: ObjectHash, candidate: ObjectHash, current: ObjectHash): UpdateDecision {
  if (candidate === current || candidate === base) return "current";
  if (current === base) return "accept";
  return "reconcile";
}
