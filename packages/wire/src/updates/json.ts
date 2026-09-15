import { authoredIntentFromTransport, decodeAuthoredUpdateRequestJSON, decodeAuthoredCandidateJSON, encodeAuthoredUpdateRequestJSON, encodeAuthoredCandidateJSON } from "./authored-transport.ts";
import { decodeAuthoredRequestIntent, type AuthoredUpdateIntent } from "./authored-contract.ts";
import { decodeWireDirectory, hashObject, wireEntryObject, type WireEntryKind, type ObjectHash, type TreeSnapshot } from "../objects.ts";
import type {
  AcceptedTransition,
  AcceptedTransitionPayload,
  AcceptedUpdate,
  MergeSummary,
  ObjectDelta,
  UpdateConflict,
  UpdateConflictResult,
  TransitionPayload,
  CandidateUpdate,
  UpdateRequest,
  UpdateResponse,
  UpdateResult,
} from "./types.ts";

export interface ObjectEnvelopeJSON {
  hash: ObjectHash;
  bytes: string;
}

export interface ObjectDeltaJSON {
  base: ObjectHash;
  result: ObjectHash;
  instructions: Array<{ copy: { offset: number; length: number } } | { insert: string }>;
}

export interface UpdateRequestJSON {
  base: string | null;
  updates: CandidateUpdateJSON[];
}

export interface CandidateUpdateJSON extends AuthoredUpdateIntent, TransitionPayloadJSON {}

export interface TransitionPayloadJSON {
  objects: ObjectEnvelopeJSON[];
  deltas: ObjectDeltaJSON[];
}

export interface AcceptedTransitionJSON extends TransitionPayloadJSON {
  update: AcceptedTransition["update"];
  requestDigest?: ObjectHash;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_DELTAS = 10_000;
const MAX_DELTA_INSTRUCTIONS = 100_000;
const MAX_DELTA_INSERT_BYTES = 64 * 1024 * 1024;

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Object bytes must use standard padded base64");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (encodeBase64(bytes) !== value) throw new Error("Object bytes are not canonical base64");
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function decodeObjectEnvelopes(value: unknown): Array<{ hash: ObjectHash; bytes: Uint8Array }> {
  if (!Array.isArray(value)) throw new Error("Expected objects");
  const objects = new Map<ObjectHash, Uint8Array>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("Invalid object envelope");
    const record = item as { hash?: unknown; bytes?: unknown };
    if (typeof record.hash !== "string" || typeof record.bytes !== "string") throw new Error("Invalid object envelope");
    const hash = record.hash as ObjectHash;
    const bytes = decodeBase64(record.bytes);
    const existing = objects.get(hash);
    if (existing && !bytesEqual(existing, bytes)) throw new Error(`Object ${hash} was supplied with different bytes`);
    objects.set(hash, bytes);
  }
  return [...objects].map(([hash, bytes]) => ({ hash, bytes }));
}

export function encodeObjectEnvelopes(objects: Iterable<readonly [ObjectHash, Uint8Array]>): ObjectEnvelopeJSON[] {
  return [...objects].map(([hash, bytes]) => ({ hash, bytes: encodeBase64(bytes) }));
}

export function decodeObjectDeltas(value: unknown): ObjectDelta[] {
  if (!Array.isArray(value)) throw new Error("deltas must be an array");
  if (value.length > MAX_DELTAS) throw new Error("deltas exceeds the delta quota");
  const results = new Set<ObjectHash>();
  let instructionCount = 0;
  let insertedBytes = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid object delta");
    const record = item as { base?: unknown; result?: unknown; instructions?: unknown };
    if (typeof record.base !== "string" || !HASH.test(record.base)
      || typeof record.result !== "string" || !HASH.test(record.result)
      || !Array.isArray(record.instructions) || record.instructions.length === 0) {
      throw new Error("Invalid object delta");
    }
    const result = record.result as ObjectHash;
    if (results.has(result)) throw new Error(`Duplicate object delta result: ${result}`);
    results.add(result);
    instructionCount += record.instructions.length;
    if (instructionCount > MAX_DELTA_INSTRUCTIONS) throw new Error("deltas exceeds the instruction quota");
    const instructions = record.instructions.map((instruction) => {
      if (!instruction || typeof instruction !== "object") throw new Error("Invalid object delta instruction");
      const value = instruction as { copy?: unknown; insert?: unknown };
      if ((value.copy === undefined) === (value.insert === undefined)) throw new Error("Object delta instruction requires exactly one operation");
      if (value.copy !== undefined) {
        if (!value.copy || typeof value.copy !== "object") throw new Error("Invalid object delta copy");
        const copy = value.copy as { offset?: unknown; length?: unknown };
        if (!Number.isSafeInteger(copy.offset) || (copy.offset as number) < 0
          || !Number.isSafeInteger(copy.length) || (copy.length as number) <= 0
          || !Number.isSafeInteger((copy.offset as number) + (copy.length as number))) {
          throw new Error("Invalid object delta copy");
        }
        return { copy: { offset: copy.offset as number, length: copy.length as number } };
      }
      if (typeof value.insert !== "string") throw new Error("Invalid object delta insert");
      const insert = decodeBase64(value.insert);
      if (insert.byteLength === 0) throw new Error("Object delta insert is empty");
      insertedBytes += insert.byteLength;
      if (insertedBytes > MAX_DELTA_INSERT_BYTES) throw new Error("deltas exceeds the insert-byte quota");
      return { insert };
    });
    return { base: record.base as ObjectHash, result, instructions };
  });
}

