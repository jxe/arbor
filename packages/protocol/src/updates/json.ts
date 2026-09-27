import { decodeTransitionBasis, decodeAcceptedUpdate } from "./accepted-contract.ts";
import { decodeAuthoredCandidateIntent, decodeAuthoredRequestIntent, type AuthoredRequestIntent, type AuthoredUpdateIntent } from "./authored-contract.ts";
import { decodeProtocolDirectory, hashObject, protocolEntryObject, type ProtocolEntryKind, type ObjectHash, type TreeSnapshot } from "../objects.ts";
import { decodeCanonicalCBOR, encodeCanonicalCBOR } from "../model/cbor.ts";
import type {
  AcceptedTransition,
  AcceptedUpdate,
  ObjectDelta,
  UpdateConflict,
  UpdateConflictResult,
  TransitionPayload,
  CandidateUpdate,
  UpdateRequest,
  UpdateHead,
  UpdateResponse,
  UpdateResult,
} from "./types.ts";

/**
 * A request or response body travels as JSON or as the canonical CBOR of the
 * same value (tree operations §4.4). The two differ only where object bytes
 * travel: padded base64 text in JSON, a byte string in CBOR. The `…JSON`
 * shapes below name that one value; `B` is how its bytes are spelled.
 */
export type WireEncoding = "json" | "cbor";
export type WireBytes<E extends WireEncoding = "json"> = E extends "cbor" ? Uint8Array : string;

export const WIRE_CONTENT_TYPE: Readonly<Record<WireEncoding, string>> = { json: "application/json", cbor: "application/cbor" };

/** The encoding a `Content-Type` names: CBOR for `application/cbor`, JSON otherwise (as before CBOR joined it). */
export function wireEncodingOf(contentType: string | null | undefined): WireEncoding {
  return contentType?.split(";")[0]!.trim().toLowerCase() === WIRE_CONTENT_TYPE.cbor ? "cbor" : "json";
}

/** Whether an `Accept` header asks for a CBOR success response. */
export function acceptsCBOR(accept: string | null | undefined): boolean {
  return !!accept && accept.split(",").some(part => part.split(";")[0]!.trim().toLowerCase() === WIRE_CONTENT_TYPE.cbor);
}

/** A wire value as body bytes: JSON text, or canonical CBOR. */
export function encodeWireBody(value: unknown, encoding: WireEncoding): Uint8Array {
  return encoding === "cbor" ? encodeCanonicalCBOR(value) : new TextEncoder().encode(JSON.stringify(value));
}

