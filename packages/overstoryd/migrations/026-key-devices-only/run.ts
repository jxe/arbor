import { assertCurrentHostSchema, assertHostData } from "../../src/schema.ts";
import { runBatch, type BatchReport } from "../tools/batch.ts";
import { dropProfileResets } from "./steps/024-drop-profile-resets.ts";
import { oneChallengeTable } from "./steps/025-one-challenge-table.ts";
import { keyDevicesOnly } from "./steps/026-key-devices-only.ts";

/**
 * Migration 026, the first batch: schema 23 to 26 through steps 024–026,
 * run once against the live data root. README.md lists the steps, the
 * product change each brought, and the runbook.
 */
export const steps = [dropProfileResets, oneChallengeTable, keyDevicesOnly];

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
