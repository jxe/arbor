import { assertCurrentHostSchema, assertHostData } from "../../src/schema.ts";
import { runBatch, type BatchReport } from "../tools/batch.ts";
import { dropTreePolicy } from "./steps/030-drop-tree-policy.ts";
import { dropUnreadTimes } from "./steps/031-drop-unread-times.ts";
import { profileFactsUnversioned } from "./steps/032-profile-facts-unversioned.ts";

/**
 * Migration 032: schema 29 to 32 through steps 030, 031 and 032, run once
 * against the live data root. README.md lists the steps, the product changes
 * they brought, and the runbook.
 */
export const steps = [dropTreePolicy, dropUnreadTimes, profileFactsUnversioned];

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
