import { runBatch, type BatchReport } from "../tools/batch.ts";
import { profileLocatorPins } from "./steps/028-profile-locator-pins.ts";

/**
 * The next migration batch: every schema step ready since the last cutover,
 * run once against the live data root. Steps are added here in schema order;
 * see README.md for the list, the product changes each one brings at
 * cutover, and the runbook.
 */
export const steps = [profileLocatorPins];

export function migrateNextBatch(dataRoot: string): BatchReport {
  // At cutover, pass `(db) => { assertCurrentHostSchema(db); assertHostData(db); }`
  // from packages/canopyd/src/schema.ts, once the product serves the new schema.
  return runBatch(dataRoot, steps);
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) throw new Error("usage: run.ts <data-root>");
  console.log(JSON.stringify(migrateNextBatch(dataRoot), null, 2));
}
