import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arborPrivateRoot, prepareArborDataRoot } from "@arbor/stores";
import {
  decodeObjectDeltas,
  decodeTreeSnapshotJSON,
  encodeTreeSnapshotJSON,
  encodeObjectDeltaJSON,
  encodeObjectEnvelopes,
  encodeUpdateConflictJSON,
  type ObjectDelta,
  type ObjectHash,
  type TreeSnapshot,
  type UpdateConflictJSON,
  type UpdateConflictResult,
  type TreeSnapshotJSON,
  type CandidateUpdateJSON,
  applyTransitionPayload,
  decodeUpdateConflictJSON,
} from "@arbor/wire";
import type { FrozenEditorAdmission } from "./editor-admission.ts";
import type { Hash } from "@arbor/core";
import type { AcceptedUpdate } from "@arbor/wire";

/** The durable pending update is exactly the wire request body it will become. */
export type PendingTreeUpdate = CandidateUpdateJSON & {
  base: string | null;
  /**
   * A transmitted prefix repeated verbatim when a newer filesystem head was
   * authored while Canopy was reconciling it. Canopy trims accepted elements
   * by request digest, then applies only each successor's delta from the
   * preceding submitted candidate.
   */
  successors?: CandidateUpdateJSON[];
  /** Explicit Local Arbor API intent remains authoritative during an editor epoch. */
  origin?: "local-api";
};

export interface AcceptedTreeObjects {
  root: ObjectHash;
  hashes: ObjectHash[];
}

/** The durable conflict is the wire conflict body without the optional current snapshot. */
export type StoredTreeConflict = UpdateConflictJSON;

interface TreeSyncState {
  pending?: PendingTreeUpdate;
  conflict?: StoredTreeConflict;
  conflictMaterial?: StoredTreeConflictMaterial;
  accepted?: AcceptedTreeObjects;
  editorAdmissions?: FrozenEditorAdmission[];
  /** Recent Canopy request digests whose accepted state was materialized locally. */
  acceptedRequestDigests?: Hash[];
}

export interface TreeConflictMaterial {
  base: TreeSnapshot;
  current: TreeSnapshot;
  mine: TreeSnapshot;
  draft: TreeSnapshot;
}

interface StoredTreeConflictMaterial {
  identity: string;
  base: TreeSnapshotJSON;
  current: TreeSnapshotJSON;
  mine: TreeSnapshotJSON;
  draft: TreeSnapshotJSON;
}

const MAX_ACCEPTED_REQUEST_DIGESTS = 256;

function safeTreeID(tree: string): string {
  return Buffer.from(tree).toString("base64url");
}

function pathFor(tree: string): string {
  return join(arborPrivateRoot(), "sync", `${safeTreeID(tree)}.json`);
}

const queues = new Map<string, Promise<unknown>>();

/** Serialize every read and read-modify-write of one tree's state file. */
function serialized<T>(tree: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(tree) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(tree, next.catch(() => {}));
  return next;
}

