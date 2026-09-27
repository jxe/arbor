import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";

/**
 * One schema step of a migration batch: `run` carries a data root from
 * schema `from` to `from + 1` inside the batch's transaction, and `verify`
 * checks what the step promises once the whole batch has run.
 */
export interface MigrationStep {
  from: number;
  name: string;
  run(db: Database): void;
  verify?(db: Database): void;
}

export interface BatchReport {
  migrated: boolean;
  from: number;
  to: number;
  steps: string[];
}

/**
 * Apply every pending step of `steps` (consecutive, in order) to a data root.
 * It refuses, changing nothing, unless the stamp is one the batch starts at or
 * passes through and `quick_check` passes; the steps and the final stamp commit
 * in one transaction, rolled back on a dangling foreign key. A data root
 * already at the batch's last schema reports `migrated: false`. `finish` runs
 * after the commit, for the product's own schema checks at cutover.
 */
export function runBatch(dataRoot: string, steps: readonly MigrationStep[], finish?: (db: Database) => void): BatchReport {
  if (!steps.length) throw new Error("The batch has no steps");
  steps.forEach((step, index) => {
    if (index && step.from !== steps[index - 1]!.from + 1) throw new Error(`Batch step ${step.name} does not follow the one before it`);
  });
  const first = steps[0]!.from, last = steps.at(-1)!.from + 1;
  const db = new Database(join(resolve(dataRoot), "canopy.sqlite3"));
  try {
    const stamp = Number((db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value);
    if (stamp === last) {
      finish?.(db);
      return { migrated: false, from: last, to: last, steps: [] };
    }
    if (!Number.isInteger(stamp) || stamp < first || stamp > last) {
      throw new Error(`This batch migrates schema ${first}–${last - 1} to ${last}, found ${Number.isNaN(stamp) ? "(unstamped)" : stamp}`);
    }
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`The data root fails quick_check: ${check.quick_check}`);
    const pending = steps.filter((step) => step.from >= stamp);
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      for (const step of pending) step.run(db);
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(last)]);
      if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("The batch would leave a dangling foreign key");
      for (const step of pending) step.verify?.(db);
    })();
    db.run("PRAGMA foreign_keys = ON");
    finish?.(db);
    return { migrated: true, from: stamp, to: last, steps: pending.map((step) => step.name) };
  } finally {
    db.close();
  }
}
