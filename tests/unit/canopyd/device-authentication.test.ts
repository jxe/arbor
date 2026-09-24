import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sha256 } from "@overstory/protocol";
import { AccountDirectory } from "../../../packages/canopyd/src/accounts.ts";
import { createCanopySchema } from "../../../packages/canopyd/src/schema.ts";

test("authentication refreshes a device's last use at most once a minute", () => {
  const db = new Database(":memory:");
  createCanopySchema(db);
  db.run("INSERT INTO accounts (id, handle, enabled) VALUES ('ac_1', 'owner', 1)");
  db.run("INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES ('dv_1', 'ac_1', 'Mac', ?, 1)", [sha256("secret")]);
  const accounts = new AccountDirectory(db);
  const lastUsed = () => (db.query("SELECT last_used_at FROM devices WHERE id = 'dv_1'").get() as { last_used_at: number | null }).last_used_at;

  expect(accounts.authenticateToken("secret")?.device).toBe("dv_1");
  const first = lastUsed();
  expect(first).not.toBeNull();
  db.run("UPDATE devices SET last_used_at = ? WHERE id = 'dv_1'", [first! - 30_000]);
  accounts.authenticateToken("secret");
  expect(lastUsed()).toBe(first! - 30_000);
  db.run("UPDATE devices SET last_used_at = ? WHERE id = 'dv_1'", [first! - 61_000]);
  accounts.authenticateToken("secret");
  expect(lastUsed()!).toBeGreaterThanOrEqual(first!);
  expect(accounts.authenticateToken("wrong")).toBeNull();
  db.close();
});
