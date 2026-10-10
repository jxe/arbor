import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { assertCurrentHostSchema, assertHostData, createDeviceKeyTables, createDevicesTable } from "../../../../packages/canopyd/src/schema.ts";

/**
 * Schema 22 → 23: key devices beside credential digests (Security 006).
 *
 * `devices.token_digest` becomes nullable and `devices.public_key` is added,
 * with exactly one of them set; every existing device keeps its digest and
 * gets no key. `device_challenges`, `device_sessions` and `profile_resets`
 * are created empty. No configuration changes: an existing `devices.yaml`
 * already parses, and has no `key`.
 *
 * Order: stamp and `quick_check` → one transaction (the devices table
 * rebuilt, the new tables, stamp 23, `foreign_key_check`) → schema and row
 * checks. A rerun reports `migrated: false`.
 */
export async function migrateDeviceKeys(dataRoot: string): Promise<{ migrated: boolean; devices: number }> {
  const db = new Database(join(resolve(dataRoot), "canopy.sqlite3"));
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value;
    if (stamp === "23") {
      assertCurrentHostSchema(db);
      return { migrated: false, devices: count(db) };
    }
    if (stamp !== "22") throw new Error(`Migration 023 requires schema 22, found ${stamp ?? "(unstamped)"}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`The data root fails quick_check: ${check.quick_check}`);
    const before = db.query("SELECT id, account_id, label, token_digest, created_at, last_used_at, revoked_at FROM devices ORDER BY id").all();
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      db.run("ALTER TABLE devices RENAME TO devices_022");
      createDevicesTable(db);
      db.run(`
        INSERT INTO devices (id, account_id, label, token_digest, public_key, created_at, last_used_at, revoked_at)
        SELECT id, account_id, label, token_digest, NULL, created_at, last_used_at, revoked_at FROM devices_022
      `);
      db.run("DROP TABLE devices_022");
      createDeviceKeyTables(db);
      db.run("UPDATE meta SET value = '23' WHERE key = 'schema_version'");
      if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Migration 023 would leave a dangling foreign key");
      const after = db.query("SELECT id, account_id, label, token_digest, created_at, last_used_at, revoked_at FROM devices ORDER BY id").all();
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Migration 023 would change a device row");
    })();
    db.run("PRAGMA foreign_keys = ON");
    assertCurrentHostSchema(db);
    assertHostData(db);
    return { migrated: true, devices: before.length };
  } finally {
    db.close();
  }
}

function count(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
}

if (import.meta.main) {
  const dataRoot = process.argv[2];
  if (!dataRoot) throw new Error("usage: run.ts <data-root>");
  console.log(JSON.stringify(await migrateDeviceKeys(dataRoot), null, 2));
}
