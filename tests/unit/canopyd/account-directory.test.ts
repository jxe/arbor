import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AccountDirectory } from "../../../packages/canopyd/src/accounts.ts";
import { createHostSchema } from "../../../packages/canopyd/src/schema.ts";
import { PlacementAccountError } from "../../../packages/canopyd/src/errors.ts";

test("a new pairing prunes expired unclaimed pairings and keeps claimed ones for replay", () => {
  const db = new Database(":memory:");
  try {
    createHostSchema(db);
    db.run("INSERT INTO accounts (id, handle, enabled) VALUES ('ac_owner', 'owner', 1)");
    const insert = (id: string, claimedAt: number | null) => db.run(
      "INSERT INTO pairings (id, account_id, secret_digest, confirmation_code, expires_at, claimed_at) VALUES (?, 'ac_owner', 'digest', '000000', 1, ?)",
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

test("a challenge issued for one purpose is neither found nor consumed as another", () => {
  const db = new Database(":memory:");
  try {
    createHostSchema(db);
    const directory = new AccountDirectory(db);
    const now = Date.now();
    directory.insertChallenge("account-claim", "ax_one", "{}", now + 60_000, now);
    expect(directory.challenge("device-session", "ax_one")).toBeNull();
    expect(directory.consumeChallenge("device-session", "ax_one", "{}", now)).toBe(false);
    expect(directory.consumeChallenge("account-claim", "ax_one", "{}", now)).toBe(true);
    expect(directory.consumeChallenge("account-claim", "ax_one", "{}", now)).toBe(false);
  } finally {
    db.close();
  }
});

test("a placement account gets no pairing and no recovery pairing, whoever asks, the recover command included", () => {
  const db = new Database(":memory:");
  try {
    createHostSchema(db);
    db.run("INSERT INTO accounts (id, handle, enabled, home_host) VALUES ('ac_placed', 'placed', 1, 'https://home.example')");
    const directory = new AccountDirectory(db);
    const account = directory.account("ac_placed")!;
    expect(() => directory.createPairing(account)).toThrow(PlacementAccountError);
    expect(() => directory.createPairing(account, { recovery: true })).toThrow("home host https://home.example");
    expect(db.query("SELECT COUNT(*) AS n FROM pairings").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
