import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 27 → 28: pinned profile locators (Security 011). A community member
 * or rule may name a profile on another host by its canonical locator there
 * (`https://A/~joe`); the host records the Profile TreeID the locator first
 * resolved to, and a later resolution to another TreeID makes the entry match
 * nobody until it is edited. The pin is host state, never in a configuration
 * file, and must survive a restart, hence a table. It starts empty: no live
 * entry names a locator yet.
 */
export const profileLocatorPins: MigrationStep = {
  from: 27,
  name: "028-profile-locator-pins",
  run(db) {
    db.run(`CREATE TABLE profile_locator_pins (
      locator TEXT PRIMARY KEY,
      profile_tree TEXT NOT NULL,
      pinned_at INTEGER NOT NULL
    )`);
  },
  verify(db) {
    const columns = (db.query("PRAGMA table_info(profile_locator_pins)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (columns.join(",") !== "locator,profile_tree,pinned_at") throw new Error("profile_locator_pins has the wrong columns");
    const rows = (db.query("SELECT COUNT(*) AS n FROM profile_locator_pins").get() as { n: number }).n;
    if (rows) throw new Error("profile_locator_pins starts with rows");
  },
};
