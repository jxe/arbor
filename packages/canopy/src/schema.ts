import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "./updates/store.ts";

/**
 * Stamped into `meta.schema_version` when the database is created. A stored
 * value that differs from this constant means the data root was written by an
 * incompatible build; the operator deletes it and re-bootstraps (or runs the
 * offline migration tool, which sets the stamp). "1" is the implicit stamp of
 * every database created before the profile-kind columns were removed.
 */
export const CANOPY_SCHEMA_VERSION = "5";

export const AUTHORITY_SCHEMA = {
  trees: ["id", "ref", "updated_at", "policy", "status", "account_id"],
  boundaries: ["path", "tree_id", "parent_tree"],
  reflog: ["tree_id", "ref", "previous_ref", "changed_at"],
  accepted_updates: [
    "id", "tree_id", "root", "previous_root", "kind", "accepted_at", "subject",
    "base_root", "candidate_root", "remote_root", "merge_summary", "request_digest", "transition_json",
  ],
  accounts: ["id", "handle", "profile_tree", "config_tree", "token_digest", "enabled", "claim_digest"],
  devices: ["id", "account_id", "label", "token_digest", "created_at", "last_used_at", "revoked_at"],
  pairings: ["id", "account_id", "secret_digest", "confirmation_code", "created_at", "expires_at", "claimed_at", "claimed_device"],
  access: ["id", "tree_id", "subject_kind", "subject", "access", "claimed_profile"],
  tree_reservations: ["id", "account_id", "canonical_path", "status", "error"],
  observations: ["ordinal", "cursor", "tree_id", "kind", "update_id", "change_json", "created_at"],
  meta: ["key", "value"],
} as const;

export function createCanopySchema(db: Database): void {
  db.run(`
    CREATE TABLE trees (
      id TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      policy TEXT NOT NULL DEFAULT 'ordinary',
      status TEXT NOT NULL DEFAULT 'active',
      account_id TEXT
    )
  `);
  db.run(`
    CREATE TABLE boundaries (
      path TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL UNIQUE REFERENCES trees(id),
      parent_tree TEXT
    )
  `);
  db.run(`
    CREATE TABLE reflog (
      tree_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      previous_ref TEXT,
      changed_at INTEGER NOT NULL
    )
  `);
  AcceptedUpdateStore.createSchema(db);
  db.run(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      profile_tree TEXT,
      config_tree TEXT,
      token_digest TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      claim_digest TEXT
    )
  `);
  db.run(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      label TEXT NOT NULL,
      token_digest TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE pairings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      secret_digest TEXT NOT NULL,
      confirmation_code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      claimed_device TEXT
    )
  `);
  db.run(`
    CREATE TABLE tree_reservations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      canonical_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      error TEXT
    )
  `);
  db.run(`
    CREATE TABLE access (
      id TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL REFERENCES trees(id),
      subject_kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      access TEXT NOT NULL,
      claimed_profile TEXT,
      UNIQUE(tree_id, subject_kind, subject)
    )
  `);
  db.run(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [CANOPY_SCHEMA_VERSION]);
}

/** Refuse a data root written by a different schema version before touching it. */
export function assertCanopySchemaVersion(db: Database): void {
  const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const stamp = hasMeta
    ? (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null
    : null;
  if (stamp !== CANOPY_SCHEMA_VERSION) {
    throw new Error(
      `Canopy data root was written by schema version ${stamp ?? "1 (unstamped)"} but this build requires ${CANOPY_SCHEMA_VERSION}: `
      + "run the migration for this version, or delete the Canopy data root and re-bootstrap",
    );
  }
}

export function assertCurrentCanopySchema(db: Database): void {
  assertCanopySchemaVersion(db);
  const issues: string[] = [];
  for (const [table, expected] of Object.entries(AUTHORITY_SCHEMA)) {
    const actual = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    // Queries name every column; reject missing or extra columns, not storage order.
    if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
      issues.push(`${table} columns`);
    }
  }
  for (const index of ["accepted_updates_request", "observations_tree_order"]) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) {
      issues.push(`missing ${index} index`);
    }
  }
  if (!issues.length) {
    const missingHistory = db.query(`
      SELECT COUNT(*) AS count FROM trees t
      WHERE NOT EXISTS (SELECT 1 FROM accepted_updates u WHERE u.tree_id = t.id)
    `).get() as { count: number };
    const missingDevices = db.query(`
      SELECT COUNT(*) AS count FROM accounts a
      WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.account_id = a.id)
    `).get() as { count: number };
    if (missingHistory.count) issues.push("trees without accepted history");
    if (missingDevices.count) issues.push("accounts without devices");
    if (db.query("PRAGMA foreign_key_check").all().length) issues.push("foreign-key violations");
  }
  if (issues.length) {
    throw new Error(`Canopy schema requires the one-time migration before startup: ${issues.join(", ")}`);
  }
}

/** Open (creating and stamping if new, otherwise asserting) the Canopy SQLite database at `path`. */
export function openCanopyDatabase(path: string): Database {
  const databaseExists = existsSync(path);
  const db = new Database(path, { create: true });
  try {
    if (databaseExists) {
      assertCanopySchemaVersion(db);
      assertCurrentCanopySchema(db);
    }
    else db.transaction(() => createCanopySchema(db))();
  } catch (error) {
    db.close();
    throw error;
  }
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}