/** Body bytes as a wire value. CBOR must already be canonical; JSON must be UTF-8. */
export function decodeWireBody(bytes: Uint8Array, encoding: WireEncoding): unknown {
  return encoding === "cbor" ? decodeCanonicalCBOR(bytes) : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function encodeWireBytes<E extends WireEncoding>(bytes: Uint8Array, encoding: E): WireBytes<E> {
  return (encoding === "cbor" ? bytes : encodeBase64(bytes)) as WireBytes<E>;
}

/**
 * The one reader of a bytes field: a CBOR byte string, or JSON's canonical
 * padded base64. Each encoding admits only its own spelling, so base64 text
 * where CBOR carries bytes is refused.
 */
export function decodeWireBytes(value: unknown, encoding: WireEncoding, what = "Object bytes"): Uint8Array {
  if (encoding === "cbor") {
    if (!(value instanceof Uint8Array)) throw new Error(`${what} must be a CBOR byte string`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${what} must be base64 text`);
  return decodeBase64(value);
}

export interface ObjectEnvelopeJSON<B extends string | Uint8Array = string> {
  hash: ObjectHash;
  bytes: B;
}

export interface ObjectDeltaJSON<B extends string | Uint8Array = string> {
  base: ObjectHash;
  result: ObjectHash;
  instructions: Array<{ copy: { offset: number; length: number } } | { insert: B }>;
}

export interface UpdateRequestJSON<B extends string | Uint8Array = string> {
  base: string | null;
  updates: CandidateUpdateJSON<B>[];
}

export interface CandidateUpdateJSON<B extends string | Uint8Array = string> extends AuthoredUpdateIntent, TransitionPayloadJSON<B> {}

export interface TransitionPayloadJSON<B extends string | Uint8Array = string> {
  objects: ObjectEnvelopeJSON<B>[];
  deltas: ObjectDeltaJSON<B>[];
}

export interface AcceptedTransitionJSON extends TransitionPayloadJSON {
  from?: AcceptedTransition["from"];
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

export function decodeObjectEnvelopes(value: unknown, encoding: WireEncoding = "json"): Array<{ hash: ObjectHash; bytes: Uint8Array }> {
  if (!Array.isArray(value)) throw new Error("Expected objects");
  const objects = new Map<ObjectHash, Uint8Array>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("Invalid object envelope");
    const record = item as { hash?: unknown; bytes?: unknown };
    if (typeof record.hash !== "string") throw new Error("Invalid object envelope");
    const hash = record.hash as ObjectHash;
    const bytes = decodeWireBytes(record.bytes, encoding);
    const existing = objects.get(hash);
    if (existing && !bytesEqual(existing, bytes)) throw new Error(`Object ${hash} was supplied with different bytes`);
    objects.set(hash, bytes);
  }
  return [...objects].map(([hash, bytes]) => ({ hash, bytes }));
}

export function encodeObjectEnvelopes<E extends WireEncoding = "json">(objects: Iterable<readonly [ObjectHash, Uint8Array]>, encoding: E = "json" as E): ObjectEnvelopeJSON<WireBytes<E>>[] {
  return [...objects].map(([hash, bytes]) => ({ hash, bytes: encodeWireBytes(bytes, encoding) }));
}

export function decodeObjectDeltas(value: unknown, encoding: WireEncoding = "json"): ObjectDelta[] {
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
      const insert = decodeWireBytes(value.insert, encoding, "Object delta insert");
      if (insert.byteLength === 0) throw new Error("Object delta insert is empty");
      insertedBytes += insert.byteLength;
      if (insertedBytes > MAX_DELTA_INSERT_BYTES) throw new Error("deltas exceeds the insert-byte quota");
      return { insert };
    });
    return { base: record.base as ObjectHash, result, instructions };
  });
}

export function encodeObjectDeltaJSON<E extends WireEncoding = "json">(delta: ObjectDelta, encoding: E = "json" as E): ObjectDeltaJSON<WireBytes<E>> {
  return {
    base: delta.base,
    result: delta.result,
    instructions: delta.instructions.map((instruction) => "copy" in instruction
      ? { copy: { offset: instruction.copy.offset, length: instruction.copy.length } }
      : { insert: encodeWireBytes(instruction.insert, encoding) }),
  };
}

function assertDistinctResults(objects: Array<{ hash: ObjectHash }>, deltas: ObjectDelta[], message: string): void {
  const results = new Set(objects.map(({ hash }) => hash));
  for (const delta of deltas) {
    if (results.has(delta.result)) throw new Error(`${message}: ${delta.result}`);
    results.add(delta.result);
  }
}

export function decodeTransitionPayloadJSON(value: unknown, encoding: WireEncoding = "json"): TransitionPayload {
  if (!value || typeof value !== "object") throw new Error("Transition payload must be an object");
  const record = value as Record<string, unknown> & { objects?: unknown; deltas?: unknown };
  const objects = decodeObjectEnvelopes(record.objects, encoding);
  const deltas = decodeObjectDeltas(record.deltas, encoding);
  assertDistinctResults(objects, deltas, "Transition result supplied more than once");
  return { objects, deltas };
}

export function encodeTransitionPayloadJSON<E extends WireEncoding = "json">(payload: TransitionPayload, encoding: E = "json" as E): TransitionPayloadJSON<WireBytes<E>> {
  return {
    objects: payload.objects.map(({ hash, bytes }) => ({ hash, bytes: encodeWireBytes(bytes, encoding) })),
    deltas: payload.deltas.map(delta => encodeObjectDeltaJSON(delta, encoding)),
  };
}

export function encodeAcceptedTransitionJSON(transition: AcceptedTransition): AcceptedTransitionJSON {
  return {
    update: transition.update,
    ...(transition.from ? { from: transition.from } : {}),
    ...encodeTransitionPayloadJSON(transition),
    ...(transition.requestDigest ? { requestDigest: transition.requestDigest } : {}),
  };
}

export function decodeAcceptedUpdateJSON(value: unknown): AcceptedUpdate {
  return decodeAcceptedUpdate(value);
}

/** Decode one watch transition, verifying every complete object's hash. */
export function decodeAcceptedTransitionJSON(value: unknown): AcceptedTransition {
  if (!value || typeof value !== "object") throw new Error("Accepted transition must be an object");
  const record = value as { update?: unknown; from?: unknown; requestDigest?: unknown };
  const update = decodeAcceptedUpdateJSON(record.update);
  if (update.previous === null) throw new Error("Activation cannot be replayed as a watch transition");
  const payload = decodeVerifiedTransitionPayload(value);
  if (record.requestDigest !== undefined && (typeof record.requestDigest !== "string" || !HASH.test(record.requestDigest))) {
    throw new Error("Invalid transition request digest");
  }
  return {
    update,
    ...payload,
    ...(Object.hasOwn(record, "from") ? { from: decodeTransitionBasis(record.from, update) as NonNullable<AcceptedTransition["from"]> } : {}),
    ...(record.requestDigest ? { requestDigest: record.requestDigest as ObjectHash } : {}),
  };
}

/** A request's semantic intent: the transport fields stripped, unknown semantic fields failing closed. */
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

/** Validate semantic claims without re-encoding large transport payloads. */
export function validateUpdateRequestIntent(request: UpdateRequest): void {
  authoredIntentFromTransport(request);
}

/** Decode a request and verify its complete object bytes; graph and operation execution are authority checks. */
export function decodeUpdateRequestJSON(value: unknown, encoding: WireEncoding = "json"): UpdateRequest {
  const intent = authoredIntentFromTransport(value);
  const updates = (value as { updates: Record<string, unknown>[] }).updates.map((raw) => decodeCandidateUpdateJSON(raw, false, encoding));
  if (intent.base === null && updates[0]!.deltas.length) throw new Error("Activation has no delta basis");
  return { base: intent.base, updates };
}

export function decodeCandidateUpdateJSON(value: unknown, activation = false, encoding: WireEncoding = "json"): CandidateUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected candidate");
  const { objects, deltas, ...fields } = value as Record<string, unknown>;
  const intent = decodeAuthoredCandidateIntent(fields);
  const payload = decodeTransitionPayloadJSON({ objects, deltas }, encoding);
  if (payload.objects.length !== (objects as unknown[]).length) throw new Error("Duplicate complete object");
  for (const object of payload.objects) {
    if (hashObject(object.bytes) !== object.hash) throw new Error("Complete object hash mismatch");
  }
  if (activation) {
    decodeAuthoredRequestIntent({ base: null, updates: [intent] });
    if (payload.deltas.length) throw new Error("Activation has no delta basis");
  }
  return { ...intent, ...payload };
}

/**
 * In-process builders meet the same contract as received JSON: the intent is
 * validated and every object's bytes must hash to its name. The bytes are
 * checked as they are, not encoded and decoded again.
 */
export function encodeUpdateRequestJSON<E extends WireEncoding = "json">(request: UpdateRequest, encoding: E = "json" as E): UpdateRequestJSON<WireBytes<E>> {
  const intent = authoredIntentFromTransport(request);
  if (intent.base === null && request.updates[0]?.deltas.length) throw new Error("Activation has no delta basis");
  request.updates.forEach(verifyCandidateObjects);
  return { base: intent.base, updates: intent.updates.map((update, index) => ({ ...update, ...encodeTransitionPayloadJSON(request.updates[index]!, encoding) })) };
}

export function encodeCandidateUpdateJSON<E extends WireEncoding = "json">(update: CandidateUpdate, encoding: E = "json" as E): CandidateUpdateJSON<WireBytes<E>> {
  const { objects: _objects, deltas: _deltas, ...fields } = update;
  verifyCandidateObjects(update);
  return { ...decodeAuthoredCandidateIntent(fields), ...encodeTransitionPayloadJSON(update, encoding) };
}

function verifyCandidateObjects(candidate: TransitionPayload): void {
  const seen = new Set<string>();
  for (const object of candidate.objects) {
    if (seen.has(object.hash)) throw new Error("Duplicate complete object");
    seen.add(object.hash);
    if (hashObject(object.bytes) !== object.hash) throw new Error("Complete object hash mismatch");
  }
}

export interface TreeSnapshotJSON {
  root: ObjectHash;
  objects: ObjectEnvelopeJSON[];
}

export type UpdateResultJSON<B extends string | Uint8Array = string> = Omit<UpdateResult, "reconciliation"> & { reconciliation?: TransitionPayloadJSON<B> };
export type UpdateResponseJSON<B extends string | Uint8Array = string> = Omit<UpdateResponse, "results"> & { results: UpdateResultJSON<B>[] };

export type UpdateConflictJSON = Omit<UpdateConflictResult, "details"> & {
  details: Omit<UpdateConflictResult["details"], "completed"> & { completed: UpdateResultJSON[] };
};

/** Decode a transition payload once, verifying every complete object's hash and refusing one listed twice. */
function decodeVerifiedTransitionPayload(value: unknown, encoding: WireEncoding = "json"): TransitionPayload {
  const payload = decodeTransitionPayloadJSON(value, encoding);
  if (payload.objects.length !== (value as { objects: unknown[] }).objects.length) throw new Error("Transition object supplied more than once");
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
  const kinds = new Map<ObjectHash, ProtocolEntryKind>();
  const visit = (hash: ObjectHash, kind: ProtocolEntryKind) => {
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
      for (const entry of decodeProtocolDirectory(bytes).entries) {
        const target = protocolEntryObject(entry);
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

export function encodeUpdateConflictJSON(conflict: UpdateConflictResult): UpdateConflictJSON {
  return { ...conflict, details: { ...conflict.details, completed: conflict.details.completed.map(result => encodeUpdateResultJSON(result)) } };
}

const CONFLICT_KINDS = new Set(["server-update", "tree-configuration"]);

export function decodeUpdateConflictJSON(value: unknown): UpdateConflictResult {
  if (!value || typeof value !== "object") throw new Error("Conflict must be an object");
  const record = value as Record<string, unknown>;
  if (record.error !== "conflict" || typeof record.message !== "string" || record.retryable !== false
    || (record.tree !== undefined && typeof record.tree !== "string")
    || !record.details || typeof record.details !== "object") {
    throw new Error("Invalid update conflict");
  }
  const details = record.details as Record<string, unknown>;
  const { completed, failedIndex } = details;
  if (typeof details.kind !== "string" || !CONFLICT_KINDS.has(details.kind)
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
      completed: completed.map(result => decodeUpdateResultJSON(result)),
      failedIndex: failedIndex as number,
      current: decodeAcceptedUpdateJSON(details.current),
      conflicts: details.conflicts as UpdateConflict[],
    },
  };
}

export function encodeUpdateResultJSON<E extends WireEncoding = "json">(result: UpdateResult, encoding: E = "json" as E): UpdateResultJSON<WireBytes<E>> {
  const { reconciliation, ...rest } = result;
  return { ...rest, ...(reconciliation ? { reconciliation: encodeTransitionPayloadJSON(reconciliation, encoding) } : {}) };
}

const OUTCOMES = new Set(["unchanged", "accepted"]);

export function decodeUpdateResultJSON(value: unknown, encoding: WireEncoding = "json"): UpdateResult {
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
    ...(record.reconciliation === undefined ? {} : { reconciliation: decodeVerifiedTransitionPayload(record.reconciliation, encoding) }),
  };
}


export function encodeUpdateResponseJSON<E extends WireEncoding = "json">(response: UpdateResponse, encoding: E = "json" as E): UpdateResponseJSON<WireBytes<E>> {
  return {
    results: response.results.map(result => encodeUpdateResultJSON(result, encoding)),
    observedThrough: response.observedThrough,
    ...(response.head ? { head: response.head } : {}),
  };
}

function decodeUpdateHead(value: unknown): UpdateHead {
  const head = value as Partial<UpdateHead> | null;
  if (!head || typeof head !== "object" || typeof head.update !== "string" || !head.update
    || typeof head.root !== "string" || !HASH.test(head.root) || typeof head.conflicted !== "boolean"
    || typeof head.observedThrough !== "string" || !head.observedThrough) {
    throw new Error("Invalid update head");
  }
  return { update: head.update, root: head.root, conflicted: head.conflicted, observedThrough: head.observedThrough };
}

export function decodeUpdateResponseJSON(value: unknown, encoding: WireEncoding = "json"): UpdateResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Update response must be an object");
  const record = value as { results?: unknown; observedThrough?: unknown; head?: unknown };
  if (!Array.isArray(record.results) || record.results.length === 0 || typeof record.observedThrough !== "string" || !record.observedThrough
    || new TextEncoder().encode(record.observedThrough).length > 1024) {
    throw new Error("Invalid update response");
  }
  return {
    results: record.results.map(result => decodeUpdateResultJSON(result, encoding)),
    observedThrough: record.observedThrough,
    ...(record.head === undefined ? {} : { head: decodeUpdateHead(record.head) }),
  };
}