export function encodeObjectDeltaJSON(delta: ObjectDelta): ObjectDeltaJSON {
  return {
    base: delta.base,
    result: delta.result,
    instructions: delta.instructions.map((instruction) => "copy" in instruction
      ? { copy: { offset: instruction.copy.offset, length: instruction.copy.length } }
      : { insert: encodeBase64(instruction.insert) }),
  };
}

function assertDistinctResults(objects: Array<{ hash: ObjectHash }>, deltas: ObjectDelta[], message: string): void {
  const results = new Set(objects.map(({ hash }) => hash));
  for (const delta of deltas) {
    if (results.has(delta.result)) throw new Error(`${message}: ${delta.result}`);
    results.add(delta.result);
  }
}

export function decodeTransitionPayloadJSON(value: unknown): AcceptedTransitionPayload {
  if (!value || typeof value !== "object") throw new Error("Transition payload must be an object");
  const record = value as Record<string, unknown> & { objects?: unknown; deltas?: unknown };
  const objects = decodeObjectEnvelopes(record.objects);
  const deltas = decodeObjectDeltas(record.deltas);
  assertDistinctResults(objects, deltas, "Transition result supplied more than once");
  return { objects, deltas };
}

export function encodeTransitionPayloadJSON(payload: AcceptedTransitionPayload): TransitionPayloadJSON {
  return {
    objects: payload.objects.map(({ hash, bytes }) => ({ hash, bytes: encodeBase64(bytes) })),
    deltas: payload.deltas.map(encodeObjectDeltaJSON),
  };
}

export function encodeAcceptedTransitionJSON(transition: AcceptedTransition): AcceptedTransitionJSON {
  return {
    update: transition.update,
    ...encodeTransitionPayloadJSON(transition),
    ...(transition.requestDigest ? { requestDigest: transition.requestDigest } : {}),
  };
}

const ACCEPTED_KINDS = new Set(["initial", "accepted", "merged", "restored"]);

export function decodeAcceptedUpdateJSON(value: unknown): AcceptedUpdate {
  if (!value || typeof value !== "object") throw new Error("Accepted update must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.tree !== "string" || !record.tree
    || typeof record.root !== "string" || !HASH.test(record.root)
    || (record.previousRoot !== null && (typeof record.previousRoot !== "string" || !HASH.test(record.previousRoot)))
    || typeof record.kind !== "string" || !ACCEPTED_KINDS.has(record.kind)
    || !Number.isSafeInteger(record.acceptedAt)
    || (record.subject !== null && typeof record.subject !== "string")
    || (record.conflicted !== undefined && typeof record.conflicted !== "boolean")
    || (record.merge !== undefined && (!record.merge || typeof record.merge !== "object"))) {
    throw new Error("Invalid accepted update");
  }
  return {
    id: record.id,
    tree: record.tree,
    root: record.root as ObjectHash,
    previousRoot: record.previousRoot as ObjectHash | null,
    kind: record.kind as AcceptedUpdate["kind"],
    acceptedAt: record.acceptedAt as number,
    subject: record.subject as string | null,
    ...(record.conflicted === undefined ? {} : { conflicted: record.conflicted as boolean }),
    ...(record.merge ? { merge: record.merge as MergeSummary } : {}),
  };
}

/** Decode one watch transition, verifying every complete object's hash. */
export function decodeAcceptedTransitionJSON(value: unknown): AcceptedTransition {
  if (!value || typeof value !== "object") throw new Error("Accepted transition must be an object");
  const record = value as { update?: unknown; requestDigest?: unknown };
  const update = decodeAcceptedUpdateJSON(record.update);
  const payload = decodeTransitionPayloadJSON(value);
  for (const object of payload.objects) {
    if (hashObject(object.bytes) !== object.hash) throw new Error(`Transition object hash mismatch: ${object.hash}`);
  }
  if (record.requestDigest !== undefined && (typeof record.requestDigest !== "string" || !HASH.test(record.requestDigest))) {
    throw new Error("Invalid transition request digest");
  }
  return {
    update,
    ...payload,
    ...(record.requestDigest ? { requestDigest: record.requestDigest as ObjectHash } : {}),
  };
}

