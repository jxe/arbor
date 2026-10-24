import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointStore } from "./checkpoint-store.ts";
import type { SavedStates } from "./sidecar.ts";

const TREE = /^[A-Za-z0-9_-]{1,128}$/;

/** Shared private checkpoints in SQLite. A database that cannot open or be
 * read is an empty cache, as a missing one is: entries are replayed. */
export function savedStatesIn(directory: string): SavedStates {
  let records: CheckpointStore | undefined;
  let unavailable = false;
  let swept: Promise<void> | undefined;
  const store = () => {
    if (unavailable) return undefined;
    try { return records ??= new CheckpointStore(directory); }
    catch (error) {
      unavailable = true;
      process.stderr.write(`Private checkpoint database unavailable; replaying instead: ${String(error)}\n`);
      return undefined;
    }
  };
  return {
    async list() {
      // `<tree>/` directories held whole-JSON saves before the database
      // (removed 2026-10-24, Performance 002); nothing reads them.
      await (swept ??= sweepTreeDirectories(directory));
      try { return store()?.list() ?? []; }
      catch (error) {
        unavailable = true;
        process.stderr.write(`Private checkpoint index unavailable; replaying instead: ${String(error)}\n`);
        return [];
      }
    },
    async remove(tree, entry) { store()?.remove(tree, entry); },
    readCheckpoint: async (tree, entry) => store()?.read(tree, entry) ?? null,
    async writeCheckpoint(checkpoint) { store()?.write(checkpoint); },
  };
}

async function sweepTreeDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory() && TREE.test(entry.name)) await rm(join(directory, entry.name), { recursive: true, force: true });
}
