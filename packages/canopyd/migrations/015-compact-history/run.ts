import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import type { ObjectHash } from "@overstory/protocol";
import { EntryMetadataStore, entryChanges, type EntryChanges } from "../../../../packages/canopyd/src/updates/entry-metadata.ts";
import { AcceptedUpdateStore } from "../../../../packages/canopyd/src/updates/store.ts";
import { assertCurrentCanopySchema } from "../../../../packages/canopyd/src/schema.ts";

/** Schema 15 (or 16) → 17: entry metadata, then one accepted history.
 *
 * From 15 it first does what migration 014 did (never run live, folded in
 * here): create `entry_metadata` and `document_versions` and fill both by
 * replaying each tree's accepted updates in order. From 16 that step is
 * skipped.
 *
 * Then it removes the copies of accepted history:
 * - `observations` folds into `accepted_updates.ordinal`, the row's cursor.
 *   Every accepted update keeps its observation's ordinal, so every cursor a
 *   client holds for an accepted update stays valid; the AUTOINCREMENT
 *   sequence continues past the old observation sequence, so no ordinal is
 *   reused. Legacy status observations are dropped: a client anchored on one
 *   gets `resync-required`.
 * - `reflog` is dropped. Nothing read it; `accepted_updates` holds the same
 *   root chain.
 * - `authored_changes` keeps only `(accepted_id, trace_json, evidence_json)`.
 *   Its tree, change, basis and candidate were copies of the owning accepted
 *   update's columns; the run stops if any copy disagrees.
 *
 * Order: stamp and `quick_check` → checks and (from 15) the entry replay,
 * both read-only → one transaction (entry tables, rebuild, stamp 17,
 * `foreign_key_check`) → schema check. A crash before the transaction leaves
 * the database unchanged; a rerun after it reports `migrated: false`.
 */
export interface MigrationReport {
  migrated: boolean;
  from: string;
  /** Every tree's current root; unchanged by this migration, listed for `verify.ts`. */
  trees: Array<{ id: string; root: string }>;
  updates: number;
  entries: number;
  documentVersions: number;
  documents: number;
  /** Trees whose earliest retained update has a pruned predecessor (from 15 only). */
  prunedHistory: number;
  /** Observation rows without an accepted update, dropped. */
  statusObservations: number;
  /** Accepted updates whose old cursor text was not their decimal ordinal; clients anchored there resync. */
  respelledCursors: number;
  reflogRows: number;
  authoredChanges: number;
  /** Next ordinal the host will assign. */
  nextOrdinal: number;
  ms: Record<string, number>;
}
type Log = (event: Record<string, unknown>) => void;

