import {
  transitionPayload,
  type AcceptedTransitionPayload,
  type LoadObject,
  type ObjectHash,
  type TreeReader,
} from "@overstory/protocol";

/**
 * Derive one replayable sparse transition from the authority's actual accepted
 * endpoints. Endpoints may be adjacent accepted roots or span a backlog;
 * intermediate history is not read or rewritten. Every object was hash-checked
 * by the reader while walking the canonical graph; the store encodes the
 * payload once, when it persists it.
 */
export function buildAcceptedTransitionPayload(
  previousRoot: ObjectHash,
  targetRoot: ObjectHash,
  load: LoadObject | TreeReader,
): Promise<AcceptedTransitionPayload> {
  return transitionPayload(previousRoot, targetRoot, load);
}
