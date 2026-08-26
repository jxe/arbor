import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arborPrivateRoot, prepareArborDataRoot } from "@arbor/stores";
import type { FilePatch, ObjectHash, TreeSnapshot, UpdateConflictResult } from "@arbor/wire";

interface StoredObject {
  hash: ObjectHash;
  bytes: string;
}

interface StoredFilePatch {
  base: ObjectHash;
  result: ObjectHash;
  edits: Array<{ offset: number; length: number; bytes: string }>;
}

export interface PendingTreeUpdate {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: StoredObject[];
  filePatches?: StoredFilePatch[];
}

export interface AcceptedTreeObjects {
  root: ObjectHash;
  hashes: ObjectHash[];
}

export interface StoredTreeConflict extends Omit<UpdateConflictResult["details"], "draft" | "currentSnapshot"> {
  error: "conflict";
  message: string;
  retryable: false;
  tree?: string;
  draft: { root: ObjectHash; objects: StoredObject[] };
}

interface TreeSyncState {
  pending?: PendingTreeUpdate;
  conflict?: StoredTreeConflict;
  accepted?: AcceptedTreeObjects;
}

function safeTreeID(tree: string): string {
  return Buffer.from(tree).toString("base64url");
}

function pathFor(tree: string): string {
  return join(arborPrivateRoot(), "sync", `${safeTreeID(tree)}.json`);
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
  if (!state.pending && !state.conflict && !state.accepted) {
    await rm(destination, { force: true });
    return;
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600).catch(() => {});
}

export function pendingFromSnapshot(
  base: { root: ObjectHash; update: string },
  snapshot: TreeSnapshot,
  retained: ReadonlySet<ObjectHash> = new Set(),
): PendingTreeUpdate {
  return {
    base,
    candidate: snapshot.root,
    objects: [...snapshot.objects]
      .filter(([hash]) => !retained.has(hash))
      .map(([hash, bytes]) => ({ hash, bytes: Buffer.from(bytes).toString("base64") })),
  };
}

export function snapshotFromPending(pending: PendingTreeUpdate): TreeSnapshot {
  return {
    root: pending.candidate,
    objects: new Map(pending.objects.map(({ hash, bytes }) => [hash, new Uint8Array(Buffer.from(bytes, "base64"))])),
  };
}

export function filePatchesFromPending(pending: PendingTreeUpdate): FilePatch[] | undefined {
  return pending.filePatches?.map((patch) => ({
    base: patch.base,
    result: patch.result,
    edits: patch.edits.map((edit) => ({
      offset: edit.offset,
      length: edit.length,
      bytes: new Uint8Array(Buffer.from(edit.bytes, "base64")),
    })),
  }));
}

export function withFilePatch(pending: PendingTreeUpdate, patch: FilePatch): PendingTreeUpdate {
  return {
    ...pending,
    objects: pending.objects.filter((object) => object.hash !== patch.result),
    filePatches: [{
      base: patch.base,
      result: patch.result,
      edits: patch.edits.map((edit) => ({
        offset: edit.offset,
        length: edit.length,
        bytes: Buffer.from(edit.bytes).toString("base64"),
      })),
    }],
  };
}

export function snapshotFromConflictDraft(conflict: StoredTreeConflict): TreeSnapshot {
  return {
    root: conflict.draft.root,
    objects: new Map(conflict.draft.objects.map(({ hash, bytes }) => [hash, new Uint8Array(Buffer.from(bytes, "base64"))])),
  };
}

export async function pendingTreeUpdate(tree: string): Promise<PendingTreeUpdate | undefined> {
  return (await load(tree)).pending;
}

export async function acceptedTreeObjects(tree: string): Promise<AcceptedTreeObjects | undefined> {
  return (await load(tree)).accepted;
}

export async function saveAcceptedTreeObjects(tree: string, snapshot: TreeSnapshot): Promise<void> {
  await saveAcceptedTreeObjectHashes(tree, {
    root: snapshot.root,
    hashes: [...snapshot.objects.keys()],
  });
}

export async function saveAcceptedTreeObjectHashes(
  tree: string,
  accepted: AcceptedTreeObjects,
): Promise<void> {
  const state = await load(tree);
  await save(tree, {
    ...state,
    accepted: { root: accepted.root, hashes: [...accepted.hashes].sort() },
  });
}

export async function treeConflict(tree: string): Promise<StoredTreeConflict | undefined> {
  return (await load(tree)).conflict;
}

export async function savePendingTreeUpdate(tree: string, pending: PendingTreeUpdate): Promise<void> {
  const state = await load(tree);
  await save(tree, { ...state, pending });
}

export async function clearPendingTreeUpdate(tree: string): Promise<void> {
  const state = await load(tree);
  delete state.pending;
  await save(tree, state);
}

export async function saveTreeConflict(tree: string, conflict: UpdateConflictResult): Promise<void> {
  const state = await load(tree);
  await save(tree, {
    ...state,
    conflict: {
      error: conflict.error,
      message: conflict.message,
      retryable: conflict.retryable,
      ...(conflict.tree ? { tree: conflict.tree } : {}),
      kind: conflict.details.kind,
      current: conflict.details.current,
      base: conflict.details.base,
      candidate: conflict.details.candidate,
      conflicts: conflict.details.conflicts,
      draft: {
        root: conflict.details.draft.root,
        objects: conflict.details.draft.objects.map(({ hash, bytes }) => ({ hash, bytes: Buffer.from(bytes).toString("base64") })),
      },
    },
  });
}

export async function clearTreeConflict(tree: string): Promise<void> {
  const state = await load(tree);
  delete state.conflict;
  await save(tree, state);
}