async function load(tree: string): Promise<TreeSyncState> {
  try {
    return JSON.parse(await readFile(pathFor(tree), "utf8")) as TreeSyncState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function save(tree: string, state: TreeSyncState): Promise<void> {
  await prepareArborDataRoot();
  const directory = join(arborPrivateRoot(), "sync");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = pathFor(tree);
  if (
    !state.pending
    && !state.conflict
    && !state.conflictMaterial
    && !state.accepted
    && !state.editorAdmissions?.length
    && !state.acceptedRequestDigests?.length
  ) {
    await rm(destination, { force: true });
    return;
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600).catch(() => {});
}

export function pendingFromSnapshot(
  base: string | null,
  snapshot: TreeSnapshot,
  retained: ReadonlySet<ObjectHash> = new Set(),
  origin?: PendingTreeUpdate["origin"],
): PendingTreeUpdate {
  return {
    base,
    candidate: snapshot.root,
    ifMatch: base === null ? "bytesHash" : "modelHash",
    objects: encodeObjectEnvelopes([...snapshot.objects].filter(([hash]) => !retained.has(hash))),
    deltas: [],
    ...(origin ? { origin } : {}),
  };
}

export function snapshotFromPending(pending: PendingTreeUpdate): TreeSnapshot {
  return decodeTreeSnapshotJSON({ root: pending.candidate, objects: pending.objects });
}

export function updatesFromPending(pending: PendingTreeUpdate): CandidateUpdateJSON[] {
  const { base: _base, origin: _origin, successors: _successors, ...first } = pending;
  return [first, ...(pending.successors ?? [])];
}

/** Append a newer filesystem head behind an already-transmitted prefix. */
export function appendPendingTreeSuccessor(
  pending: PendingTreeUpdate,
  snapshot: TreeSnapshot,
): PendingTreeUpdate {
  // The complete graph is intentional: the successor derives from the prior
  // submitted candidate, which may not have been materialized after a merge.
  const successor = pendingFromSnapshot(null, snapshot);
  const { base: _base, origin: _origin, successors: _successors, ...update } = successor;
  return { ...pending, successors: [...(pending.successors ?? []), update] };
}

export function deltasFromPending(pending: PendingTreeUpdate): ObjectDelta[] {
  return decodeObjectDeltas(pending.deltas ?? []);
}

export function withDelta(pending: PendingTreeUpdate, delta: ObjectDelta): PendingTreeUpdate {
  return {
    ...pending,
    objects: pending.objects.filter((object) => object.hash !== delta.result),
    deltas: [...(pending.deltas ?? []).filter((existing) => existing.result !== delta.result), encodeObjectDeltaJSON(delta)],
  };
}

/** The draft the conflict describes, reconstructed by applying its transition to the candidate graph. */
export function snapshotFromConflictDraft(conflict: StoredTreeConflict, candidate: TreeSnapshot): TreeSnapshot {
  const draft = decodeUpdateConflictJSON(conflict).details.draft;
  return { root: draft.root, objects: applyTransitionPayload(candidate.objects, draft) };
}

export function pendingTreeUpdate(tree: string): Promise<PendingTreeUpdate | undefined> {
  return serialized(tree, async () => (await load(tree)).pending);
}

export function acceptedTreeObjects(tree: string): Promise<AcceptedTreeObjects | undefined> {
  return serialized(tree, async () => (await load(tree)).accepted);
}

/** Recent materialized request digests let reconnecting editor sessions recover their own fence. */
export function acceptedRequestDigests(tree: string): Promise<Hash[]> {
  return serialized(tree, async () => [...((await load(tree)).acceptedRequestDigests ?? [])]);
}

export function rememberAcceptedRequestDigests(tree: string, digests: readonly Hash[]): Promise<void> {
  if (!digests.length) return Promise.resolve();
  return serialized(tree, async () => {
    const state = await load(tree);
    const accepted = [...new Set([...(state.acceptedRequestDigests ?? []), ...digests])]
      .slice(-MAX_ACCEPTED_REQUEST_DIGESTS);
    await save(tree, { ...state, acceptedRequestDigests: accepted });
  });
}

/** Ordered, durable editor candidates that have not yet received an authority decision. */
export function pendingEditorAdmissions(tree: string): Promise<FrozenEditorAdmission[]> {
  return serialized(tree, async () => [...((await load(tree)).editorAdmissions ?? [])]);
}

/**
 * Build and append one durable generation while holding the tree journal lock.
 * The builder sees the exact preceding local order, so two simultaneous editor
 * requests cannot both fork the same pending head before either is persisted.
 */
export function appendPendingEditorAdmission(
  tree: string,
  build: (admissions: readonly FrozenEditorAdmission[]) => FrozenEditorAdmission,
): Promise<FrozenEditorAdmission> {
  return serialized(tree, async () => {
    const state = await load(tree);
    let admissions = [...(state.editorAdmissions ?? [])];
    const acknowledged = admissions.length > 0 && admissions.every((candidate) => candidate.acknowledged);
    const standalone = acknowledged ? build([]) : undefined;
    const startsNewEpoch = standalone !== undefined && admissions.every((candidate) => candidate.id !== standalone.id);
    let admission = startsNewEpoch ? standalone : build(admissions);
    if (startsNewEpoch) admissions = [];
    const existing = admissions.find((candidate) => candidate.id === admission.id && candidate.request.candidate === admission.request.candidate);
    if (existing) return existing;
    // Compaction before request preparation: a generation from the same
    // editor that no request has carried yet is replaced by this newer one,
    // so one candidate represents one intentional accepted-history boundary.
    // Anything transmitted is immutable and stays as the prefix.
    let unsent = admissions.length;
    while (unsent > 0) {
      const candidate = admissions[unsent - 1]!;
      if (candidate.transmitted || candidate.acknowledged || candidate.editorID !== admission.editorID || candidate.id !== admission.id) break;
      unsent -= 1;
    }
    if (unsent < admissions.length) {
      admissions = admissions.slice(0, unsent);
      admission = build(admissions);
    }
    admissions.push(admission);
    await save(tree, { ...state, editorAdmissions: admissions });
    return admission;
  });
}

/** Persist that a request carrying these elements is about to be sent; they can no longer be compacted. */
export function markEditorAdmissionsTransmitted(
  tree: string,
  id: string,
  candidates: readonly string[],
): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    const admissions = [...(state.editorAdmissions ?? [])];
    for (const candidate of candidates) {
      const index = admissions.findIndex((admission) => admission.id === id && admission.request.candidate === candidate);
      if (index >= 0) admissions[index] = { ...admissions[index]!, transmitted: true };
    }
    await save(tree, { ...state, editorAdmissions: admissions });
  });
}

