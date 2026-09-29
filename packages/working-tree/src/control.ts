import { decodeBase64, decodeWireBody, encodeBase64, encodeUpdateRequestJSON, encodeWireBody, updateRequestDigests, decodeUpdateRequestJSON,
  type UpdateRequest, type WireEncoding } from "@overstory/protocol";
import type { ChangePublication } from "./publication.ts";
import type { HeldReason } from "./update-machine.ts";

/**
 * What the update machine's runner retains beside the change log: the exact
 * persisted request and the change it ends at, why it is held, and which
 * changes have settled. The accepted `{ root, update, cursor }` is the working
 * tree's own state. The same schema as Swift's `UpdateControl` (schema 5).
 */
export interface UpdateControl {
  schema: 5;
  publications?: ChangePublication[];
  attempt?: UpdateAttempt;
  /** The local change the attempt's last element carries. */
  attemptTip?: string;
  held?: { reason: HeldReason; detail?: string };
  /** Changes an accepted update incorporates, until the log compacts them. */
  settled: string[];
  acceptedConflicted?: boolean;
}

/**
 * One exact persisted request. Its body carries every envelope it will ever
 * send; resubmission reads only the body, never a live object store.
 */
export interface UpdateAttempt {
  tree: string;
  base: { root: string; update: string };
  candidate: string;
  generation: number;
  /** Base64 of the request body's exact bytes, in the encoding `contentType` names. */
  body: string;
  /**
   * `application/cbor` for a CBOR body. Absent is JSON: every attempt written
   * before bodies could be CBOR, which therefore replays unchanged.
   */
  contentType?: "application/cbor";
  /** All per-element digests in prefix order. */
  requestDigests: string[];
  digest: string;
}

/** Durable storage for the control record. `phase` names the machine state for the diagnostic event stream. */
export interface ControlStore {
  load(): Promise<UpdateControl>;
  write(control: UpdateControl, phase: string): Promise<void>;
}

/** Durable state holds work this client cannot run, or disagrees with itself. Nothing is rewritten. */
export class UpdateStateError extends Error {
  constructor(message: string) { super(message); this.name = "UpdateStateError"; }
}

/** The host's answer does not match the request, or a local invariant failed: synchronization stops. */
export class UpdateValidationError extends Error {
  constructor(message: string) { super(message); this.name = "UpdateValidationError"; }
}

export function emptyControl(): UpdateControl { return { schema: 5, settled: [] }; }

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);

/** Decode a control record. A newer schema, or earlier unpublished work in a form this client no longer runs, is refused. */
export function decodeControl(value: unknown, file = "update-control.json"): UpdateControl {
  if (!value || typeof value !== "object") throw new UpdateStateError(`${file} is not a control record`);
  const record = value as Record<string, unknown>;
  const schema = record.schema;
  if (typeof schema !== "number" || !Number.isInteger(schema)) throw new UpdateStateError(`${file} has no schema`);
  if (schema > 5) throw new UpdateStateError(`${file} schema ${schema} is newer than this client`);
  if (schema < 4) {
    const earlier = record.head != null || record.nextBase != null || (record.attempt != null && record.sourceAttemptChange == null);
    if (earlier) throw new UpdateStateError(`${file} holds unpublished work from an earlier client. Finish publishing it with that version, then update.`);
  }
  const control: UpdateControl = { schema: 5, settled: [] };
  if (record.attempt != null) control.attempt = decodeAttempt(record.attempt, file);
  const tip = schema < 4 ? record.sourceAttemptChange : record.attemptTip;
  if (tip != null) {
    if (typeof tip !== "string" || !tip) throw new UpdateStateError(`${file} has an invalid attempt tip`);
    control.attemptTip = tip;
  }
  if (schema >= 4 && record.held != null) {
    const held = record.held as Record<string, unknown>;
    if (held.reason !== "rejected" && held.reason !== "unsupported") throw new UpdateStateError(`${file} has an invalid held reason`);
    control.held = { reason: held.reason, ...(typeof held.detail === "string" ? { detail: held.detail } : {}) };
  }
  const settled = schema < 4 ? record.sourceAcceptedChanges : record.settled;
  if (settled != null) {
    if (!strings(settled)) throw new UpdateStateError(`${file} has invalid settled changes`);
    control.settled = [...settled];
  }
  if (typeof record.acceptedConflicted === "boolean") control.acceptedConflicted = record.acceptedConflicted;
  if (record.publications != null) {
    if (!Array.isArray(record.publications)) throw new UpdateStateError(`${file} has invalid publications`);
    control.publications = record.publications.map((group: ChangePublication) => {
      if (!strings(group.changes) || !group.changes.length || !group.update?.change || !group.operations || typeof group.operations !== "object") throw new UpdateStateError(`${file} has invalid publication mapping`);
      decodeUpdateRequestJSON({ base: "publication-validation", updates: [group.update] });
      return group;
    });
  }
  if (control.attempt && !control.attemptTip) throw new UpdateStateError(`${file} has an attempt without its tip`);
  return control;
}

