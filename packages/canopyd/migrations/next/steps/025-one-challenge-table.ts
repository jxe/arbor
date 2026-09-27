import type { MigrationStep } from "../../tools/batch.ts";

const PURPOSES = { account_challenges: "account-claim", device_challenges: "device-session" } as const;

/**
 * Schema 24 → 25: `account_challenges` (account claims) and
 * `device_challenges` (device sessions) had identical columns, so they become
 * one `challenges` table whose `purpose` keeps them apart. Only unexpired,
 * unconsumed rows are copied: the rest can never be redeemed.
 */
export const oneChallengeTable: MigrationStep = {
  from: 24,
  name: "025-one-challenge-table",
  run(db) {
    db.run(`
      CREATE TABLE challenges (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('account-claim', 'device-session')),
        challenge_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      )
    `);
    const now = Date.now();
    for (const [table, purpose] of Object.entries(PURPOSES)) {
      db.run(
        `INSERT INTO challenges (id, purpose, challenge_json, expires_at)
         SELECT id, ?, challenge_json, expires_at FROM ${table} WHERE consumed_at IS NULL AND expires_at > ?`,
        [purpose, now],
      );
      db.run(`DROP TABLE ${table}`);
    }
  },
  verify(db) {
    for (const table of Object.keys(PURPOSES)) {
      if (db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)) throw new Error(`${table} survived the batch`);
    }
  },
};
