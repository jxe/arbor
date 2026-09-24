import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "./updates/store.ts";

/**
 * Stamped into `meta.schema_version` when the database is created. A stored
 * value that differs from this constant means the data root was written by an
 * incompatible build; the operator runs the offline migration tool after backing up retained
 * history. The migration sets the stamp.
 */
export const CANOPY_SCHEMA_VERSION = "20";

export const AUTHORITY_SCHEMA = {
  trees: ["id", "ref", "policy", "status", "account_id"],
  boundaries: ["path", "tree_id", "parent_tree"],
  accepted_updates: [
    "ordinal", "tree_id", "root", "previous_ordinal", "conflicted", "accepted_at", "subject", "request_digest", "change_id", "entry",
  ],
  accounts: ["id", "handle", "profile_tree", "config_tree", "enabled", "claim_digest"],
  devices: ["id", "account_id", "label", "token_digest", "created_at", "last_used_at", "revoked_at"],
  pairings: ["id", "account_id", "secret_digest", "confirmation_code", "created_at", "expires_at", "claimed_at", "claimed_device"],
  account_challenges: ["id", "challenge_json", "expires_at", "consumed_at"],
  resource_policy: ["account_id", "tree_id", "rules_json"],
  access: ["id", "tree_id", "subject_kind", "subject", "access"],
  tree_reservations: ["id", "account_id", "canonical_path"],
  entry_metadata: ["tree_id", "path", "modified_at"],
  document_versions: ["tree_id", "stable_key", "update_id", "entry_path", "content_hash", "accepted_at"],
  meta: ["key", "value"],
} as const;

/** The access table alone, under another name while an offline migration rebuilds it. */
export function createAccessTable(db: Database, name = "access"): void {
  db.run(`
    CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL REFERENCES trees(id),
      subject_kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      access TEXT NOT NULL,
      UNIQUE(tree_id, subject_kind, subject)
    )
  `);
}

export function createHostSchema(db: Database): void {
  db.run(`CREATE TABLE resource_policy (account_id TEXT NOT NULL, tree_id TEXT NOT NULL, rules_json TEXT NOT NULL, PRIMARY KEY(account_id, tree_id))`);
  db.run(`
    CREATE TABLE trees (
      id TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
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
  AcceptedUpdateStore.createSchema(db);
  db.run(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      profile_tree TEXT,
      config_tree TEXT,
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
    CREATE TABLE account_challenges (
      id TEXT PRIMARY KEY,
      challenge_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE tree_reservations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      canonical_path TEXT NOT NULL UNIQUE
    )
  `);
  createAccessTable(db);
  db.run(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [CANOPY_SCHEMA_VERSION]);
}

/** A data root whose schema this build does not serve: another stamp, or
 * tables and indexes that differ from the stamp's. canopyd leaves it
 * untouched, and the command line serves maintenance mode until an operator
 * migrates it. */
export class SchemaMismatchError extends Error {
  override readonly name = "SchemaMismatchError";
}

/** Refuse a data root written by a different schema version before touching it. */
export function assertHostSchemaVersion(db: Database): void {
  const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const stamp = hasMeta
    ? (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)?.value ?? null
    : null;
  if (stamp !== CANOPY_SCHEMA_VERSION) {
    throw new SchemaMismatchError(
      `Canopy data root was written by schema version ${stamp ?? "(unstamped)"} but this build requires ${CANOPY_SCHEMA_VERSION}: `
      + "run the offline migration for this version after backing up retained history",
    );
  }
}

/**
 * The startup check: the version stamp, then every table's columns and the
 * indexes queries rely on. It reads only the schema, never the rows, so it
 * stays cheap on a large data root; `assertHostData` checks the rows.
 */
export function assertCurrentHostSchema(db: Database): void {
  assertHostSchemaVersion(db);
  const issues: string[] = [];
  for (const [table, expected] of Object.entries(AUTHORITY_SCHEMA)) {
    const actual = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    // Queries name every column; reject missing or extra columns, not storage order.
    if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
      issues.push(`${table} columns`);
    }
  }
  for (const index of ["accepted_updates_request", "accepted_updates_change", "accepted_updates_tree", "accepted_updates_root", "document_versions_key"]) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) {
      issues.push(`missing ${index} index`);
    }
  }
  if (issues.length) {
    throw new SchemaMismatchError(`Canopy schema requires the one-time migration before startup: ${issues.join(", ")}`);
  }
}

/**
 * Row invariants every current data root keeps: each tree has accepted
 * history, each account a device, and no foreign key dangles. These scan
 * whole tables, so the integrity audit runs them rather than every start.
 */
export function assertHostData(db: Database): void {
  const issues: string[] = [];
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
  if (issues.length) throw new Error(`Canopy data integrity check failed: ${issues.join(", ")}`);
}

/** Open (creating and stamping if new, otherwise asserting) the Canopy SQLite database at `path`. */
export function openHostDatabase(path: string): Database {
  const databaseExists = existsSync(path);
  const db = new Database(path, { create: true });
  try {
    if (databaseExists) assertCurrentHostSchema(db);
    else db.transaction(() => createHostSchema(db))();
  } catch (error) {
    db.close();
    throw error;
  }
  db.run("PRAGMA journal_mode = WAL");
  // WAL with NORMAL syncs at checkpoints rather than on every commit: a process
  // crash loses nothing, an OS crash can lose the last commits but never
  // corrupts. Objects are fsynced before the commit that names them, so a
  // lost commit leaves only unreferenced objects.
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}
