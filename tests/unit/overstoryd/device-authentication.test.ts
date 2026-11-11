import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sha256 } from "@ovst/protocol";
import { AccountDirectory } from "../../../packages/overstoryd/src/accounts.ts";
import { createHostSchema } from "../../../packages/overstoryd/src/schema.ts";

function directory() {
  const db = new Database(":memory:");
  createHostSchema(db);
  db.run("INSERT INTO accounts (id, handle, enabled) VALUES ('ac_1', 'owner', 1)");
  db.run("INSERT INTO devices (id, account_id, label, public_key, created_at) VALUES ('dv_1', 'ac_1', 'Mac', 'ed25519:mac', 1)");
  const accounts = new AccountDirectory(db);
  accounts.insertSession(sha256("session"), "dv_1", Date.now(), Date.now() + 60 * 60 * 1000);
  return { db, accounts };
}

test("authentication refreshes a device's last use at most once a minute", () => {
  const { db, accounts } = directory();
  const lastUsed = () => (db.query("SELECT last_used_at FROM devices WHERE id = 'dv_1'").get() as { last_used_at: number | null }).last_used_at;

  expect(accounts.authenticateToken("session")?.device).toBe("dv_1");
  const first = lastUsed();
  expect(first).not.toBeNull();
  db.run("UPDATE devices SET last_used_at = ? WHERE id = 'dv_1'", [first! - 30_000]);
  accounts.authenticateToken("session");
  expect(lastUsed()).toBe(first! - 30_000);
  db.run("UPDATE devices SET last_used_at = ? WHERE id = 'dv_1'", [first! - 61_000]);
  accounts.authenticateToken("session");
  expect(lastUsed()!).toBeGreaterThanOrEqual(first!);
  expect(accounts.authenticateToken("wrong")).toBeNull();
  db.close();
});

test("a session is the only device authentication, and it expires", () => {
  const { db, accounts } = directory();
  expect(accounts.authenticateToken("session")?.expiresAt).toBeGreaterThan(Date.now());
  db.run("UPDATE device_sessions SET expires_at = ?", [Date.now() - 1]);
  expect(accounts.authenticateToken("session")).toBeNull();
  db.close();
});

test("only a revoked device may have no key", () => {
  const { db } = directory();
  expect(() => db.run("INSERT INTO devices (id, account_id, label, created_at) VALUES ('dv_2', 'ac_1', 'Phone', 1)")).toThrow("CHECK constraint failed");
  db.run("INSERT INTO devices (id, account_id, label, created_at, revoked_at) VALUES ('dv_2', 'ac_1', 'Phone', 1, 2)");
  db.close();
});

test("a device's clients are noted when one names a new version, and kept in devices.clients", () => {
  const { db, accounts } = directory();
  expect(accounts.noteClient("dv_1", null)).toBeNull();
  expect(accounts.noteClient("dv_1", " story-sync/0.1.8+12 ")).toBe("story-sync/0.1.8+12");
  expect(accounts.noteClient("dv_1", "Story/0.1.8 (12; macOS)")).toBe("Story/0.1.8 (12; macOS)");
  expect(accounts.noteClient("dv_1", "story-sync/0.1.8+12")).toBeNull();
  expect(accounts.noteClient("dv_1", "story-sync/0.1.9+13")).toBe("story-sync/0.1.9+13");
  expect(accounts.deviceClients("dv_1")).toEqual(["story-sync/0.1.9+13", "Story/0.1.8 (12; macOS)"]);
  expect(JSON.parse((db.query("SELECT clients FROM devices WHERE id = 'dv_1'").get() as { clients: string }).clients))
    .toEqual({ "story-sync": "story-sync/0.1.9+13", Story: "Story/0.1.8 (12; macOS)" });
  // A new process starts from what was kept.
  const again = new AccountDirectory(db);
  expect(again.noteClient("dv_1", "Story/0.1.8 (12; macOS)")).toBeNull();
  db.close();
});
