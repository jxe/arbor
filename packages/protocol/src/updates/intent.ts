import { canonicalCBORHash, encodeCanonicalCBOR } from "../index.ts";
import type { ObjectHash } from "../objects.ts";
import type { CandidateUpdate, UpdateRequest } from "./types.ts";

export type UpdateIntentBase = string | null | { requestDigest: ObjectHash; candidate: ObjectHash };
export type UpdateIntent = Pick<CandidateUpdate, "candidate" | "ifCurrent" | "resolves" | "change" | "trace"> & { base: UpdateIntentBase };

function intent(tree: string, request: UpdateIntent) {
  return {
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

/**
 * Each element's canonical intent bytes and digest for one append-only update
 * string: each later element's base is its predecessor's
 * `{ requestDigest, candidate }`.
 */
export function updateRequestIdentities(tree: string, request: Pick<UpdateRequest, "base"> & { updates: UpdateIntent[] | readonly Omit<UpdateIntent, "base">[] }): Array<{ bytes: Uint8Array; digest: ObjectHash }> {
  let base: UpdateIntentBase = request.base;
  return request.updates.map((update) => {
    const value = intent(tree, { ...update, base });
    const identity = { bytes: encodeCanonicalCBOR(value), digest: canonicalCBORHash(value) as ObjectHash };
    base = { requestDigest: identity.digest, candidate: update.candidate };
    return identity;
  });
}

/** Stable per-element identities for one append-only update string. */
export function updateRequestDigests(tree: string, request: UpdateRequest): ObjectHash[] {
  return updateRequestIdentities(tree, request).map((identity) => identity.digest);
}
