import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { ProtocolClient } from "@overstory/protocol";
import { runBatch } from "../tools/batch.ts";
import { migrateNextBatch, steps } from "./run.ts";

let sandbox: string, schema23: string;
const tables = (path: string) => {
  const db = new Database(join(path, "canopy.sqlite3"), { readonly: true });
  try {
    return {
      stamp: (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      names: (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name),
      devices: db.query("SELECT * FROM devices ORDER BY id").all(),
    };
  } finally { db.close(); }
};

/** Rewrite a data root this build wrote into the layout the live host holds
 * at schema 23: the two challenge tables apart, and `profile_resets`. */
function toSchema23(path: string, challenges: Array<[string, string, string, number, number | null]> = []): void {
  const db = new Database(join(path, "canopy.sqlite3"));
  try {
    db.transaction(() => {
      db.run("DROP TABLE challenges");
      for (const table of ["account_challenges", "device_challenges"]) {
        db.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, challenge_json TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)`);
      }
      for (const [table, id, json, expiresAt, consumedAt] of challenges) {
        db.run(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`, [id, json, expiresAt, consumedAt]);
      }
      db.run(`
        CREATE TABLE profile_resets (
          profile_tree TEXT PRIMARY KEY REFERENCES accounts(id),
          device_id TEXT NOT NULL,
          label TEXT NOT NULL,
          public_key TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          effective_at INTEGER NOT NULL,
          proof_digest TEXT NOT NULL
        )
      `);
      db.run("UPDATE meta SET value = '23' WHERE key = 'schema_version'");
    })();
  } finally { db.close(); }
}

/** A data root as the live host holds it before the batch: schema 23. */
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-migration-next-"));
  schema23 = join(sandbox, "schema23");
  const host = await serveHost({
    dataRoot: schema23, accounts: [{ handle: "owner", token: "migration-next-owner", communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  await new ProtocolClient(host.url, "migration-next-owner").account();
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  const future = Date.now() + 60 * 60 * 1000;
  toSchema23(schema23, [
    ["account_challenges", "ax_open", "{\"a\":1}", future, null],
    ["account_challenges", "ax_used", "{}", future, 1],
    ["device_challenges", "dc_open", "{\"d\":1}", future, null],
    ["device_challenges", "dc_expired", "{}", 1, null],
  ]);
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the batch's steps run in order from the live schema to the next", () => {
  expect(steps.map((step) => step.from)).toEqual(steps.map((_, index) => steps[0]!.from + index));
  expect(steps[0]!.from).toBe(Number(tables(schema23).stamp));
});

test("the batch migrates schema 23 once, keeping every other table and row", async () => {
  const root = join(sandbox, "migrated");
  await cp(schema23, root, { recursive: true });
  const before = tables(root);
  expect(before.names).toContain("profile_resets");
  expect(migrateNextBatch(root)).toEqual({ migrated: true, from: 23, to: 25, steps: steps.map((step) => step.name) });
  const after = tables(root);
  expect(after.stamp).toBe("25");
  const gone = ["profile_resets", "account_challenges", "device_challenges"];
  expect(after.names).toEqual([...before.names.filter((name) => !gone.includes(name)), "challenges"].sort());
  expect(after.devices).toEqual(before.devices);
  expect(migrateNextBatch(root)).toEqual({ migrated: false, from: 25, to: 25, steps: [] });
});

test("only challenges that can still be redeemed survive, each under its purpose", async () => {
  const root = join(sandbox, "challenges");
  await cp(schema23, root, { recursive: true });
  migrateNextBatch(root);
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  try {
    expect(db.query("SELECT id, purpose, challenge_json, consumed_at FROM challenges ORDER BY id").all()).toEqual([
      { id: "ax_open", purpose: "account-claim", challenge_json: "{\"a\":1}", consumed_at: null },
      { id: "dc_open", purpose: "device-session", challenge_json: "{\"d\":1}", consumed_at: null },
    ]);
  } finally { db.close(); }
});

test("it refuses, changing nothing, a pending reset or a schema it does not start from", async () => {
  const pending = join(sandbox, "pending");
  await cp(schema23, pending, { recursive: true });
  const db = new Database(join(pending, "canopy.sqlite3"));
  db.run("INSERT INTO profile_resets VALUES ('tr_x', 'dv_x', 'Phone', 'ed25519:x', 1, 2, 'sha256:x')");
  db.close();
  expect(() => migrateNextBatch(pending)).toThrow("pending reset");
  expect(tables(pending)).toMatchObject({ stamp: "23" });
  expect(tables(pending).names).toContain("profile_resets");

  const old = join(sandbox, "old");
  await cp(schema23, old, { recursive: true });
  const stamped = new Database(join(old, "canopy.sqlite3"));
  stamped.run("UPDATE meta SET value = '22' WHERE key = 'schema_version'");
  stamped.close();
  expect(() => runBatch(old, steps)).toThrow("found 22");
});
