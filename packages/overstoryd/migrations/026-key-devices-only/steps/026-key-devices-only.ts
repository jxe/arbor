import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 25 → 26: every device is a key device (Security 006), so `devices`
 * loses `token_digest`. A device revoked while it still had a credential keeps
 * its row, with no key, so its DeviceID is never reused; any other device must
 * have a key, and the step refuses, changing nothing, while one does not:
 * deauthorize it first.
 * `device_sessions` names devices by ID, which the rebuilt table keeps.
 */
export const keyDevicesOnly: MigrationStep = {
  from: 25,
  name: "026-key-devices-only",
  run(db) {
    const keyless = (db.query("SELECT COUNT(*) AS n FROM devices WHERE public_key IS NULL AND revoked_at IS NULL").get() as { n: number }).n;
    if (keyless) throw new Error(`${keyless} unrevoked device(s) have no key; deauthorize them before migrating`);
    db.run(`
      CREATE TABLE devices_next (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        label TEXT NOT NULL,
        public_key TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        CHECK (public_key IS NOT NULL OR revoked_at IS NOT NULL)
      )
    `);
    db.run(`
      INSERT INTO devices_next (id, account_id, label, public_key, created_at, last_used_at, revoked_at)
      SELECT id, account_id, label, public_key, created_at, last_used_at, revoked_at FROM devices
    `);
    db.run("DROP TABLE devices");
    db.run("ALTER TABLE devices_next RENAME TO devices");
  },
  verify(db) {
    const columns = (db.query("PRAGMA table_info(devices)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (columns.includes("token_digest")) throw new Error("devices kept token_digest");
    const keyless = (db.query("SELECT COUNT(*) AS n FROM devices WHERE public_key IS NULL AND revoked_at IS NULL").get() as { n: number }).n;
    if (keyless) throw new Error("An unrevoked device has no key");
  },
};
