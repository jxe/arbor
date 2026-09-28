import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { deviceClient, testAccount } from "../../../../tests/helpers/devices.ts";
import { runBatch } from "../tools/batch.ts";
import { migrateNextBatch, steps } from "./run.ts";

let sandbox: string, schema27: string;
const tables = (path: string) => {
  const db = new Database(join(path, "canopy.sqlite3"), { readonly: true });
  try {
    return {
      stamp: (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      names: (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name),
      accounts: db.query("SELECT * FROM accounts ORDER BY id").all(),
      devices: db.query("SELECT * FROM devices ORDER BY id").all(),
      trees: db.query("SELECT id, ref, policy, governs FROM trees ORDER BY id").all(),
      treeColumns: (db.query("PRAGMA table_info(trees)").all() as Array<{ name: string }>).map(({ name }) => name),
    };
  } finally { db.close(); }
};

/** A data root as the live host holds it before the batch: this build's schema 27. */
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-migration-next-"));
  schema27 = join(sandbox, "schema27");
  const host = await serveHost({
    dataRoot: schema27, accounts: [testAccount("owner", "migration-next-owner", { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  await (await deviceClient(host.url, "migration-next-owner")).account();
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the batch's steps run in order from the live schema to the next", () => {
  expect(steps.map((step) => step.from)).toEqual(steps.map((_, index) => steps[0]!.from + index));
  expect(steps[0]!.from).toBe(Number(tables(schema27).stamp));
});

test("the batch migrates schema 27 once, adding an empty pin table, dropping trees.status and keeping every other table and row", async () => {
  const root = join(sandbox, "migrated");
  await cp(schema27, root, { recursive: true });
  const before = tables(root);
  expect(migrateNextBatch(root)).toEqual({ migrated: true, from: 27, to: 29, steps: ["028-profile-locator-pins", "029-drop-tree-status"] });
  const after = tables(root);
  expect(after.stamp).toBe("29");
  expect(after.names).toEqual([...before.names, "profile_locator_pins"].sort());
  expect(after.accounts).toEqual(before.accounts);
  expect(after.devices).toEqual(before.devices);
  expect(before.treeColumns).toContain("status");
  expect(after.treeColumns).toEqual(["id", "ref", "policy", "governs"]);
  expect(after.trees).toEqual(before.trees);
  expect(migrateNextBatch(root)).toEqual({ migrated: false, from: 29, to: 29, steps: [] });
});

test("a pin names one Profile TreeID per tree and locator", async () => {
  const root = join(sandbox, "pins");
  await cp(schema27, root, { recursive: true });
  migrateNextBatch(root);
  const db = new Database(join(root, "canopy.sqlite3"));
  try {
    db.run("INSERT INTO profile_locator_pins VALUES ('tr_community', 'https://home.example/~joe', 'tr_joe', 1)");
    db.run("INSERT INTO profile_locator_pins VALUES ('tr_notes', 'https://home.example/~joe', 'tr_joe', 1)");
    expect(() => db.run("INSERT INTO profile_locator_pins VALUES ('tr_notes', 'https://home.example/~joe', 'tr_other', 2)")).toThrow("UNIQUE");
  } finally { db.close(); }
});

test("it refuses, changing nothing, a data root holding a tree that is not active", async () => {
  const root = join(sandbox, "retired");
  await cp(schema27, root, { recursive: true });
  const db = new Database(join(root, "canopy.sqlite3"));
  db.run("UPDATE trees SET status = 'retired' WHERE id = (SELECT id FROM trees LIMIT 1)");
  db.close();
  expect(() => migrateNextBatch(root)).toThrow("not active");
  const after = tables(root);
  expect(after.stamp).toBe("27");
  expect(after.names).not.toContain("profile_locator_pins");
  expect(after.treeColumns).toContain("status");
});

test("it refuses, changing nothing, a schema it does not start from", async () => {
  const old = join(sandbox, "old");
  await cp(schema27, old, { recursive: true });
  const stamped = new Database(join(old, "canopy.sqlite3"));
  stamped.run("UPDATE meta SET value = '26' WHERE key = 'schema_version'");
  stamped.close();
  expect(() => runBatch(old, steps)).toThrow("found 26");
  expect(tables(old).names).not.toContain("profile_locator_pins");
});
