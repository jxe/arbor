import { absentFrom, ObjectStore } from "@overstory/object-store";
export { absentFrom, holdsObject } from "@overstory/object-store";
import type { MergeObjects } from "./index.ts";

/** The worker owns scratch output only; Canopy owns durable publication. */
export function workerObjects(
  shared: ObjectStore,
  staging: ObjectStore,
): MergeObjects {
  return {
    read: async (hash) =>
      (await shared.find(hash)) ?? (await staging.read(hash)),
    // One staging publish, which hash-checks every value it writes.
    store: async (values) => staging.stage(await absentFrom(shared, values)),
  };
}
