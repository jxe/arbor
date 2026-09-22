import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import type { ObjectHash } from "@overstory/protocol";
import { EntryMetadataStore, entryChanges, type EntryChanges } from "../../../../packages/canopyd/src/updates/entry-metadata.ts";
import { assertCurrentCanopySchema } from "../../../../packages/canopyd/src/schema.ts";

/** Schema 15 → 16: entry metadata and the document-version index (canopyd 013).
 *
 * Creates `entry_metadata` and `document_versions` and fills both by replaying
 * each tree's accepted updates in order, diffing every update's previous root
 * against its root exactly as canopyd now does inside each accepted
 * transaction. Nothing existing is rewritten: tree roots, accepted updates,
 * objects, observations and merge states are untouched.
 *
 * Order: stamp and `quick_check` → read every accepted update's changes (async
 * object reads) → one transaction (tables, rows, stamp 16) → schema check. A
 * crash before the transaction leaves schema 15 unchanged; a rerun after it
 * reports `migrated: false`. A missing accepted root stops the run: the index
 * never invents continuity. */
export interface MigrationReport {
  migrated: boolean;
  /** Every tree's current root; unchanged by this migration, listed for `verify.ts`. */
  trees: Array<{ id: string; root: string }>;
  updates: number;
  entries: number;
  documentVersions: number;
  documents: number;
  /** Trees whose earliest retained update has a pruned predecessor. */
  prunedHistory: number;
  ms: Record<string, number>;
}
type Log = (event: Record<string, unknown>) => void;

export async function migrateEntryMetadata(root: string, log: Log = () => {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const phase = (name: string, since: number) => { ms[name] = Math.round(performance.now() - since); };
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  try {
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    const trees = db.query("SELECT id, ref AS root FROM trees ORDER BY id").all() as Array<{ id: string; root: string }>;
    const counts = () => ({
      entries: (db.query("SELECT COUNT(*) AS n FROM entry_metadata").get() as { n: number }).n,
      documentVersions: (db.query("SELECT COUNT(*) AS n FROM document_versions").get() as { n: number }).n,
      documents: (db.query("SELECT COUNT(DISTINCT tree_id || ' ' || stable_key) AS n FROM document_versions").get() as { n: number }).n,
    });
    const updates = (db.query("SELECT COUNT(*) AS n FROM accepted_updates").get() as { n: number }).n;
    if (stamp === "16") return { migrated: false, trees, updates, ...counts(), prunedHistory: 0, ms };
    if (stamp !== "15") throw new Error(`Migration 014 requires schema 15, found ${stamp}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);

    // Accepted order within a tree is insertion order (rowid), as `current()` reads it.
    let since = performance.now();
    const rows = db.query(
      "SELECT id, tree_id, root, previous_root, accepted_at FROM accepted_updates ORDER BY tree_id, rowid",
    ).all() as Array<{ id: string; tree_id: string; root: ObjectHash; previous_root: ObjectHash | null; accepted_at: number }>;
    const load = async (hash: ObjectHash) => {
      try { return await objects.read(hash); }
      catch { throw new Error(`Accepted history is missing object ${hash}; stopping rather than inventing continuity`); }
    };
    const planned: Array<{ tree: string; update: string; acceptedAt: number; changes: EntryChanges }> = [];
    let previousTree: string | null = null, previousRoot: ObjectHash | null = null, boundaries = 0;
    for (const [index, row] of rows.entries()) {
      // A tree's earliest retained update is its history boundary: every file
      // it holds is dated there, whether or not older updates were pruned.
      const first = row.tree_id !== previousTree;
      if (first) { previousTree = row.tree_id; if (row.previous_root !== null) boundaries++; }
      // Past the boundary each row names its predecessor's root.
      else if (row.previous_root !== previousRoot) throw new Error(`Accepted chain of ${row.tree_id} breaks at ${row.id}`);
      planned.push({ tree: row.tree_id, update: row.id, acceptedAt: row.accepted_at,
        changes: await entryChanges(first ? null : row.previous_root, row.root, load) });
      previousRoot = row.root;
      if ((index + 1) % 200 === 0) log({ event: "replay", done: index + 1, total: rows.length });
    }
    phase("replay", since);

    since = performance.now();
    db.transaction(() => {
      EntryMetadataStore.createSchema(db);
      const store = new EntryMetadataStore(db);
      for (const update of planned) store.apply(update.tree, update.update, update.acceptedAt, update.changes);
      db.run("UPDATE meta SET value = '16' WHERE key = 'schema_version'");
    })();
    phase("commit", since);
    assertCurrentCanopySchema(db);
    ms.total = Math.round(performance.now() - started);
    return { migrated: true, trees, updates: rows.length, ...counts(), prunedHistory: boundaries, ms };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: run.ts <data-root>"); process.exit(2); }
  const report = await migrateEntryMetadata(resolve(root), (event) => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
