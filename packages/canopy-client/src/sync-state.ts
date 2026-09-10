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
  /** Retained for state files written by the deleted editor path; never set by the daemon now. */
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
    // Older state files carry keys the deleted editor path wrote
    // (`editorAdmissions`, `acceptedRequestDigests`); only the known keys are
    // read, and the next save drops the rest.
    const stored = JSON.parse(await readFile(pathFor(tree), "utf8")) as TreeSyncState;
    const { pending, conflict, conflictMaterial, accepted } = stored;
    return {
      ...(pending ? { pending } : {}),
      ...(conflict ? { conflict } : {}),
      ...(conflictMaterial ? { conflictMaterial } : {}),
      ...(accepted ? { accepted } : {}),
    };
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
