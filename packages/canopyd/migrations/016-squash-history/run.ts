import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import type { ObjectHash } from "@overstory/protocol";
import { MergeTool, type MergeToolOptions } from "../../../../packages/canopyd/src/merge-tool.ts";
import { SemanticMerge } from "../../../../packages/canopyd/src/updates/semantic-merge.ts";
import type { MergeStateRecord } from "../../../../packages/canopyd/src/updates/merge-state-store.ts";
import { AcceptedUpdateStore } from "../../../../packages/canopyd/src/updates/store.ts";
import { recordProfileFacts, rootProfileFacts, type RootProfileFacts } from "../../../../packages/canopyd/src/profile.ts";
import { assertCurrentCanopySchema, createAccessTable } from "../../../../packages/canopyd/src/schema.ts";

/** Schema 17 → 18: squash accepted history to each tree's head.
 *
 * Every tree keeps its head root and its head update, under the same ordinal
 * and so the same wire id and cursor: a client placed at the head only
 * advances. The head's merge state is replaced by a fresh editable state
 * checkpointed from the head root alone (the merge worker's first import,
 * as tree creation records it), so no stored state carries history any more.
 * Every other accepted update, its merge state, the legacy whole-entry
 * conflict rows and the retained authored traces are deleted. Entry dates
 * and document versions are kept. Profile facts are rebuilt for current
 * heads only.
 *
 * The run refuses when any tree has an unresolved decision at its head, in
 * its merge state or in a legacy conflict row: resolve them in Canopy first.
 *
 * Order: stamp and `quick_check` → read-only checks → fresh merge states and
 * profile facts (worker jobs and object writes, before the transaction) →
 * one transaction (rebuild, stamp 18, `foreign_key_check`) → schema check. A
 * crash before the transaction leaves the database unchanged; the objects
 * written before it are unreferenced. A rerun afterwards reports
 * `migrated: false`. Old objects are not deleted.
 */
export interface MigrationReport {
  migrated: boolean;
  from: string;
  /** Every tree's head, unchanged by this migration: `update` is its kept wire id. */
  trees: Array<{ id: string; root: string; update: string }>;
  /** Accepted updates before the run, and how many it deleted (all but the heads). */
  updates: number;
  removedUpdates: number;
  removedMergeStates: number;
  conflictRows: number;
  authoredChanges: number;
  /** Heads whose stored id was not their decimal ordinal; a client placed there re-places. */
  respelledHeads: number;
  /** `profile:` meta rows deleted, and rows rebuilt for current person and group heads. */
  profileRows: number;
  rebuiltProfiles: number;
  entries: number;
  documentVersions: number;
  documents: number;
  /** Next ordinal the host will assign. */
  nextOrdinal: number;
  ms: Record<string, number>;
}
type Log = (event: Record<string, unknown>) => void;

/** One tree's head as schema 17 stored it. */
interface Head {
  tree: string;
  ref: ObjectHash;
  ordinal: number;
  id: string;
  root: ObjectHash;
  conflicted: number;
  path: string | null;
}

export class UnresolvedDecisionsError extends Error {}

