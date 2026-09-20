/** Complete consolidated requests used by Wire clients and Canopy.
 * This module does not send requests or translate the deployed request encoding.
 */
import { authoredRequestIdentities, decodeAuthoredRequestIntent, decodeAuthoredCandidateIntent, type AuthoredRequestIntent, type AuthoredUpdateIntent } from "./authored-contract.ts";
import { decodeTransitionPayloadJSON, encodeTransitionPayloadJSON, type TransitionPayloadJSON } from "./json.ts";
import type { TransitionPayload } from "./types.ts";
import { hashObject } from "../objects.ts";

export type AuthoredCandidate = AuthoredUpdateIntent & TransitionPayload;
export interface AuthoredUpdateRequest { base: string | null; updates: AuthoredCandidate[] }
export interface AuthoredUpdateRequestJSON { base: string | null; updates: (AuthoredUpdateIntent & TransitionPayloadJSON)[] }

/** Strip only transport fields. Unknown semantic fields still fail closed. */
export function authoredIntentFromTransport(raw: unknown): AuthoredRequestIntent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected update request");
  const { updates, ...request } = raw as Record<string, unknown>;
  if (!Array.isArray(updates)) throw new Error("Expected updates array");
  return decodeAuthoredRequestIntent({ ...request, updates: updates.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected candidate");
    const { objects: _objects, deltas: _deltas, ...intent } = raw as Record<string, unknown>;
    return intent;
  }) });
}

/** Decode transport and verify complete object bytes; graph and operation execution are authority checks. */
export function decodeAuthoredUpdateRequestJSON(raw: unknown): AuthoredUpdateRequest {
  const intent = authoredIntentFromTransport(raw);
  const values = (raw as { updates: Record<string, unknown>[] }).updates;
  const updates = values.map((value, index) => {
    const candidate = decodeAuthoredCandidateJSON(value);
    if (intent.base === null && index === 0 && candidate.deltas.length) throw new Error("Activation has no delta basis");
    return candidate;
  });
  return { base: intent.base, updates };
}

export function encodeAuthoredUpdateRequestJSON(request: AuthoredUpdateRequest): AuthoredUpdateRequestJSON {
  const intent = authoredIntentFromTransport(request);
  const value = { base: intent.base, updates: intent.updates.map((u, i) => ({ ...u, ...encodeTransitionPayloadJSON(request.updates[i]!) })) };
  // In-process builders must meet the same contract as received JSON.
  decodeAuthoredUpdateRequestJSON(value);
  return value;
}

export function authoredTransportIdentities(tree: string, request: AuthoredUpdateRequest) {
  return authoredRequestIdentities(tree, authoredIntentFromTransport(request));
}

export function decodeAuthoredCandidateJSON(raw: unknown): AuthoredCandidate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected candidate");
  const { objects, deltas, ...fields } = raw as Record<string, unknown>;
  const intent = decodeAuthoredCandidateIntent(fields);
  const payload = decodeTransitionPayloadJSON({objects,deltas});
  if (payload.objects.length !== (objects as unknown[]).length) throw new Error("Duplicate complete object");
  for (const object of payload.objects) {
    if (hashObject(object.bytes) !== object.hash) throw new Error("Complete object hash mismatch");
  }
  return { ...intent, ...payload };
}
export function encodeAuthoredCandidateJSON(candidate: AuthoredCandidate): AuthoredUpdateIntent & TransitionPayloadJSON {
  const {objects: _objects,deltas: _deltas,...fields} = candidate;
  const value = {...decodeAuthoredCandidateIntent(fields),...encodeTransitionPayloadJSON(candidate)};
  decodeAuthoredCandidateJSON(value);
  return value;
}
