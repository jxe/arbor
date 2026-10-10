import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import { stableJSONString } from "@overstory/protocol";
import { createProfileFactsTable, readRootProfile, storedProfileOf, type StoredProfile } from "../../../../packages/canopyd/src/profile.ts";
import { assertHostData, assertCurrentHostSchema } from "../../../../packages/canopyd/src/schema.ts";

/** Schema 20 → 21: profile facts per tree.
 *
 * Schema 20 kept a tree's profile facts in `meta` under `profile:<root>`, one
 * row per accepted person or group root, never deleted: the community gained
 * a row for every edit of its `_index.md`. Schema 21 keeps one
 * `profile_facts` row per tree whose head declares `type: person` or
 * `type: group`, keyed by TreeID, with the head's `_index.md` object and the
 * declared avatar path that decide when an update recomputes it.
 *
 * For every tree, the run reads the head with this build's
 * `readRootProfile` and plans a row when the head declares a type. Every head
 * with a `profile:<head>` row must rebuild exactly that row's facts, and every
 * head that declares a type must have had one; otherwise the run stops with
 * nothing changed. Then it creates `profile_facts`, inserts the rows, deletes
 * every `meta` row whose key starts with `profile:`, and stamps 21.
 *
 * Order: stamp and `quick_check` → read-only rebuild and comparison → one
 * transaction (table, rows, meta cleanup, stamp 21, `foreign_key_check`) →
 * schema and data checks. A crash before the transaction leaves the database
 * unchanged. A rerun reports `migrated: false`.
 *
 * The report names trees, roots, types and object hashes only: no member,
 * display name or description.
 */
export interface MigrationReport {
  migrated: boolean;
  from: string;
  /** Every tree with its unchanged root (as `verify.ts` reads it). */
  trees: Array<{ id: string; root: string; path: string | null; status: string }>;
  /** The rows written: one per tree whose head declares a type. */
  profiles: Array<{ tree: string; type: "person" | "group"; indexHash: string; avatarPath: string | null }>;
  /** `meta` rows deleted: the heads' rows and every historical root's. */
  metaRowsDeleted: number;
  /** Of those, rows that named a root that is no tree's head. */
  historicalRows: number;
  ms: Record<string, number>;
}
type Log = (event: Record<string, unknown>) => void;

/** A head whose rebuilt facts differ from its schema-20 row, or which has a type and no row. */
export class UnmigratableProfileError extends Error {}

export async function migrateProfileFacts(root: string, log: Log = () => {}): Promise<MigrationReport> {
  const started = performance.now();
  const ms: Record<string, number> = {};
  const objects = new ObjectStore(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { readwrite: true, strict: true });
  try {
    const trees = () => db.query(`SELECT t.id, t.ref AS root, b.path, t.status FROM trees t
      LEFT JOIN boundaries b ON b.tree_id = t.id ORDER BY t.id`).all() as MigrationReport["trees"];
    const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    if (stamp === "21") {
      const profiles = (db.query("SELECT tree_id, index_hash, avatar_path, facts FROM profile_facts ORDER BY tree_id").all() as
        Array<{ tree_id: string; index_hash: string; avatar_path: string | null; facts: string }>)
        .map((row) => ({ tree: row.tree_id, type: JSON.parse(row.facts).type, indexHash: row.index_hash, avatarPath: row.avatar_path }));
      return { migrated: false, from: stamp, trees: trees(), profiles, metaRowsDeleted: 0, historicalRows: 0, ms };
    }
    if (stamp !== "20") throw new Error(`Migration 020 requires schema 20, found ${stamp}`);
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);

    let since = performance.now();
    const old = new Map((db.query("SELECT key, value FROM meta WHERE key LIKE 'profile:%'").all() as Array<{ key: string; value: string }>)
      .map(({ key, value }) => [key.slice("profile:".length), value]));
    const planned: Array<{ tree: string; row: StoredProfile }> = [];
    const mismatched: string[] = [];
    const heads = new Set<string>();
    for (const tree of trees()) {
      heads.add(tree.root);
      const row = storedProfileOf(await readRootProfile(tree.root, (hash) => objects.read(hash)));
      const before = old.get(tree.root);
      if (before !== undefined && (!row || stableJSONString(JSON.parse(before)) !== stableJSONString(row.facts))) mismatched.push(`${tree.id}: rebuilt facts differ from profile:${tree.root}`);
      if (row && before === undefined) mismatched.push(`${tree.id}: head declares type ${row.facts.type} but has no profile:${tree.root} row`);
      if (row) planned.push({ tree: tree.id, row });
    }
    if (mismatched.length) throw new UnmigratableProfileError(`Profile facts do not rebuild: ${mismatched.join("; ")}`);
    const historicalRows = [...old.keys()].filter((key) => !heads.has(key)).length;
    log({ event: "rebuilt", trees: heads.size, profiles: planned.length, historicalRows });
    ms.read = Math.round(performance.now() - since);

    since = performance.now();
    let metaRowsDeleted = 0;
    db.transaction(() => {
      createProfileFactsTable(db);
      for (const { tree, row } of planned) {
        db.run("INSERT INTO profile_facts (tree_id, index_hash, avatar_path, facts) VALUES (?, ?, ?, ?)",
          [tree, row.indexHash, row.avatarPath, JSON.stringify(row.facts)]);
      }
      metaRowsDeleted = db.run("DELETE FROM meta WHERE key LIKE 'profile:%'").changes;
      db.run("UPDATE meta SET value = '21' WHERE key = 'schema_version'");
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`foreign_key_check: ${JSON.stringify(violations.slice(0, 5))}`);
    })();
    ms.commit = Math.round(performance.now() - since);
    assertCurrentHostSchema(db);
    assertHostData(db);
    ms.total = Math.round(performance.now() - started);
    return {
      migrated: true,
      from: stamp,
      trees: trees(),
      profiles: planned.map(({ tree, row }) => ({ tree, type: row.facts.type!, indexHash: row.indexHash, avatarPath: row.avatarPath })),
      metaRowsDeleted,
      historicalRows,
      ms,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: run.ts <data-root>"); process.exit(2); }
  const report = await migrateProfileFacts(resolve(root), (event) => console.error(JSON.stringify(event)));
  console.log(JSON.stringify(report));
}
