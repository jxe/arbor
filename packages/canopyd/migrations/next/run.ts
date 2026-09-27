import { assertCurrentHostSchema, assertHostData } from "../../src/schema.ts";
import { runBatch, type BatchReport } from "../tools/batch.ts";
import { placementAccounts } from "./steps/027-placement-accounts.ts";

/**
 * The next batch: schema 26 to 27 through step 027, run once against the
 * live data root. README.md lists the steps, the product change each brings,
 * and the runbook.
 */
export const steps = [placementAccounts];

export function migrateNextBatch(dataRoot: string): BatchReport {
  return runBatch(dataRoot, steps, (db) => {
    assertCurrentHostSchema(db);
    assertHostData(db);
  });
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) throw new Error("usage: run.ts <data-root>");
  console.log(JSON.stringify(migrateNextBatch(dataRoot), null, 2));
}
