import { ObjectStore } from "@arbor/object-store";
import { hashObject } from "@arbor/wire";
import type { MergeObjects } from "./index.ts";

/** The worker owns scratch output only; Canopy owns durable publication. */
export function workerObjects(
  shared: ObjectStore,
  staging: ObjectStore,
): MergeObjects {
  return {
    read: async (hash) =>
      (await shared.find(hash)) ?? (await staging.read(hash)),
    store: async (values) => {
      for (const value of values) {
        if (hashObject(value.bytes) !== value.hash)
          throw Error("Object hash mismatch");
        if (!(await shared.find(value.hash))) await staging.stage([value]);
      }
    },
  };
}
