import { assertCurrentHostSchema, assertHostData } from "../../src/schema.ts";
import { runBatch, type BatchReport } from "../tools/batch.ts";
import { profileLocatorPins } from "./steps/028-profile-locator-pins.ts";
import { dropTreeStatus } from "./steps/029-drop-tree-status.ts";

/**
 * Migration 029: schema 27 to 29 through steps 028 and 029, run once against
 * the live data root. README.md lists the steps, the product changes they
 * brought, and the runbook.
 */
export const steps = [profileLocatorPins, dropTreeStatus];

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