/** Validate semantic claims without re-encoding large transport payloads. */
export function validateUpdateRequestIntent(request: UpdateRequest): void {
  authoredIntentFromTransport(request);
}
export function decodeUpdateRequestJSON(value: unknown): UpdateRequest {
  return decodeAuthoredUpdateRequestJSON(value);
}
export function decodeCandidateUpdateJSON(value: unknown, activation = false): CandidateUpdate {
  const candidate = decodeAuthoredCandidateJSON(value);
  if (activation) {
    const {objects: _objects,deltas: _deltas,...intent} = candidate;
    decodeAuthoredRequestIntent({base:null,updates:[intent]});
    if (candidate.deltas.length) throw new Error("Activation has no delta basis");
  }
  return candidate;
}
export function encodeUpdateRequestJSON(request: UpdateRequest): UpdateRequestJSON {
  return encodeAuthoredUpdateRequestJSON(request);
}
export function encodeCandidateUpdateJSON(update: CandidateUpdate): CandidateUpdateJSON {
  return encodeAuthoredCandidateJSON(update);
}

export interface TreeSnapshotJSON {
  root: ObjectHash;
  objects: ObjectEnvelopeJSON[];
}

export type UpdateResultJSON = Omit<UpdateResult, "reconciliation"> & { reconciliation?: TransitionPayloadJSON };
export type UpdateResponseJSON = Omit<UpdateResponse, "results"> & { results: UpdateResultJSON[] };

export type UpdateConflictJSON = Omit<UpdateConflictResult, "details"> & {
  details: Omit<UpdateConflictResult["details"], "draft" | "completed"> & {
    completed: UpdateResultJSON[];
    draft: TransitionPayloadJSON & { root: ObjectHash };
  };
};

/** Decode a transition payload, verifying every complete object's hash. */
function decodeVerifiedTransitionPayload(value: unknown): TransitionPayload {
  const payload = decodeTransitionPayloadJSON(value);
  for (const object of payload.objects) {
    if (hashObject(object.bytes) !== object.hash) throw new Error(`Transition object hash mismatch: ${object.hash}`);
  }
  return payload;
}

export function encodeTreeSnapshotJSON(snapshot: TreeSnapshot): TreeSnapshotJSON {
  return { root: snapshot.root, objects: encodeObjectEnvelopes(snapshot.objects) };
}

/**
 * Decode a snapshot envelope, verifying every object's hash and rejecting an
 * object supplied twice with different bytes. Graph completeness is a separate
 * check (`verifyTreeSnapshotGraph`) because a server validates the graph later
 * while a client must refuse an incomplete or noncanonical response.
 */
export function decodeTreeSnapshotJSON(value: unknown): TreeSnapshot {
  if (!value || typeof value !== "object") throw new Error("Snapshot must be an object");
  const record = value as { root?: unknown; objects?: unknown };
  if (typeof record.root !== "string" || !HASH.test(record.root)) throw new Error("Snapshot root hash is invalid");
  const objects = new Map<ObjectHash, Uint8Array>();
  for (const { hash, bytes } of decodeObjectEnvelopes(record.objects)) {
    if (!HASH.test(hash)) throw new Error("Snapshot object hash is invalid");
    if (hashObject(bytes) !== hash) throw new Error(`Snapshot object hash mismatch: ${hash}`);
    objects.set(hash, bytes);
  }
  return { root: record.root as ObjectHash, objects };
}

/** Verify kinds from references, exact hashes, complete directories, and no extra members. */
export function verifyTreeSnapshotGraph(snapshot: TreeSnapshot, mode: "complete" | "sparse-files" = "complete"): TreeSnapshot {
  const visited = new Set<ObjectHash>();
  const visiting = new Set<ObjectHash>();
  const kinds = new Map<ObjectHash, WireEntryKind>();
  const visit = (hash: ObjectHash, kind: WireEntryKind) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid snapshot hash");
    if (kinds.has(hash) && kinds.get(hash) !== kind) throw new Error(`Snapshot object kind conflict: ${hash}`);
    kinds.set(hash, kind);
    if (visiting.has(hash)) throw new Error(`Snapshot directory cycle: ${hash}`);
    if (visited.has(hash)) return;
    const bytes = snapshot.objects.get(hash);
    if (!bytes) {
      if (mode === "sparse-files" && kind === "file") return;
      throw new Error(`Snapshot is missing reachable object: ${hash}`);
    }
    if (hashObject(bytes) !== hash) throw new Error(`Snapshot object hash mismatch: ${hash}`);
    visiting.add(hash);
    if (kind === "directory") {
      for (const entry of decodeWireDirectory(bytes).entries) {
        const target = wireEntryObject(entry);
        if (target) visit(target.hash, target.kind);
      }
    }
    visiting.delete(hash);
    visited.add(hash);
  };
  visit(snapshot.root, "directory");
  if (visited.size !== snapshot.objects.size) throw new Error("Snapshot contains unreachable objects");
  return snapshot;
}