/** Mark an accepted prefix but retain it so a later in-flight generation can repeat the same epoch prefix. */
export function acknowledgePendingEditorAdmissions(
  tree: string,
  id: string,
  candidates: readonly string[],
  accepted: readonly AcceptedUpdate[] = [],
): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    const admissions = [...(state.editorAdmissions ?? [])];
    for (const [decisionIndex, candidate] of candidates.entries()) {
      const index = admissions.findIndex((admission) => admission.id === id && admission.request.candidate === candidate);
      if (index >= 0) admissions[index] = {
        ...admissions[index]!,
        acknowledged: true,
        ...(accepted[decisionIndex] ? { accepted: accepted[decisionIndex] } : {}),
      };
    }
    await save(tree, { ...state, editorAdmissions: admissions });
  });
}

export function clearPendingEditorAdmissions(tree: string): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    delete state.editorAdmissions;
    await save(tree, state);
  });
}

/**
 * Retire one materialized acknowledged prefix without deleting a newer
 * admission that may have arrived while the authority response was in flight.
 */
export function retireAcknowledgedEditorAdmissions(
  tree: string,
  acknowledged: readonly Pick<FrozenEditorAdmission, "id" | "request">[],
): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    const keys = new Set(acknowledged.map((admission) => `${admission.id}:${admission.request.candidate}`));
    const remaining = (state.editorAdmissions ?? []).filter((admission) =>
      !admission.acknowledged || !keys.has(`${admission.id}:${admission.request.candidate}`)
    );
    if (remaining.length) state.editorAdmissions = remaining;
    else delete state.editorAdmissions;
    await save(tree, state);
  });
}

export async function saveAcceptedTreeObjects(tree: string, snapshot: TreeSnapshot): Promise<void> {
  await saveAcceptedTreeObjectHashes(tree, {
    root: snapshot.root,
    hashes: [...snapshot.objects.keys()],
  });
}

export function saveAcceptedTreeObjectHashes(
  tree: string,
  accepted: AcceptedTreeObjects,
): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    await save(tree, {
      ...state,
      accepted: { root: accepted.root, hashes: [...accepted.hashes].sort() },
    });
  });
}

export function treeConflict(tree: string): Promise<StoredTreeConflict | undefined> {
  return serialized(tree, async () => (await load(tree)).conflict);
}

export function treeConflictMaterial(tree: string): Promise<{ identity: string; material: TreeConflictMaterial } | undefined> {
  return serialized(tree, async () => {
    const stored = (await load(tree)).conflictMaterial;
    if (!stored) return undefined;
    return {
      identity: stored.identity,
      material: {
        base: decodeTreeSnapshotJSON(stored.base),
        current: decodeTreeSnapshotJSON(stored.current),
        mine: decodeTreeSnapshotJSON(stored.mine),
        draft: decodeTreeSnapshotJSON(stored.draft),
      },
    };
  });
}

export function saveTreeConflictMaterial(tree: string, identity: string, material: TreeConflictMaterial): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    if (!state.conflict) throw new Error(`Cannot retain conflict material without a conflict: ${tree}`);
    await save(tree, {
      ...state,
      conflictMaterial: {
        identity,
        base: encodeTreeSnapshotJSON(material.base),
        current: encodeTreeSnapshotJSON(material.current),
        mine: encodeTreeSnapshotJSON(material.mine),
        draft: encodeTreeSnapshotJSON(material.draft),
      },
    });
  });
}

export function savePendingTreeUpdate(tree: string, pending: PendingTreeUpdate): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    await save(tree, { ...state, pending });
  });
}

export function clearPendingTreeUpdate(tree: string): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    delete state.pending;
    await save(tree, state);
  });
}

export function saveTreeConflict(tree: string, conflict: UpdateConflictResult): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    delete state.conflictMaterial;
    await save(tree, { ...state, conflict: encodeUpdateConflictJSON(conflict) });
  });
}

export function clearTreeConflict(tree: string): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    delete state.conflict;
    delete state.conflictMaterial;
    await save(tree, state);
  });
}
