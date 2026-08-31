import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanopyDaemon } from "@arbor/canopy";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Canopy database migration", () => {
  test("upgrades a deployed Canopy database", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-canopy-schema-"));
    roots.push(root);
    const database = join(root, "canopy.sqlite3");
    const db = new Database(database, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA wal_autocheckpoint=0");
    db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.run("CREATE TABLE boundaries (path TEXT PRIMARY KEY, tree_id TEXT NOT NULL UNIQUE REFERENCES trees(id), parent_tree TEXT, kind TEXT NOT NULL)");
    db.run("CREATE TABLE reflog (tree_id TEXT NOT NULL, ref TEXT NOT NULL, previous_ref TEXT, changed_at INTEGER NOT NULL)");
    db.run(`CREATE TABLE accepted_updates (
      id TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL REFERENCES trees(id),
      root TEXT NOT NULL,
      previous_root TEXT,
      kind TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      subject TEXT,
      base_root TEXT,
      candidate_root TEXT,
      remote_root TEXT,
      merge_summary TEXT,
      request_digest TEXT
    )`);
    db.run(`CREATE UNIQUE INDEX accepted_updates_request
      ON accepted_updates(tree_id, subject, request_digest)
      WHERE request_digest IS NOT NULL`);
    db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, profile_tree TEXT, token_digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1)");
    db.run("CREATE TABLE devices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), label TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)");
    db.run("CREATE TABLE pairings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), secret_digest TEXT NOT NULL, confirmation_code TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claimed_at INTEGER)");
    db.run("CREATE TABLE access (id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id), subject_kind TEXT NOT NULL, subject TEXT NOT NULL, access TEXT NOT NULL, claimed_profile TEXT, UNIQUE(tree_id, subject_kind, subject))");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    expect(await stat(`${database}-wal`).then(({ size }) => size > 0).catch(() => false)).toBe(true);

    const canopy = await CanopyDaemon.open(root, {
      handle: "community",
      name: "Community",
      accounts: [{ handle: "owner", token: "test-token", communityWriter: true }],
    });
    await canopy[Symbol.asyncDispose]();
    db.close();

    expect(await stat(database).then(() => true).catch(() => false)).toBe(true);
    const migrated = new Database(database, { readonly: true });
    const columns = (table: string) => (migrated.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns("accounts")).toEqual([
      "id", "handle", "profile_tree", "token_digest", "enabled", "config_tree", "claim_digest",
    ]);
    expect(columns("trees")).toEqual(["id", "ref", "updated_at", "policy", "status", "account_id"]);
    expect(columns("pairings")).toEqual([
      "id", "account_id", "secret_digest", "confirmation_code", "created_at", "expires_at", "claimed_at", "claimed_device",
    ]);
    expect(columns("accepted_updates")).toEqual([
      "id", "tree_id", "root", "previous_root", "kind", "accepted_at", "subject", "base_root",
      "candidate_root", "remote_root", "merge_summary", "request_digest", "sequence", "transition_json",
    ]);
    expect(migrated.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    migrated.close();
  });

});
