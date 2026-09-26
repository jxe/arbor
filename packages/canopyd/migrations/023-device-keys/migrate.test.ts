import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { generateArborID, ProtocolClient, sha256 } from "@overstory/protocol";
import { migrateDeviceKeys } from "./run.ts";

const ownerToken = "migration-023-owner", phoneToken = "migration-023-phone";
let sandbox: string, root: string;
type Row = Record<string, unknown>;
let devicesBefore: Row[];

/** Rewrite a schema-23 data root into the layout schema 22 left: a devices
 * table whose digest is required and which has no key, and none of the key
 * tables. */
function toSchema22(path: string): void {
  const db = new Database(join(path, "canopy.sqlite3"));
  try {
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      db.run("ALTER TABLE devices RENAME TO devices_23");
      db.run(`
        CREATE TABLE devices (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          label TEXT NOT NULL,
          token_digest TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER
        )
      `);
      db.run("INSERT INTO devices SELECT id, account_id, label, token_digest, created_at, last_used_at, revoked_at FROM devices_23");
      db.run("DROP TABLE devices_23");
      for (const table of ["device_sessions", "device_challenges", "profile_resets"]) db.run(`DROP TABLE ${table}`);
      db.run("UPDATE meta SET value = '22' WHERE key = 'schema_version'");
    })();
  } finally {
    db.close();
  }
}

const deviceRows = (path: string) => {
  const db = new Database(join(path, "canopy.sqlite3"), { readonly: true });
  try { return db.query("SELECT id, account_id, label, token_digest, created_at, last_used_at, revoked_at FROM devices ORDER BY id").all() as Row[]; }
  finally { db.close(); }
};

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-migration-023-"));
  root = join(sandbox, "canopy");
  const running = await serveHost({
    dataRoot: root, accounts: [{ handle: "owner", token: ownerToken, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  try {
    // A second, paired device, so the rebuilt table carries more than one row.
    const owner = new ProtocolClient(running.url, ownerToken);
    const offer = await owner.createPairing();
    await new ProtocolClient(running.url).claimPairing(offer.id, offer.secret, {
      id: generateArborID("dv"), label: "Phone", credentialDigest: `sha256:${sha256(phoneToken)}`,
    });
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
  }
  toSchema22(root);
  devicesBefore = deviceRows(root);
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("a stamp other than 22 stops the run with nothing changed", async () => {
  const copy = join(sandbox, "wrong-stamp");
  await mkdir(copy, { recursive: true });
  const db = new Database(join(copy, "canopy.sqlite3"), { create: true });
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '21')");
  db.close();
  await expect(migrateDeviceKeys(copy)).rejects.toThrow("requires schema 22, found 21");
});

test("migrates every device unchanged, and both credentials keep working", async () => {
  expect(devicesBefore).toHaveLength(2);
  expect(await migrateDeviceKeys(root)).toEqual({ migrated: true, devices: 2 });
  expect(deviceRows(root)).toEqual(devicesBefore);
  expect(await migrateDeviceKeys(root)).toEqual({ migrated: false, devices: 2 });

  const running = await serveHost({ dataRoot: root, publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  try {
    for (const token of [ownerToken, phoneToken]) {
      expect((await new ProtocolClient(running.url, token).account()).account.handle).toBe("owner");
    }
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
  }
});