export async function migrateCompactHistory(root: string, log: Log = () => {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const phase = (name: string, since: number) => { ms[name] = Math.round(performance.now() - since); };
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  try {
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    const trees = db.query("SELECT id, ref AS root FROM trees ORDER BY id").all() as Array<{ id: string; root: string }>;
    const summary = () => ({
      trees,
      updates: count("SELECT COUNT(*) AS n FROM accepted_updates"),
      entries: count("SELECT COUNT(*) AS n FROM entry_metadata"),
      documentVersions: count("SELECT COUNT(*) AS n FROM document_versions"),
      documents: count("SELECT COUNT(DISTINCT tree_id || ' ' || stable_key) AS n FROM document_versions"),
      authoredChanges: count("SELECT COUNT(*) AS n FROM authored_changes"),
    });
    if (stamp === "17") {
      const sequence = db.query("SELECT seq FROM sqlite_sequence WHERE name = 'accepted_updates'").get() as { seq: number } | null;
      return { migrated: false, from: stamp, ...summary(), prunedHistory: 0, statusObservations: 0, respelledCursors: 0,
        reflogRows: 0, nextOrdinal: (sequence?.seq ?? 0) + 1, ms };
    }
    if (stamp !== "15" && stamp !== "16") throw new Error(`Migration 015 requires schema 15 or 16, found ${stamp}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);

    // Every accepted update has exactly one observation, and a tree's
    // insertion order (what `current()` read) is its observation order.
    let since = performance.now();
    const rows = db.query(`
      SELECT u.id, u.tree_id, u.root, u.previous_root, u.accepted_at,
        (SELECT COUNT(*) FROM observations o WHERE o.update_id = u.id) AS observations,
        (SELECT o.ordinal FROM observations o WHERE o.update_id = u.id) AS ordinal,
        (SELECT o.cursor FROM observations o WHERE o.update_id = u.id) AS cursor
      FROM accepted_updates u ORDER BY u.tree_id, u.rowid
    `).all() as Array<{ id: string; tree_id: string; root: ObjectHash; previous_root: ObjectHash | null;
      accepted_at: number; observations: number; ordinal: number | null; cursor: string | null }>;
    let respelledCursors = 0;
    for (const [index, row] of rows.entries()) {
      if (row.observations !== 1) throw new Error(`Accepted update ${row.id} has ${row.observations} observations`);
      if (row.cursor !== String(row.ordinal)) respelledCursors++;
      const previous = rows[index - 1];
      if (previous?.tree_id === row.tree_id && previous.ordinal! >= row.ordinal!)
        throw new Error(`Accepted order of ${row.tree_id} disagrees with its observation order at ${row.id}`);
    }
    const statusObservations = count("SELECT COUNT(*) AS n FROM observations WHERE update_id IS NULL");
    const orphanObservations = count(`SELECT COUNT(*) AS n FROM observations o
      WHERE o.update_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accepted_updates u WHERE u.id = o.update_id)`);
    if (orphanObservations) throw new Error(`${orphanObservations} observations name no accepted update`);
    const copies = count(`SELECT COUNT(*) AS n FROM authored_changes a LEFT JOIN accepted_updates u ON u.id = a.accepted_id
      WHERE u.id IS NULL OR u.tree_id IS NOT a.tree_id OR u.change_id IS NOT a.change_id
        OR u.base_root IS NOT a.basis_root OR u.candidate_root IS NOT a.candidate_root`);
    if (copies) throw new Error(`${copies} authored changes disagree with their accepted updates`);
    const reflogRows = count("SELECT COUNT(*) AS n FROM reflog");
    const observationSequence = (db.query("SELECT seq FROM sqlite_sequence WHERE name = 'observations'").get() as { seq: number } | null)?.seq ?? 0;
    const nextOrdinal = rows.reduce((max, row) => Math.max(max, row.ordinal!), observationSequence) + 1;
    phase("check", since);

    // Schema 15 only: migration 014's replay, read before the transaction because object reads are async.
    since = performance.now();
    const planned: Array<{ tree: string; update: string; acceptedAt: number; changes: EntryChanges }> = [];
    let boundaries = 0;
    if (stamp === "15") {
      const load = async (hash: ObjectHash) => {
        try { return await objects.read(hash); }
        catch { throw new Error(`Accepted history is missing object ${hash}; stopping rather than inventing continuity`); }
      };
      let previousTree: string | null = null, previousRoot: ObjectHash | null = null;
      for (const [index, row] of rows.entries()) {
        // A tree's earliest retained update is its history boundary: every file
        // it holds is dated there, whether or not older updates were pruned.
        const first = row.tree_id !== previousTree;
        if (first) { previousTree = row.tree_id; if (row.previous_root !== null) boundaries++; }
        else if (row.previous_root !== previousRoot) throw new Error(`Accepted chain of ${row.tree_id} breaks at ${row.id}`);
        planned.push({ tree: row.tree_id, update: row.id, acceptedAt: row.accepted_at,
          changes: await entryChanges(first ? null : row.previous_root, row.root, load) });
        previousRoot = row.root;
        if ((index + 1) % 200 === 0) log({ event: "replay", done: index + 1, total: rows.length });
      }
      phase("replay", since);
    }

    since = performance.now();
    // Rebuilding a referenced table: foreign keys stay off until the check at the end.
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      if (stamp === "15") {
        EntryMetadataStore.createSchema(db);
        const store = new EntryMetadataStore(db);
        for (const update of planned) store.apply(update.tree, update.update, update.acceptedAt, update.changes);
      }
      const columns = "id, tree_id, root, previous_root, previous_id, conflicted, kind, accepted_at, subject, base_root, candidate_root, remote_root, merge_summary, request_digest, transition_json, change_id";
      AcceptedUpdateStore.createTable(db, "accepted_updates_next");
      db.run(`INSERT INTO accepted_updates_next (ordinal, ${columns})
        SELECT o.ordinal, ${columns.split(", ").map((column) => `u.${column}`).join(", ")}
        FROM accepted_updates u JOIN observations o ON o.update_id = u.id ORDER BY o.ordinal`);
      db.run("DROP TABLE observations");
      db.run("DROP TABLE reflog");
      db.run("ALTER TABLE authored_changes RENAME TO authored_changes_prior");
      db.run("DROP TABLE accepted_updates");
      db.run("ALTER TABLE accepted_updates_next RENAME TO accepted_updates");
      AcceptedUpdateStore.createSchema(db);
      db.run("INSERT INTO authored_changes (accepted_id, trace_json, evidence_json) SELECT accepted_id, trace_json, evidence_json FROM authored_changes_prior");
      db.run("DROP TABLE authored_changes_prior");
      db.run("DELETE FROM sqlite_sequence WHERE name IN ('observations', 'accepted_updates', 'accepted_updates_next')");
      db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('accepted_updates', ?)", [nextOrdinal - 1]);
      db.run("UPDATE meta SET value = '17' WHERE key = 'schema_version'");
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`foreign_key_check: ${JSON.stringify(violations.slice(0, 5))}`);
    })();
    db.run("PRAGMA foreign_keys = ON");
    phase("commit", since);
    assertCurrentCanopySchema(db);
    ms.total = Math.round(performance.now() - started);
    return { migrated: true, from: stamp, ...summary(), prunedHistory: boundaries, statusObservations, respelledCursors,
      reflogRows, nextOrdinal, ms };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: run.ts <data-root>"); process.exit(2); }
  const report = await migrateCompactHistory(resolve(root), (event) => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
