import { canonicalJSONString, semanticRequestDigest } from "@arbor/core";
import type { UpdateRequest } from "./types.ts";

/**
 * The semantic identity of an update request. Object envelopes are transport
 * aids: their order and whether an already-stored object is retransmitted do
 * not change the requested reconciliation.
 */
export function canonicalUpdateIntent(tree: string, request: Pick<UpdateRequest, "base" | "candidate">): string {
  return canonicalJSONString({
    base: request.base,
    candidate: request.candidate,
    tree,
    version: "updates-v1",
  });
}

export function updateRequestDigest(tree: string, request: Pick<UpdateRequest, "base" | "candidate">): string {
  return semanticRequestDigest({
    base: request.base,
    candidate: request.candidate,
    tree,
    version: "updates-v1",
  });
}