export async function migrateSquashHistory(root: string, log: Log = () => {}, mergeTool: MergeToolOptions = {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const phase = (name: string, since: number) => { ms[name] = Math.round(performance.now() - since); };
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  try {
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    const sequence = () => (db.query("SELECT seq FROM sqlite_sequence WHERE name = 'accepted_updates'").get() as { seq: number } | null)?.seq ?? 0;
    const summary = () => ({
      entries: count("SELECT COUNT(*) AS n FROM entry_metadata"),
      documentVersions: count("SELECT COUNT(*) AS n FROM document_versions"),
      documents: count("SELECT COUNT(DISTINCT tree_id || ' ' || stable_key) AS n FROM document_versions"),
    });
    if (stamp === "18") {
      const trees = (db.query(`SELECT t.id, t.ref AS root, MAX(u.ordinal) AS ordinal FROM trees t JOIN accepted_updates u ON u.tree_id = t.id
        GROUP BY t.id ORDER BY t.id`).all() as Array<{ id: string; root: string; ordinal: number }>)
        .map(({ id, root, ordinal }) => ({ id, root, update: String(ordinal) }));
      return { migrated: false, from: stamp, trees, updates: count("SELECT COUNT(*) AS n FROM accepted_updates"), removedUpdates: 0,
        removedMergeStates: 0, conflictRows: 0, authoredChanges: 0, respelledHeads: 0, profileRows: 0, rebuiltProfiles: 0,
        ...summary(), nextOrdinal: sequence() + 1, ms };
    }
    if (stamp !== "17") throw new Error(`Migration 016 requires schema 17, found ${stamp}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);

    // Read-only checks. Every tree has a head whose root is the tree's ref.
    let since = performance.now();
    const heads = db.query(`
      SELECT t.id AS tree, t.ref, u.ordinal, u.id, u.root, u.conflicted, b.path
      FROM trees t
      LEFT JOIN accepted_updates u ON u.ordinal = (SELECT MAX(ordinal) FROM accepted_updates WHERE tree_id = t.id)
      LEFT JOIN boundaries b ON b.tree_id = t.id
      ORDER BY t.id
    `).all() as Array<Head & { ordinal: number | null }>;
    for (const head of heads) {
      if (head.ordinal === null) throw new Error(`Tree ${head.tree} has no accepted update`);
      if (head.root !== head.ref) throw new Error(`Tree ${head.tree} ref does not match its newest accepted update ${head.id}`);
    }
    // No tree may carry a live alternative across the squash: its head is
    // unconflicted, its merge state has no decision, and no legacy conflict
    // row at its head names one.
    const decisionsAt = (id: string) => {
      const merge = db.query("SELECT record_json FROM accepted_merge_states WHERE accepted_id = ?").get(id) as { record_json: string } | null;
      const legacy = db.query("SELECT state_json FROM accepted_conflicts WHERE accepted_id = ?").get(id) as { state_json: string } | null;
      return (merge ? (JSON.parse(merge.record_json) as MergeStateRecord).decisions.length : 0)
        + (legacy ? (JSON.parse(legacy.state_json) as { decisions: unknown[] }).decisions.length : 0);
    };
    const unresolved = heads.filter((head) => head.conflicted || decisionsAt(head.id) > 0);
    if (unresolved.length) {
      throw new UnresolvedDecisionsError(`${unresolved.length} tree(s) have unresolved decisions at their head; resolve them in Canopy first: `
        + unresolved.map((head) => `${head.path ?? "(no canonical path)"} (${head.tree}, update ${head.id})`).join(", "));
    }
    const respelledHeads = heads.filter((head) => head.id !== String(head.ordinal)).length;
    const nextOrdinal = sequence() + 1;
    const counts = {
      updates: count("SELECT COUNT(*) AS n FROM accepted_updates"),
      mergeStates: count("SELECT COUNT(*) AS n FROM accepted_merge_states"),
      conflictRows: count("SELECT COUNT(*) AS n FROM accepted_conflicts"),
      authoredChanges: count("SELECT COUNT(*) AS n FROM authored_changes"),
      profileRows: count("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'profile:%'"),
    };
    phase("check", since);

    // Fresh merge states: each head root imported as its tree's first state,
    // exactly as tree creation records one. Objects are durable before the
    // transaction that names them.
    since = performance.now();
    const tool = new MergeTool(root, { objects, ...mergeTool });
    const states = new Map<string, MergeStateRecord>();
    const profiles = new Map<ObjectHash, RootProfileFacts>();
    try {
      const semantic = new SemanticMerge(db, tool, (hash, staged) => objects.load(hash, staged));
      for (const [index, head] of heads.entries()) {
        const staged = new Map<string, Uint8Array>();
        states.set(head.tree, await semantic.checkpoint(head.tree, null, head.root, `initial:${head.tree}`, staged));
        await objects.store([...staged].map(([hash, bytes]) => ({ hash, bytes })));
        const facts = await rootProfileFacts(head.root, (hash) => objects.read(hash));
        if (facts.type) profiles.set(head.root, facts);
        log({ event: "state", tree: head.tree, done: index + 1, total: heads.length });
      }
    } finally {
      await tool[Symbol.asyncDispose]();
    }
    phase("states", since);

    since = performance.now();
    // Rebuilding referenced tables: foreign keys stay off until the check at the end.
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      AcceptedUpdateStore.createTable(db, "accepted_updates_next");
      db.run(`INSERT INTO accepted_updates_next (ordinal, tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id)
        SELECT u.ordinal, u.tree_id, u.root, NULL, 0, u.accepted_at, u.subject, u.request_digest, u.change_id
        FROM accepted_updates u WHERE u.ordinal = (SELECT MAX(ordinal) FROM accepted_updates WHERE tree_id = u.tree_id)
        ORDER BY u.ordinal`);
      db.run("DROP INDEX document_versions_key");
      db.run("ALTER TABLE entry_metadata RENAME TO entry_metadata_prior");
      db.run("ALTER TABLE document_versions RENAME TO document_versions_prior");
      for (const table of ["accepted_merge_states", "accepted_conflicts", "authored_changes", "accepted_updates"])
        db.run(`DROP TABLE ${table}`);
      db.run("ALTER TABLE accepted_updates_next RENAME TO accepted_updates");
      // The accepted-update indexes, `accepted_merge_states`, `entry_metadata` and `document_versions`.
      AcceptedUpdateStore.createSchema(db);
      const insertState = db.prepare("INSERT INTO accepted_merge_states (accepted_id, record_json) VALUES (?, ?)");
      for (const head of heads) insertState.run(head.ordinal, JSON.stringify(states.get(head.tree)!));
      db.run("INSERT INTO entry_metadata (tree_id, path, modified_at) SELECT tree_id, path, modified_at FROM entry_metadata_prior");
      // Rowid order is each document's version order.
      db.run(`INSERT INTO document_versions (rowid, tree_id, stable_key, update_id, entry_path, content_hash, accepted_at)
        SELECT rowid, tree_id, stable_key, update_id, entry_path, content_hash, accepted_at FROM document_versions_prior ORDER BY rowid`);
      db.run("DROP TABLE entry_metadata_prior");
      db.run("DROP TABLE document_versions_prior");
      createAccessTable(db, "access_next");
      db.run("INSERT INTO access_next (id, tree_id, subject_kind, subject, access) SELECT id, tree_id, subject_kind, subject, access FROM access ORDER BY rowid");
      db.run("DROP TABLE access");
      db.run("ALTER TABLE access_next RENAME TO access");
      db.run("DELETE FROM meta WHERE key LIKE 'profile:%'");
      for (const [head, facts] of profiles) recordProfileFacts(db, head, facts);
      db.run("DELETE FROM sqlite_sequence WHERE name IN ('accepted_updates', 'accepted_updates_next')");
      db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('accepted_updates', ?)", [nextOrdinal - 1]);
      db.run("UPDATE meta SET value = '18' WHERE key = 'schema_version'");
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`foreign_key_check: ${JSON.stringify(violations.slice(0, 5))}`);
    })();
    db.run("PRAGMA foreign_keys = ON");
    phase("commit", since);
    assertCurrentCanopySchema(db);
    ms.total = Math.round(performance.now() - started);
    return {
      migrated: true,
      from: stamp,
      trees: heads.map((head) => ({ id: head.tree, root: head.root, update: String(head.ordinal) })),
      updates: counts.updates,
      removedUpdates: counts.updates - heads.length,
      removedMergeStates: counts.mergeStates,
      conflictRows: counts.conflictRows,
      authoredChanges: counts.authoredChanges,
      respelledHeads,
      profileRows: counts.profileRows,
      rebuiltProfiles: profiles.size,
      ...summary(),
      nextOrdinal,
      ms,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: run.ts <data-root>"); process.exit(2); }
  const report = await migrateSquashHistory(resolve(root), (event) => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
