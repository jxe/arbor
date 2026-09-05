import { canonicalCBORHash, encodeCanonicalCBOR } from "@arbor/core";
import type { ObjectHash } from "../objects.ts";
import type { CandidateUpdate, OnConflict, UpdateRequest } from "./types.ts";

export type UpdateIntentBase = string | null | { requestDigest: ObjectHash; candidate: ObjectHash };
export type UpdateIntent = Pick<CandidateUpdate, "candidate" | "ifMatch" | "onConflict"> & { base: UpdateIntentBase };

/** `onConflict` at its effective value: merge unless the request says reject. */
export function effectiveOnConflict(request: Pick<CandidateUpdate, "onConflict">): OnConflict {
  return request.onConflict ?? "merge";
}

function intent(tree: string, request: UpdateIntent) {
  return {
    version: "updates-v1",
    tree,
    base: request.base,
    candidate: request.candidate,
    ifMatch: request.ifMatch,
    onConflict: effectiveOnConflict(request),
  };
}

/**
 * The semantic identity of an update request as canonical CBOR bytes. Object
 * envelopes are transport aids: their order and whether an already-stored
 * object is retransmitted do not change the requested reconciliation.
 */
export function canonicalUpdateIntent(tree: string, request: UpdateIntent): Uint8Array {
  return encodeCanonicalCBOR(intent(tree, request));
}

export function updateRequestDigest(tree: string, request: UpdateIntent): string {
  return canonicalCBORHash(intent(tree, request));
}

/** Stable per-element identities for one append-only update string. */
export function updateRequestDigests(tree: string, request: UpdateRequest): ObjectHash[] {
  const digests: ObjectHash[] = [];
  let base: UpdateIntentBase = request.base;
  for (const update of request.updates) {
    const digest = updateRequestDigest(tree, { base, ...update }) as ObjectHash;
    digests.push(digest);
    base = { requestDigest: digest, candidate: update.candidate };
  }
  return digests;
}
