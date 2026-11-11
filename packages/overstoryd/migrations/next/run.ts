import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBatch, type BatchReport } from "../tools/batch.ts";
import { assertCurrentHostSchema, assertHostData } from "../../src/schema.ts";
import { inventory } from "./inventory.ts";
import { planProtocol003, type Protocol003Report, type TreePlan } from "./protocol-003.ts";
import { deviceClients } from "./steps/033-device-clients.ts";
import { protocol003 } from "./steps/034-protocol-003.ts";

/**
 * The pending batch: schema 32 to 34, run once against the live data root at
 * cutover. README.md lists the steps and the product changes they bring.
 * Step 034 records what `planProtocol003` wrote to the object store first.
 */
export const steps = (plans: readonly TreePlan[] = []) => [deviceClients, protocol003(plans)];

/** Caches and records that name old roots or update ids; each rebuilds, or starts empty. */
const STALE = ["provenance", "materialized", "entry-times.sqlite3", "entry-times.sqlite3-wal", "entry-times.sqlite3-shm",
  "exec/mutation-receipts.sqlite3", "exec/mutation-receipts.sqlite3-wal", "exec/mutation-receipts.sqlite3-shm"];

/** The product's own checks, once the batch has committed. */
function finish(db: Database): void {
  assertCurrentHostSchema(db);
  assertHostData(db);
}

export interface NextBatchReport extends BatchReport {
  /** IDs shorter than the spec allows, listed before anything changes. */
  shortIds?: { trees: Array<{ id: string; namedBy: string[] }>; devices: Array<{ id: string; label: string; revoked: boolean }> };
  protocol003?: Protocol003Report;
  /** Each tree's new root, as `tools/verify.ts` reads a report. */
  trees?: Array<{ id: string; root: string }>;
}

export async function migrateNextBatch(dataRoot: string): Promise<NextBatchReport> {
  const root = resolve(dataRoot);
  const db = new Database(join(root, "overstoryd.sqlite3"), { readonly: true });
  const stamp = Number((db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value);
  db.close();
  // Anything but a schema this batch starts from is refused (or already done) before a plan writes objects.
  if (stamp !== 32 && stamp !== 33) return runBatch(root, steps(), finish);
  const found = await inventory(root);
  const shortIds = {
    trees: found.shortTrees,
    devices: found.shortDevices.map(({ id, label, revoked }) => ({ id, label, revoked })),
  };
  const { plans, report } = await planProtocol003(root);
  const batch = runBatch(root, steps(plans), finish);
  for (const path of STALE) await rm(join(root, path), { recursive: true, force: true });
  return { ...batch, shortIds, protocol003: report, trees: plans.map((plan) => ({ id: plan.tree, root: plan.root })) };
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) throw new Error("usage: run.ts <data-root>");
  console.log(JSON.stringify(await migrateNextBatch(dataRoot), null, 2));
}
