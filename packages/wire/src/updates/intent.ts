import { canonicalCBORHash, encodeCanonicalCBOR } from "@arbor/core";
import type { UpdateRequest } from "./types.ts";

function intent(tree: string, request: Pick<UpdateRequest, "base" | "candidate">) {
  return { version: "updates-v1", tree, base: request.base, candidate: request.candidate };
}

/**
 * The semantic identity of an update request as canonical CBOR bytes. Object
 * envelopes are transport aids: their order and whether an already-stored
 * object is retransmitted do not change the requested reconciliation.
 */
export function canonicalUpdateIntent(tree: string, request: Pick<UpdateRequest, "base" | "candidate">): Uint8Array {
  return encodeCanonicalCBOR(intent(tree, request));
}

export function updateRequestDigest(tree: string, request: Pick<UpdateRequest, "base" | "candidate">): string {
  return canonicalCBORHash(intent(tree, request));
}
