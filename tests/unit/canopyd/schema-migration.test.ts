import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CANOPY_SCHEMA_VERSION, CanopyDaemon, SchemaMismatchError } from "@overstory/canopyd";

const roots: string[] = [];
const bootstrap = {
  handle: "community",
  name: "Community",
  accounts: [{ handle: "owner", token: "test-token", communityWriter: true }],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arbor-canopy-schema-"));
  roots.push(root);
  return root;
}

function columns(database: string, table: string): string[] {
  const db = new Database(database, { readonly: true });
  try { return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name); }
  finally { db.close(); }
}

describe("Canopy schema version stamp", () => {
  test("stamps a new database, omits profile-kind columns, and reopens cleanly", async () => {
    const root = await dataRoot();
    const database = join(root, "canopy.sqlite3");
    const first = await CanopyDaemon.open(root, bootstrap);
    await first[Symbol.asyncDispose]();

    const db = new Database(database, { readonly: true });
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: CANOPY_SCHEMA_VERSION });
    db.close();
    expect(columns(database, "boundaries")).toEqual(["path", "tree_id", "parent_tree"]);
    expect(columns(database, "tree_reservations")).toEqual(["id", "account_id", "canonical_path"]);
    expect(columns(database, "trees")).toEqual(["id", "ref", "policy", "status", "account_id"]);
    expect(columns(database, "account_challenges")).toEqual(["id", "challenge_json", "expires_at", "consumed_at"]);
    expect(columns(database, "accepted_updates")).toEqual([
      "ordinal", "tree_id", "root", "previous_ordinal", "conflicted", "accepted_at", "subject", "request_digest", "change_id", "entry",
    ]);
    expect(columns(database, "entry_metadata")).toEqual(["tree_id", "path", "modified_at"]);
    for (const table of ["reflog", "observations", "authored_changes", "accepted_conflicts", "accepted_merge_states"]) expect(columns(database, table)).toEqual([]);

    const reopened = await CanopyDaemon.open(root);
    expect(reopened.community().kind).toBe("ordinary");
    expect(reopened.rootProfileType(reopened.community().ref)).toBe("group");
    await reopened[Symbol.asyncDispose]();
  });

  test("refuses a database written before the stamp existed", async () => {
    const root = await dataRoot();
    const db = new Database(join(root, "canopy.sqlite3"), { create: true });
    db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.run("CREATE TABLE boundaries (path TEXT PRIMARY KEY, tree_id TEXT NOT NULL UNIQUE REFERENCES trees(id), parent_tree TEXT, kind TEXT NOT NULL)");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    await expect(CanopyDaemon.open(root, bootstrap)).rejects.toThrow(/schema version \(unstamped\).*run the offline migration/);
    // The refused database is left untouched for the operator's migration tool.
    expect(columns(join(root, "canopy.sqlite3"), "boundaries")).toEqual(["path", "tree_id", "parent_tree", "kind"]);
  });

  test("schema 20 is current: a schema-19 root is refused and points at the offline migration", async () => {
    expect(CANOPY_SCHEMA_VERSION).toBe("20");
    const root = await dataRoot();
    const first = await CanopyDaemon.open(root, bootstrap);
    await first[Symbol.asyncDispose]();
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("UPDATE meta SET value = '19' WHERE key = 'schema_version'");
    db.close();
    await expect(CanopyDaemon.open(root)).rejects.toThrow(/schema version 19 but this build requires 20.*run the offline migration/);
  });

  test("refuses a database stamped with a different version", async () => {
    const root = await dataRoot();
    const first = await CanopyDaemon.open(root, bootstrap);
    await first[Symbol.asyncDispose]();
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("UPDATE meta SET value = 'future' WHERE key = 'schema_version'");
    db.close();
    await expect(CanopyDaemon.open(root)).rejects.toThrow(/schema version future.*run the offline migration/);
    // The command line enters maintenance mode on this type, not on message text.
    await expect(CanopyDaemon.open(root)).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  test("a table that differs from the stamp is a schema mismatch", async () => {
    const root = await dataRoot();
    const first = await CanopyDaemon.open(root, bootstrap);
    await first[Symbol.asyncDispose]();
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("ALTER TABLE meta ADD COLUMN note TEXT");
    db.close();
    await expect(CanopyDaemon.open(root)).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  test("startup reads only the schema; the integrity audit checks the rows", async () => {
    const root = await dataRoot();
    const first = await CanopyDaemon.open(root, bootstrap);
    await first.verifyIntegrity();
    await first[Symbol.asyncDispose]();
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("INSERT INTO trees (id, ref) VALUES ('tr_orphan', ?)", [`sha256:${"0".repeat(64)}`]);
    db.close();
    const reopened = await CanopyDaemon.open(root);
    try {
      await expect(reopened.verifyIntegrity()).rejects.toThrow(/trees without accepted history/);
    } finally {
      await reopened[Symbol.asyncDispose]();
    }
  });
});
