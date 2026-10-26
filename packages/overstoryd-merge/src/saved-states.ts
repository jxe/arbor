import { CheckpointStore } from "./checkpoint-store.ts";
import type { SavedStates } from "./sidecar.ts";

/** Shared private checkpoints in SQLite. A database that cannot open or be
 * read is an empty cache, as a missing one is: entries are replayed. */
export function savedStatesIn(directory: string): SavedStates {
  let records: CheckpointStore | undefined;
  let unavailable = false;
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
