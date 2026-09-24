import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AccountDirectory } from "../../../packages/canopyd/src/accounts.ts";
import { createHostSchema } from "../../../packages/canopyd/src/schema.ts";

test("a new pairing prunes expired unclaimed pairings and keeps claimed ones for replay", () => {
  const db = new Database(":memory:");
  try {
    createHostSchema(db);
    db.run("INSERT INTO accounts (id, handle, enabled) VALUES ('ac_owner', 'owner', 1)");
    const insert = (id: string, claimedAt: number | null) => db.run(
      "INSERT INTO pairings (id, account_id, secret_digest, confirmation_code, created_at, expires_at, claimed_at) VALUES (?, 'ac_owner', 'digest', '000000', 0, 1, ?)",
      [id, claimedAt],
    );
    insert("pa_expired", null);
    insert("pa_claimed", 0);
    const directory = new AccountDirectory(db);
    const offer = directory.createPairing(directory.account("ac_owner")!);
    const ids = (db.query("SELECT id FROM pairings ORDER BY id").all() as Array<{ id: string }>).map(({ id }) => id);
    expect(ids).toEqual([offer.id, "pa_claimed"].sort());
  } finally {
    db.close();
  }
});
