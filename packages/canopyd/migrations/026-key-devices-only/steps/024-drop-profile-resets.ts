import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 23 → 24: the profile-key reset was withdrawn (Security 006,
 * 2026-09-27) in favour of the operator's recovery pairing, which needs no
 * table. `profile_resets` has never held a row on the live host; a reset still
 * pending anywhere would be discarded, so the step refuses rather than drop one.
 */
export const dropProfileResets: MigrationStep = {
  from: 23,
  name: "024-drop-profile-resets",
  run(db) {
    const pending = (db.query("SELECT COUNT(*) AS n FROM profile_resets").get() as { n: number }).n;
    if (pending) throw new Error(`profile_resets holds ${pending} pending reset(s); cancel them before migrating`);
    db.run("DROP TABLE profile_resets");
  },
  verify(db) {
    if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'profile_resets'").get()) throw new Error("profile_resets survived the batch");
  },
};
