import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcceptedUpdateStore, WireAuthority } from "@arbor/authority";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authority schema migration", () => {
  test("accepts the deployed schema after SQLite appends new columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-authority-schema-"));
    roots.push(root);
    const database = join(root, "authority.sqlite3");
    const db = new Database(database, { create: true });
    db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.run("CREATE TABLE boundaries (path TEXT PRIMARY KEY, tree_id TEXT NOT NULL UNIQUE REFERENCES trees(id), parent_tree TEXT, kind TEXT NOT NULL)");
    db.run("CREATE TABLE reflog (tree_id TEXT NOT NULL, ref TEXT NOT NULL, previous_ref TEXT, changed_at INTEGER NOT NULL)");
    AcceptedUpdateStore.createSchema(db);
    db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, profile_tree TEXT, token_digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1)");
    db.run("CREATE TABLE devices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), label TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)");
    db.run("CREATE TABLE pairings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), secret_digest TEXT NOT NULL, confirmation_code TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claimed_at INTEGER)");
    db.run("CREATE TABLE access (id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id), subject_kind TEXT NOT NULL, subject TEXT NOT NULL, access TEXT NOT NULL, claimed_profile TEXT, UNIQUE(tree_id, subject_kind, subject))");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();

    const authority = await WireAuthority.open(root, {
      handle: "community",
      name: "Community",
      accounts: [{ handle: "owner", token: "test-token", communityWriter: true }],
    });
    await authority[Symbol.asyncDispose]();

    const migrated = new Database(database, { readonly: true });
    const columns = (table: string) => (migrated.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns("accounts")).toEqual([
      "id", "handle", "profile_tree", "token_digest", "enabled", "config_tree", "claim_digest",
    ]);
    expect(columns("trees")).toEqual(["id", "ref", "updated_at", "policy", "status", "account_id"]);
    expect(columns("pairings")).toEqual([
      "id", "account_id", "secret_digest", "confirmation_code", "created_at", "expires_at", "claimed_at", "claimed_device",
    ]);
    expect(migrated.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    migrated.close();
  });
});
