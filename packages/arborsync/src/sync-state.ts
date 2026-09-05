import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arborPrivateRoot, prepareArborDataRoot } from "@arbor/stores";
import {
  decodeObjectDeltas,
  decodeTreeSnapshotJSON,
  encodeObjectDeltaJSON,
  encodeObjectEnvelopes,
  encodeUpdateConflictJSON,
  type ObjectDelta,
  type ObjectHash,
  type TreeSnapshot,
  type UpdateConflictJSON,
  type UpdateConflictResult,
  type CandidateUpdateJSON,
  applyTransitionPayload,
  decodeUpdateConflictJSON,
} from "@arbor/wire";
import type { FrozenEditorAdmission } from "./editor-admission.ts";

/** The durable pending update is exactly the wire request body it will become. */
export type PendingTreeUpdate = CandidateUpdateJSON & { base: string | null };

export interface AcceptedTreeObjects {
  root: ObjectHash;
  hashes: ObjectHash[];
}

/** The durable conflict is the wire conflict body without the optional current snapshot. */
export type StoredTreeConflict = UpdateConflictJSON;

interface TreeSyncState {
  pending?: PendingTreeUpdate;
  conflict?: StoredTreeConflict;
  accepted?: AcceptedTreeObjects;
  editorAdmissions?: FrozenEditorAdmission[];
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
  if (!state.pending && !state.conflict && !state.accepted && !state.editorAdmissions?.length) {
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
): PendingTreeUpdate {
  return {
    base,
    candidate: snapshot.root,
    ifMatch: base === null ? "bytesHash" : "modelHash",
    objects: encodeObjectEnvelopes([...snapshot.objects].filter(([hash]) => !retained.has(hash))),
    deltas: [],
  };
}

export function snapshotFromPending(pending: PendingTreeUpdate): TreeSnapshot {
  return decodeTreeSnapshotJSON({ root: pending.candidate, objects: pending.objects });
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

/** Ordered, durable editor candidates that have not yet received an authority decision. */
export function pendingEditorAdmissions(tree: string): Promise<FrozenEditorAdmission[]> {
  return serialized(tree, async () => [...((await load(tree)).editorAdmissions ?? [])]);
}

/** Append one durable generation, retaining its exact semantic predecessors until the editor reanchors. */
export function savePendingEditorAdmission(tree: string, admission: FrozenEditorAdmission): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    let admissions = [...(state.editorAdmissions ?? [])];
    if (admissions.length && admissions.every((candidate) => candidate.acknowledged) && admissions.every((candidate) => candidate.id !== admission.id)) {
      admissions = [];
    }
    if (!admissions.some((candidate) => candidate.id === admission.id && candidate.request.candidate === admission.request.candidate)) {
      admissions.push(admission);
    }
    await save(tree, { ...state, editorAdmissions: admissions });
  });
}

/** Mark an accepted prefix but retain it so a later in-flight generation can repeat the same epoch prefix. */
export function acknowledgePendingEditorAdmissions(
  tree: string,
  id: string,
  candidates: readonly string[],
): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    const admissions = [...(state.editorAdmissions ?? [])];
    for (const candidate of candidates) {
      const index = admissions.findIndex((admission) => admission.id === id && admission.request.candidate === candidate);
      if (index >= 0) admissions[index] = { ...admissions[index]!, acknowledged: true };
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
    await save(tree, { ...state, conflict: encodeUpdateConflictJSON(conflict) });
  });
}

export function clearTreeConflict(tree: string): Promise<void> {
  return serialized(tree, async () => {
    const state = await load(tree);
    delete state.conflict;
    await save(tree, state);
  });
}
