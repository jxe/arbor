import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SavedStates } from "./sidecar.ts";

const TREE = /^[A-Za-z0-9_-]{1,128}$/;
const ENTRY = /^sha256:([a-f0-9]{64})$/;

/** Saved entry states as files: `<directory>/<tree>/<entry digest>.json`,
 * each written whole and renamed into place. */
export function savedStatesIn(directory: string): SavedStates {
  const file = (tree: string, entry: string) => {
    const digest = ENTRY.exec(entry)?.[1];
    if (!TREE.test(tree) || !digest) throw new Error("Invalid saved state name");
    return join(directory, tree, `${digest}.json`);
  };
  return {
    async list() {
      const out: Array<{ tree: string; entry: string; savedAt: number }> = [];
      const trees = await readdir(directory).catch(() => [] as string[]);
      for (const tree of trees.filter((name) => TREE.test(name)))
        for (const name of await readdir(join(directory, tree)).catch(() => [] as string[])) {
          const digest = /^([a-f0-9]{64})\.json$/.exec(name)?.[1];
          if (!digest) continue;
          const info = await stat(join(directory, tree, name)).catch(() => null);
          if (info) out.push({ tree, entry: `sha256:${digest}`, savedAt: info.mtimeMs });
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
    remove: (tree, entry) => rm(file(tree, entry), { force: true }),
  };
}
