import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../../../tests/helpers/devices.ts";
import { runBatch } from "../tools/batch.ts";
import { migrateNextBatch, steps } from "./run.ts";

let sandbox: string, schema32: string;
const tables = (path: string) => {
  const db = new Database(join(path, "overstoryd.sqlite3"), { readonly: true });
  try {
    const columns = (db.query("PRAGMA table_info(devices)").all() as Array<{ name: string }>).map(({ name }) => name);
    return {
      stamp: (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      names: (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name),
      columns,
      devices: db.query("SELECT id, account_id, label, public_key, created_at, last_used_at, revoked_at FROM devices ORDER BY id").all(),
      clients: columns.includes("clients") ? db.query("SELECT clients FROM devices").all() as Array<{ clients: string | null }> : [],
    };
  } finally { db.close(); }
};

/** A data root as the live host holds it before the batch: schema 32, with a used device. */
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-migration-next-"));
  schema32 = join(sandbox, "schema32");
  const host = await serveHost({
    dataRoot: schema32, accounts: [testAccount("owner", "migration-next-owner", { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  await (await deviceClient(host.url, "migration-next-owner")).account();
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the batch's steps run in order from the live schema to the next", () => {
  expect(steps.map((step) => step.from)).toEqual(steps.map((_, index) => steps[0]!.from + index));
  expect(steps[0]!.from).toBe(Number(tables(schema32).stamp));
});

test("the batch migrates schema 32 once, giving every device an empty clients column and keeping every row", async () => {
  const root = join(sandbox, "migrated");
  await cp(schema32, root, { recursive: true });
  const before = tables(root);
  expect(before.columns).not.toContain("clients");
  expect(migrateNextBatch(root)).toEqual({ migrated: true, from: 32, to: 33, steps: ["033-device-clients"] });
  const after = tables(root);
  expect(after.stamp).toBe("33");
  expect(after.names).toEqual(before.names);
  expect(after.columns).toEqual([...before.columns, "clients"]);
  expect(after.devices).toEqual(before.devices);
  expect(after.clients.length).toBe(after.devices.length);
  expect(after.clients.every((row) => row.clients === null)).toBe(true);
  expect(migrateNextBatch(root)).toEqual({ migrated: false, from: 33, to: 33, steps: [] });
});

test("it refuses, changing nothing, a schema it does not start from", async () => {
  const old = join(sandbox, "old");
  await cp(schema32, old, { recursive: true });
  const stamped = new Database(join(old, "overstoryd.sqlite3"));
  stamped.run("UPDATE meta SET value = '31' WHERE key = 'schema_version'");
  stamped.close();
  expect(() => runBatch(old, steps)).toThrow("found 31");
  expect(tables(old).columns).not.toContain("clients");
});
