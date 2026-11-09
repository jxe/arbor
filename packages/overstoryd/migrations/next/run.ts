import { runBatch, type BatchReport } from "../tools/batch.ts";
import { deviceClients } from "./steps/033-device-clients.ts";

/**
 * The pending batch: schema 32 to 33 through step 033, run once against the
 * live data root at cutover. README.md lists the steps and the product
 * changes they bring. The cutover commit adds the product's schema checks as
 * `finish`.
 */
export const steps = [deviceClients];

export function migrateNextBatch(dataRoot: string): BatchReport {
  return runBatch(dataRoot, steps);
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) throw new Error("usage: run.ts <data-root>");
  console.log(JSON.stringify(migrateNextBatch(dataRoot), null, 2));
}
