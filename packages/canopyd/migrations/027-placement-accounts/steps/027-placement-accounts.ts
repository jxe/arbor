import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 26 → 27: placement accounts (Security 007). `accounts` gains
 * `home_host`, the origin of the profile's home host when this host is a
 * placement host for it (accounts §1.3); NULL, as every existing row is,
 * means this host is the profile's home. A placement account's devices get
 * `devices` rows the first time they open a session, so no other table
 * changes; the device-key copies a placement host keeps are memory only.
 */
export const placementAccounts: MigrationStep = {
  from: 26,
  name: "027-placement-accounts",
  run(db) {
    db.run("ALTER TABLE accounts ADD COLUMN home_host TEXT");
  },
  verify(db) {
    const columns = (db.query("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (!columns.includes("home_host")) throw new Error("accounts has no home_host");
    const placed = (db.query("SELECT COUNT(*) AS n FROM accounts WHERE home_host IS NOT NULL").get() as { n: number }).n;
    if (placed) throw new Error("The migration made an existing account a placement account");
  },
};
