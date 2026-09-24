import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { arborPrivateRoot } from "@overstory/protocol";

/** Durable state from the earlier folder synchronizer still holds work this daemon no longer runs. */
export class EarlierSyncStateError extends Error {
  constructor(readonly tree: string, readonly path: string) {
    super(`${path} holds unpublished work or a conflict from an earlier Arbor Sync. Finish it with that version, then update.`);
    this.name = "EarlierSyncStateError";
  }
}

/**
 * The earlier synchronizer kept one `sync/<tree>.json` per tree: a pending
 * request, a conflict and its review material, and the accepted object list.
 * A file with pending work or a conflict is refused and never rewritten; a
 * clean one is removed, because the folder's change log replaces it.
 */
export async function retireEarlierSyncState(tree: string): Promise<void> {
  const path = join(arborPrivateRoot(), "sync", `${Buffer.from(tree).toString("base64url")}.json`);
  let state: { pending?: unknown; conflict?: unknown; conflictMaterial?: unknown };
  try { state = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (state.pending || state.conflict || state.conflictMaterial) throw new EarlierSyncStateError(tree, path);
  await rm(path, { force: true });
}
