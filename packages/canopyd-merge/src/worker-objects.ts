import { access } from "node:fs/promises";
import { ObjectStore } from "@overstory/object-store";
import type { MergeObjects } from "./index.ts";

/** Whether `store` already holds `hash`, without reading or hashing it.
 * Presence only: whoever later reads the object still hash-checks it. */
export async function holdsObject(store: ObjectStore, hash: string): Promise<boolean> {
  try {
    await access(store.path(hash));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The values `store` lacks, checked 64 at a time. */
export async function absentFrom<T extends { hash: string }>(store: ObjectStore, values: Iterable<T>): Promise<T[]> {
  const all = [...values], missing: T[] = [];
  for (let i = 0; i < all.length; i += 64) {
    const slice = all.slice(i, i + 64);
    const present = await Promise.all(slice.map((value) => holdsObject(store, value.hash)));
    missing.push(...slice.filter((_, index) => !present[index]));
  }
  return missing;
}

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
