import { canonicalCBORHash, encodeCanonicalCBOR } from "../index.ts";
import type { ObjectHash } from "../objects.ts";
import type { CandidateUpdate, UpdateRequest } from "./types.ts";

export type UpdateIntentBase = string | null | { requestDigest: ObjectHash; candidate: ObjectHash };
export type UpdateIntent = Pick<CandidateUpdate, "candidate" | "ifCurrent" | "resolves" | "change" | "trace"> & { base: UpdateIntentBase };

function intent(tree: string, request: UpdateIntent) {
  return {
    // `arbor-update/2` carries the trace. Receipts under the previous domain
    // hashed a flat operation list and cannot collide with these.
    domain: "arbor-update/2",
    change: request.change,
    trace: request.trace,
    tree,
    base: request.base,
    candidate: request.candidate,
    resolves: request.resolves,
    ifCurrent: request.ifCurrent ?? null,
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