function decodeAttempt(value: unknown, file: string): UpdateAttempt {
  const attempt = value as Partial<UpdateAttempt>;
  if (!attempt || typeof attempt.tree !== "string" || typeof attempt.candidate !== "string" || typeof attempt.body !== "string"
      || typeof attempt.digest !== "string" || typeof attempt.base?.root !== "string" || typeof attempt.base?.update !== "string") {
    throw new UpdateStateError(`${file} has an invalid attempt`);
  }
  const digests = attempt.requestDigests ?? [attempt.digest];
  if (!strings(digests)) throw new UpdateStateError(`${file} has invalid request digests`);
  if (attempt.contentType !== undefined && attempt.contentType !== "application/cbor") throw new UpdateStateError(`${file} has an attempt in an unknown encoding`);
  return { tree: attempt.tree, base: { root: attempt.base.root, update: attempt.base.update }, candidate: attempt.candidate,
    generation: typeof attempt.generation === "number" ? attempt.generation : 0, body: attempt.body,
    ...(attempt.contentType ? { contentType: attempt.contentType } : {}), requestDigests: [...digests], digest: attempt.digest };
}

/**
 * Encode one request as an immutable attempt, as CBOR unless `encoding` says
 * otherwise. The body is fixed here; every submission of the attempt sends
 * the same request in the same encoding.
 */
export function encodeAttempt(tree: string, base: { root: string; update: string }, requestJSON: { base: string; updates: unknown[] }, encoding: WireEncoding = "cbor"): UpdateAttempt {
  const request = decodeUpdateRequestJSON(requestJSON);
  const last = request.updates.at(-1);
  if (!last) throw new UpdateValidationError("An update request must carry at least one element");
  const digests = updateRequestDigests(tree, request);
  const body = encoding === "cbor" ? encodeWireBody(encodeUpdateRequestJSON(request, "cbor"), "cbor") : encodeWireBody(requestJSON, "json");
  return { tree, base, candidate: last.candidate, generation: 0, body: encodeBase64(body),
    ...(encoding === "cbor" ? { contentType: "application/cbor" as const } : {}), requestDigests: digests, digest: digests.at(-1)! };
}

/** The encoding an attempt's body is in: JSON unless it names CBOR. */
export function attemptEncoding(attempt: UpdateAttempt): WireEncoding {
  return attempt.contentType === "application/cbor" ? "cbor" : "json";
}

/** The request an attempt's body carries. */
export function attemptRequest(attempt: UpdateAttempt): UpdateRequest {
  const encoding = attemptEncoding(attempt);
  return decodeUpdateRequestJSON(decodeWireBody(decodeBase64(attempt.body), encoding), encoding);
}

/** An altered or incompatible durable request stays on disk for recovery; the runner refuses it. */
export function verifyAttempt(control: UpdateControl): void {
  const attempt = control.attempt;
  if (!attempt) return;
  const request = attemptRequest(attempt);
  const digests = updateRequestDigests(attempt.tree, request);
  if (request.base !== attempt.base.update || request.updates.at(-1)?.candidate !== attempt.candidate
      || (request.updates.at(-1)?.change !== control.attemptTip && !control.publications?.some(group => group.update.change === request.updates.at(-1)?.change && group.changes.at(-1) === control.attemptTip)) || attempt.digest !== attempt.requestDigests.at(-1)
      || digests.length !== attempt.requestDigests.length || digests.some((digest, index) => digest !== attempt.requestDigests[index])) {
    throw new UpdateStateError("Durable update intent does not match its digests");
  }
}
