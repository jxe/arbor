import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../../../tests/helpers/devices.ts";
import { assertHostData } from "../../src/schema.ts";
import { runBatch } from "../tools/batch.ts";
import { migrateNextBatch, steps } from "./run.ts";

let sandbox: string, schema26: string;
const tables = (path: string) => {
  const db = new Database(join(path, "overstoryd.sqlite3"), { readonly: true });
  try {
    return {
      stamp: (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      names: (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name),
      accounts: db.query("SELECT * FROM accounts ORDER BY id").all() as Array<Record<string, unknown>>,
      devices: db.query("SELECT * FROM devices ORDER BY id").all(),
    };
  } finally { db.close(); }
};

/** Rewrite a data root this build wrote into the layout the live host holds
 * at schema 26: `accounts` without `home_host`. */
function toSchema26(path: string): void {
  const db = new Database(join(path, "overstoryd.sqlite3"));
  try {
    db.transaction(() => {
      db.run("ALTER TABLE accounts DROP COLUMN home_host");
      db.run("UPDATE meta SET value = '26' WHERE key = 'schema_version'");
    })();
  } finally { db.close(); }
}

/** A data root as the live host holds it before the batch: schema 26. */
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-migration-next-"));
  schema26 = join(sandbox, "schema26");
  const host = await serveHost({
    dataRoot: schema26, accounts: [testAccount("owner", "migration-next-owner", { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  await (await deviceClient(host.url, "migration-next-owner")).account();
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
  toSchema26(schema26);
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the batch's steps run in order from the live schema to the next", () => {
  expect(steps.map((step) => step.from)).toEqual(steps.map((_, index) => steps[0]!.from + index));
  expect(steps[0]!.from).toBe(Number(tables(schema26).stamp));
});

test("the batch migrates schema 26 once: every account stays a home account, every other row kept", async () => {
  const root = join(sandbox, "migrated");
  await cp(schema26, root, { recursive: true });
  const before = tables(root);
  expect(before.accounts.length).toBeGreaterThan(0);
  expect(before.accounts.every((account) => !("home_host" in account))).toBe(true);
  expect(migrateNextBatch(root)).toEqual({ migrated: true, from: 26, to: 27, steps: steps.map((step) => step.name) });
  const after = tables(root);
  expect(after.stamp).toBe("27");
  expect(after.names).toEqual(before.names);
  expect(after.accounts).toEqual(before.accounts.map((account) => ({ ...account, home_host: null })));
  expect(after.devices).toEqual(before.devices);
  expect(migrateNextBatch(root)).toEqual({ migrated: false, from: 27, to: 27, steps: [] });
});

test("a placement account, which has no device until one opens a session, passes the data checks", async () => {
  const root = join(sandbox, "placement");
  await cp(schema26, root, { recursive: true });
  migrateNextBatch(root);
  const db = new Database(join(root, "overstoryd.sqlite3"));
  try {
    db.run("INSERT INTO accounts (id, handle, enabled, home_host) VALUES ('tr_placed', 'placed', 1, 'https://home.example')");
    expect(() => assertHostData(db)).not.toThrow();
    db.run("INSERT INTO accounts (id, handle, enabled) VALUES ('tr_homeless', 'homeless', 1)");
    // A home account still needs its first device.
    expect(() => assertHostData(db)).toThrow("accounts without devices");
  } finally { db.close(); }
});

test("it refuses, changing nothing, a schema it does not start from", async () => {
  const old = join(sandbox, "old");
  await cp(schema26, old, { recursive: true });
  const stamped = new Database(join(old, "overstoryd.sqlite3"));
  stamped.run("UPDATE meta SET value = '25' WHERE key = 'schema_version'");
  stamped.close();
  expect(() => runBatch(old, steps)).toThrow("found 25");
  expect(tables(old).accounts.every((account) => !("home_host" in account))).toBe(true);
});
