import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CANOPY_SCHEMA_VERSION, CanopyDaemon } from "@overstory/canopyd";

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
    expect(columns(database, "tree_reservations")).toEqual(["id", "account_id", "canonical_path", "status", "error"]);

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
    await expect(CanopyDaemon.open(root, bootstrap)).rejects.toThrow(/schema version 1 \(unstamped\).*run the offline migration/);
    // The refused database is left untouched for the operator's migration tool.
    expect(columns(join(root, "canopy.sqlite3"), "boundaries")).toEqual(["path", "tree_id", "parent_tree", "kind"]);
  });

  test("schema 15 is current: a schema-14 root is refused and points at the offline migration", async () => {
    expect(CANOPY_SCHEMA_VERSION).toBe("15");
    const root = await dataRoot();
    const first = await CanopyDaemon.open(root, bootstrap);
    await first[Symbol.asyncDispose]();
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("UPDATE meta SET value = '14' WHERE key = 'schema_version'");
    db.close();
    await expect(CanopyDaemon.open(root)).rejects.toThrow(/schema version 14 but this build requires 15.*run the offline migration/);
  });

  test("refuses a database stamped with a different version", async () => {
    const root = await dataRoot();
    const first = await CanopyDaemon.open(root, bootstrap);
    await first[Symbol.asyncDispose]();
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("UPDATE meta SET value = 'future' WHERE key = 'schema_version'");
    db.close();
    await expect(CanopyDaemon.open(root)).rejects.toThrow(/schema version future.*run the offline migration/);
  });
});

test("rejects a v1 account policy at the current schema without changing its row", async () => {
  const root = await dataRoot();
  const first = await CanopyDaemon.open(root, bootstrap);
  await first.ensureAccountConfigTrees("https://community.example");
  await first[Symbol.asyncDispose]();
  const path = join(root, "canopy.sqlite3");
  const db = new Database(path);
  db.run("UPDATE trees SET policy = 'account-config-v1' WHERE policy = 'account-config-v2'");
  const before = db.query("SELECT * FROM trees ORDER BY id").all();
  expect(before.some(row => (row as { policy: string }).policy === "account-config-v1")).toBe(true);
  db.close();
  await expect(CanopyDaemon.open(root)).rejects.toThrow("account-config-v1 requires offline migration");
  const after = new Database(path, { readonly: true });
  expect(after.query("SELECT * FROM trees ORDER BY id").all()).toEqual(before);
  expect(after.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: CANOPY_SCHEMA_VERSION });
  after.close();
});
