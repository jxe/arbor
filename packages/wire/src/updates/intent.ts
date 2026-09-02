import { canonicalCBORHash, encodeCanonicalCBOR } from "@arbor/core";
import type { OnConflict, UpdateRequest } from "./types.ts";

export type UpdateIntent = Pick<UpdateRequest, "base" | "candidate" | "ifMatch" | "onConflict">;

/** `onConflict` at its effective value: merge unless the request says reject. */
export function effectiveOnConflict(request: Pick<UpdateRequest, "onConflict">): OnConflict {
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