function decodeDraft(value: unknown): UpdateConflictResult["details"]["draft"] {
  if (!value || typeof value !== "object") throw new Error("Conflict draft must be an object");
  const record = value as { root?: unknown };
  if (typeof record.root !== "string" || !HASH.test(record.root)) throw new Error("Conflict draft root hash is invalid");
  return { root: record.root as ObjectHash, ...decodeVerifiedTransitionPayload(value) };
}

export function encodeUpdateConflictJSON(conflict: UpdateConflictResult): UpdateConflictJSON {
  const { draft, completed, ...details } = conflict.details;
  return {
    ...conflict,
    details: {
      ...details,
      completed: completed.map(encodeUpdateResultJSON),
      draft: { root: draft.root, ...encodeTransitionPayloadJSON(draft) },
    },
  };
}

const CONFLICT_KINDS = new Set(["server-update", "account-configuration"]);

export function decodeUpdateConflictJSON(value: unknown): UpdateConflictResult {
  if (!value || typeof value !== "object") throw new Error("Conflict must be an object");
  const record = value as Record<string, unknown>;
  if (record.error !== "conflict" || typeof record.message !== "string" || record.retryable !== false
    || (record.tree !== undefined && typeof record.tree !== "string")
    || !record.details || typeof record.details !== "object") {
    throw new Error("Invalid update conflict");
  }
  const details = record.details as Record<string, unknown>;
  // Temporary mixed-version compatibility for conflicts persisted by clients
  // before update requests became plural. New encoders always write both.
  const completed = details.completed ?? [];
  const failedIndex = details.failedIndex ?? 0;
  if (typeof details.kind !== "string" || !CONFLICT_KINDS.has(details.kind)
    || typeof details.base !== "string" || !HASH.test(details.base)
    || typeof details.candidate !== "string" || !HASH.test(details.candidate)
    || !Array.isArray(completed)
    || !Number.isSafeInteger(failedIndex) || (failedIndex as number) < 0
    || (failedIndex as number) !== completed.length
    || !Array.isArray(details.conflicts)) {
    throw new Error("Invalid update conflict details");
  }
  return {
    error: "conflict",
    message: record.message,
    retryable: false,
    ...(record.tree ? { tree: record.tree as string } : {}),
    details: {
      kind: details.kind as UpdateConflictResult["details"]["kind"],
      completed: completed.map(decodeUpdateResultJSON),
      failedIndex: failedIndex as number,
      current: decodeAcceptedUpdateJSON(details.current),
      base: details.base as ObjectHash,
      candidate: details.candidate as ObjectHash,
      draft: decodeDraft(details.draft),
      conflicts: details.conflicts as UpdateConflict[],
    },
  };
}

export function encodeUpdateResultJSON(result: UpdateResult): UpdateResultJSON {
  const { reconciliation, ...rest } = result;
  return { ...rest, ...(reconciliation ? { reconciliation: encodeTransitionPayloadJSON(reconciliation) } : {}) };
}

const OUTCOMES = new Set(["current", "accepted", "merged"]);

export function decodeUpdateResultJSON(value: unknown): UpdateResult {
  if (!value || typeof value !== "object") throw new Error("Update result must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome)
    || typeof record.requestDigest !== "string" || !HASH.test(record.requestDigest)) {
    throw new Error("Invalid update result");
  }
  const update = decodeAcceptedUpdateJSON(record.update);
  return {
    outcome: record.outcome as UpdateResult["outcome"],
    update,
    requestDigest: record.requestDigest as ObjectHash,
    ...(record.reconciliation === undefined ? {} : { reconciliation: decodeVerifiedTransitionPayload(record.reconciliation) }),
  };
}


export function encodeUpdateResponseJSON(response: UpdateResponse): UpdateResponseJSON {
  return { results: response.results.map(encodeUpdateResultJSON), observedThrough: response.observedThrough };
}

export function decodeUpdateResponseJSON(value: unknown): UpdateResponse {
  if (!value || typeof value !== "object") throw new Error("Update response must be an object");
  const record = value as { results?: unknown; observedThrough?: unknown };
  if (!Array.isArray(record.results) || record.results.length === 0 || typeof record.observedThrough !== "string" || !record.observedThrough) {
    throw new Error("Invalid update response");
  }
  return { results: record.results.map(decodeUpdateResultJSON), observedThrough: record.observedThrough };
}
