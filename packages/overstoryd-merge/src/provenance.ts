import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HashPointers } from "@ovst/object-store";
import { readProvenance, type ObjectHash, type ProvenanceNode } from "@ovst/protocol";

/** Where the sidecar reads entries' provenance indexes
 * (docs/architecture/overstoryd/provenance-index.md). */
export interface ProvenanceIndexes {
  /** An entry's index; null when it has none or it cannot be read. */
  index(entry: string): Promise<ProvenanceNode | null>;
}

const HASH = /^sha256:[a-f0-9]{64}$/;

/** Indexes whose pointers are under `directory` (`<data>/provenance`): a row
 * in `v1/pointers.sqlite3`, else (entries indexed before 2026-11-02) a
 * pointer file, and whose records `read` finds. */
export function provenanceIn(directory: string, read: (hash: string) => Promise<Uint8Array | null>): ProvenanceIndexes {
  let pointers: HashPointers | undefined;
  const rows = () => {
    const path = join(directory, "v1", "pointers.sqlite3");
    if (!pointers && existsSync(path)) pointers = new HashPointers(path);
    return pointers;
  };
  return {
    async index(entry) {
      if (!HASH.test(entry)) return null;
      try {
        const root = rows()?.get(entry) ?? (await readFile(join(directory, "v1", entry.slice(7, 9), entry.slice(9)), "utf8")).trim();
        if (!HASH.test(root)) return null;
        return await readProvenance(root as ObjectHash, async (hash) => {
          const bytes = await read(hash);
          if (!bytes) throw new Error(`Missing provenance record ${hash}`);
          return bytes;
        });
      } catch {
        return null;
      }
    },
  };
}
