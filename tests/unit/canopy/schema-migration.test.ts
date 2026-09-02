import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CANOPY_SCHEMA_VERSION, CanopyDaemon } from "@arbor/canopy";

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
    await expect(CanopyDaemon.open(root, bootstrap)).rejects.toThrow(/schema version 1 \(unstamped\).*delete the Canopy data root and re-bootstrap/);
    // The refused database is left untouched for the operator's migration tool.
    expect(columns(join(root, "canopy.sqlite3"), "boundaries")).toEqual(["path", "tree_id", "parent_tree", "kind"]);
  });

  test("refuses a database stamped with a different version", async () => {
    const root = await dataRoot();
    const first = await CanopyDaemon.open(root, bootstrap);
    await first[Symbol.asyncDispose]();
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("UPDATE meta SET value = 'future' WHERE key = 'schema_version'");
    db.close();
    await expect(CanopyDaemon.open(root)).rejects.toThrow(/schema version future.*delete the Canopy data root and re-bootstrap/);
  });
});
