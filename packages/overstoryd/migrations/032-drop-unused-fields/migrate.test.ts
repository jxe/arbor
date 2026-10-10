import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../../../tests/helpers/devices.ts";
import { runBatch } from "../tools/batch.ts";
import { migrateNextBatch, steps } from "./run.ts";

let sandbox: string, schema29: string;
const columns = (db: Database, table: string) =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
const tables = (path: string) => {
  const db = new Database(join(path, "overstoryd.sqlite3"), { readonly: true });
  try {
    return {
      stamp: (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      names: (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name),
      accounts: db.query("SELECT * FROM accounts ORDER BY id").all(),
      devices: db.query("SELECT * FROM devices ORDER BY id").all(),
      trees: db.query("SELECT id, ref, governs FROM trees ORDER BY id").all(),
      pairings: db.query("SELECT id, account_id, secret_digest, confirmation_code, expires_at, claimed_at, claimed_device FROM pairings ORDER BY id").all(),
      sessions: db.query("SELECT token_digest, device_id, expires_at FROM device_sessions ORDER BY token_digest").all(),
      facts: (db.query("SELECT tree_id, index_hash, avatar_path, facts FROM profile_facts ORDER BY tree_id").all() as Array<{ facts: string }>)
        .map((row) => ({ ...row, facts: JSON.parse(row.facts) as Record<string, unknown> })),
      columns: Object.fromEntries(["trees", "profile_locator_pins", "pairings", "device_sessions"].map((table) => [table, columns(db, table)])),
    };
  } finally { db.close(); }
};

/** Rewrite a data root this build wrote into the layout the live host holds
 * at schema 29: `trees.policy` beside `governs`, the three times, and
 * `version: 3` in every profile's facts. */
function toSchema29(path: string): void {
  const db = new Database(join(path, "overstoryd.sqlite3"));
  try {
    db.transaction(() => {
      db.run("ALTER TABLE trees ADD COLUMN policy TEXT NOT NULL DEFAULT 'ordinary'");
      db.run("UPDATE trees SET policy = 'tree-config-v1' WHERE governs IS NOT NULL");
      db.run("ALTER TABLE profile_locator_pins ADD COLUMN pinned_at INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE pairings ADD COLUMN created_at INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE device_sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 1");
      db.run("UPDATE profile_facts SET facts = json_set(facts, '$.version', 3)");
      db.run("UPDATE meta SET value = '29' WHERE key = 'schema_version'");
    })();
  } finally { db.close(); }
}

/** A data root as the live host holds it before the batch: schema 29, with a
 * session, a pairing, a locator pin and profile facts. */
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-migration-next-"));
  schema29 = join(sandbox, "schema29");
  const host = await serveHost({
    dataRoot: schema29, accounts: [testAccount("owner", "migration-next-owner", { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  const client = await deviceClient(host.url, "migration-next-owner");
  await client.account();
  await client.createPairing();
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
  const db = new Database(join(schema29, "overstoryd.sqlite3"));
  db.run("INSERT INTO profile_locator_pins VALUES ((SELECT id FROM trees WHERE governs IS NULL LIMIT 1), 'https://home.example/~joe', 'tr_joe')");
  db.close();
  toSchema29(schema29);
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the batch's steps run in order from the live schema to the next", () => {
  expect(steps.map((step) => step.from)).toEqual(steps.map((_, index) => steps[0]!.from + index));
  expect(steps[0]!.from).toBe(Number(tables(schema29).stamp));
});

test("the batch migrates schema 29 once, dropping the redundant and unread columns and keeping every row", async () => {
  const root = join(sandbox, "migrated");
  await cp(schema29, root, { recursive: true });
  const before = tables(root);
  expect(before.pairings.length).toBe(1);
  expect(before.sessions.length).toBe(1);
  expect(before.facts.length).toBeGreaterThan(0);
  expect(before.facts.every(({ facts }) => facts.version === 3)).toBe(true);
  expect(migrateNextBatch(root)).toEqual({
    migrated: true, from: 29, to: 32, steps: ["030-drop-tree-policy", "031-drop-unread-times", "032-profile-facts-unversioned"],
  });
  const after = tables(root);
  expect(after.stamp).toBe("32");
  expect(after.names).toEqual(before.names);
  expect(after.columns).toEqual({
    trees: ["id", "ref", "governs"],
    profile_locator_pins: ["tree_id", "locator", "profile_tree"],
    pairings: ["id", "account_id", "secret_digest", "confirmation_code", "expires_at", "claimed_at", "claimed_device"],
    device_sessions: ["token_digest", "device_id", "expires_at"],
  });
  for (const key of ["accounts", "devices", "trees", "pairings", "sessions"] as const) expect(after[key]).toEqual(before[key]);
  expect(after.facts).toEqual(before.facts.map((row) => {
    const { version: _, ...facts } = row.facts;
    return { ...row, facts };
  }));
  expect(migrateNextBatch(root)).toEqual({ migrated: false, from: 32, to: 32, steps: [] });
});

test("it refuses, changing nothing, a tree whose policy disagrees with governs", async () => {
  const root = join(sandbox, "disagreeing");
  await cp(schema29, root, { recursive: true });
  const db = new Database(join(root, "overstoryd.sqlite3"));
  db.run("UPDATE trees SET policy = 'tree-config-v1' WHERE id = (SELECT id FROM trees WHERE governs IS NULL LIMIT 1)");
  db.close();
  expect(() => migrateNextBatch(root)).toThrow("disagrees with governs");
  const after = tables(root);
  expect(after.stamp).toBe("29");
  expect(after.columns.trees).toContain("policy");
  expect(after.columns.pairings).toContain("created_at");
});

test("it refuses, changing nothing, profile facts of another version", async () => {
  const root = join(sandbox, "version");
  await cp(schema29, root, { recursive: true });
  const db = new Database(join(root, "overstoryd.sqlite3"));
  db.run("UPDATE profile_facts SET facts = json_set(facts, '$.version', 2) WHERE tree_id = (SELECT tree_id FROM profile_facts LIMIT 1)");
  db.close();
  expect(() => migrateNextBatch(root)).toThrow("not 3");
  const after = tables(root);
  expect(after.stamp).toBe("29");
  expect(after.columns.trees).toContain("policy");
});

test("it refuses, changing nothing, a schema it does not start from", async () => {
  const old = join(sandbox, "old");
  await cp(schema29, old, { recursive: true });
  const stamped = new Database(join(old, "overstoryd.sqlite3"));
  stamped.run("UPDATE meta SET value = '28' WHERE key = 'schema_version'");
  stamped.close();
  expect(() => runBatch(old, steps)).toThrow("found 28");
  expect(tables(old).columns.trees).toContain("policy");
});
