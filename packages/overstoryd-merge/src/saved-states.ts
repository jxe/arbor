import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointStore } from "./checkpoint-store.ts";
import type { SavedCheckpoint, SavedStates } from "./sidecar.ts";

const TREE = /^[A-Za-z0-9_-]{1,128}$/;
const ENTRY = /^sha256:([a-f0-9]{64})$/;

/** Shared private checkpoints in SQLite, with read compatibility for legacy
 * `<directory>/<tree>/<entry digest>.json` snapshots. */
export function savedStatesIn(directory: string): SavedStates {
  let records: CheckpointStore | undefined;
  let unavailable = false;
  const store = () => {
    if (unavailable) return undefined;
    try { return records ??= new CheckpointStore(directory); }
    catch (error) {
      unavailable = true;
      process.stderr.write(`Private checkpoint database unavailable; using legacy cache: ${String(error)}\n`);
      return undefined;
    }
  };
  const file = (tree: string, entry: string) => {
    const digest = ENTRY.exec(entry)?.[1];
    if (!TREE.test(tree) || !digest) throw new Error("Invalid saved state name");
    return join(directory, tree, `${digest}.json`);
  };
  return {
    async list() {
      let out: Array<{ tree: string; entry: string; savedAt: number }> = [];
      try { out = store()?.list() ?? []; }
      catch (error) {
        unavailable = true;
        process.stderr.write(`Private checkpoint index unavailable; replaying legacy cache: ${String(error)}\n`);
      }
      const trees = await readdir(directory).catch(() => [] as string[]);
      for (const tree of trees.filter((name) => TREE.test(name)))
        for (const name of await readdir(join(directory, tree)).catch(() => [] as string[])) {
          const digest = /^([a-f0-9]{64})\.json$/.exec(name)?.[1];
          if (!digest) continue;
          const info = await stat(join(directory, tree, name)).catch(() => null);
          if (info && !out.some((value) => value.tree === tree && value.entry === `sha256:${digest}`)) out.push({ tree, entry: `sha256:${digest}`, savedAt: info.mtimeMs });
        }
      return out;
    },
    read: (tree, entry) => readFile(file(tree, entry)).then((bytes) => new Uint8Array(bytes), () => null),
    async write(tree, entry, bytes) {
      const path = file(tree, entry), temporary = `${path}.${process.pid}.tmp`;
      await mkdir(join(directory, tree), { recursive: true });
      await writeFile(temporary, bytes);
      await rename(temporary, path);
    },
    async remove(tree, entry) {
      store()?.remove(tree, entry);
      await rm(file(tree, entry), { force: true });
    },
    readCheckpoint: async (tree, entry) => store()?.read(tree, entry) ?? null,
    get writeCheckpoint() {
      const cache = store();
      if (!cache) return undefined;
      return async (checkpoint: SavedCheckpoint) => {
        cache.write(checkpoint);
        // Once the replacement commits, its expanded legacy duplicate is
        // disposable. Other legacy checkpoints remain readable.
        await rm(file(checkpoint.tree, checkpoint.entry), { force: true });
      };
    },
  };
}
