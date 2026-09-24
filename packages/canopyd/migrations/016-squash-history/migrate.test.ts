import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient, decodeWireDirectory, encodeWireDirectory, hashObject, type CandidateUpdate, type ObjectHash, type WireDirectoryEntry } from "@overstory/protocol";
import { openCanopyDatabase, createCanopySchema } from "../../../../packages/canopyd/src/schema.ts";
import { executeExactSourceEdits } from "../../../../tests/support/source-edits.ts";
import { migrateSquashHistory, UnresolvedDecisionsError } from "./run.ts";
import { replayCheck } from "./replay-check.ts";

const token = "migration-016-owner";
const serve = (root: string) => serveCanopy({ dataRoot: root, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
type Running = Awaited<ReturnType<typeof serve>>;
const stop = async (running: Running) => { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); };
const encoder = new TextEncoder();

/** A long accepted history in the community tree, written by this build: a
 * page added and edited by snapshot and by a traced source edit, a binary
 * file, a nested folder added and removed, and more edits after. With
 * `conflict`, the head is two concurrent snapshots of one file, unresolved.
 * Returns the community tree. */
async function history(root: string, options: { conflict?: boolean } = {}): Promise<string> {
  const running = await serve(root);
  try {
    const client = new WireClient(running.url, token);
    const tree = (await client.account()).account.community.id;
    let head = (await client.descriptor(tree)).tree;
    const initial = await client.snapshot(tree, head.root);
    const objects = new Map(initial.objects);
    const existing = decodeWireDirectory(objects.get(initial.root)!).entries;
    const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
    const file = (text: string) => put(encoder.encode(text));
    const dir = (entries: WireDirectoryEntry[]) => put(encodeWireDirectory({ type: "directory", entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
    const snapshot = (entries: WireDirectoryEntry[]): CandidateUpdate => ({
      change: crypto.randomUUID(), candidate: dir([...existing, ...entries]) as ObjectHash, trace: null, resolves: [], objects: [], deltas: [],
    });
    const submit = async (update: CandidateUpdate, base = head.update) => {
      const result = (await client.submitUpdates(tree, { base, updates: [{ ...update, objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) }] })).results[0]!;
      head = { ...head, update: result.update.id as typeof head.update, root: result.update.root as typeof head.root };
      return result.update;
    };
    const page = "---\nid: pg_trip\n---\nTrip\n", png = file("png");
    const nested = dir([{ name: "_index.md", file: file("Body\n") }, { name: "note.md", file: file("Note\n") }]);
    await submit(snapshot([{ name: "trip.md", file: file(page) }]));
    await submit(snapshot([{ name: "trip.md", file: file(page + "More\n") }, { name: "photo.png", file: png }]));
    // A traced source edit of trip.md: "Trip" becomes "Tour".
    const before = head.root;
    const source = file(page + "More\n"), at = page.indexOf("Trip");
    const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: "/trip.md", object: source }, range: [at, at + 4] as [number, number] }, text: "Tour" }];
    const executed = await executeExactSourceEdits(before, operations, async (hash) => objects.get(hash)!);
    for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
    await submit({ change: crypto.randomUUID(), candidate: executed.root as ObjectHash, trace: [{ before, after: executed.root, operations }], resolves: [], objects: [], deltas: [] });
    const traced = page.replace("Trip", "Tour") + "More\n";
    await submit(snapshot([{ name: "trip.md", file: file(traced) }, { name: "photo.png", file: png }, { name: "folder", directory: nested }]));
    await submit(snapshot([{ name: "trip.md", file: file(traced) }, { name: "photo.png", file: png }]));
    for (let i = 0; i < 4; i++)
      await submit(snapshot([{ name: "trip.md", file: file(traced + `Day ${i}\n`) }, { name: "photo.png", file: png }, { name: `day-${i}.md`, file: file(`Day ${i}\n`) }]));
    if (options.conflict) {
      const base = head.update;
      const day = (i: number) => [{ name: `day-${i}.md`, file: file(`Day ${i}\n`) }];
      const tail = [{ name: "trip.md", file: file(traced + "Day 3\n") }, ...day(3)];
      await submit(snapshot([...tail, { name: "photo.png", file: file("left png") }]), base);
      const conflicted = await submit(snapshot([...tail, { name: "photo.png", file: file("right png") }]), base);
      expect(conflicted.conflicted).toBe(true);
    }
    return tree;
  } finally {
    await stop(running);
  }
}

const database = (root: string, readonly = true) => new Database(join(root, "canopy.sqlite3"), readonly ? { readonly: true } : { readwrite: true });
const stampOf = (root: string) => {
  const db = database(root);
  try { return (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value; } finally { db.close(); }
};

/** Rewrite a root written by this build into the schema-17 layout the
 * deployed build writes, with the legacy rows it retains: ids beside
 * ordinals (one non-decimal), the private reconciliation columns and stored
 * transitions, merge-state records with `retention` (and one row with none),
 * whole-entry conflict rows (one copied forward to the head, resolved),
 * a retained authored trace, entry metadata's `update_id` and `data_json`,
 * the version foreign key, `access.claimed_profile`, profile rows in an
 * older format, and an AUTOINCREMENT sequence that ran ahead.
 * `legacyConflictAtHead` leaves one open whole-entry decision at the head. */
function toSchema17(root: string, tree: string, options: { legacyConflictAtHead?: boolean } = {}) {
  const db = database(root, false);
  try {
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      const sequence = (db.query("SELECT seq FROM sqlite_sequence WHERE name = 'accepted_updates'").get() as { seq: number }).seq;
      db.run(`CREATE TABLE prior AS SELECT u.*, p.root AS previous_root FROM accepted_updates u LEFT JOIN accepted_updates p ON p.ordinal = u.previous_ordinal`);
      db.run("CREATE TABLE prior_states AS SELECT * FROM accepted_merge_states");
      db.run("DROP TABLE accepted_merge_states");
      db.run("DROP TABLE accepted_updates");
      db.run(`CREATE TABLE accepted_updates (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tree_id TEXT NOT NULL REFERENCES trees(id), root TEXT NOT NULL,
        previous_root TEXT, previous_id TEXT, conflicted INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        subject TEXT, base_root TEXT, candidate_root TEXT, remote_root TEXT, merge_summary TEXT, request_digest TEXT, transition_json TEXT, change_id TEXT)`);
      db.run(`INSERT INTO accepted_updates (ordinal, id, tree_id, root, previous_root, previous_id, conflicted, kind, accepted_at, subject,
          base_root, candidate_root, remote_root, merge_summary, request_digest, transition_json, change_id)
        SELECT p.ordinal, CAST(p.ordinal AS TEXT), p.tree_id, p.root, p.previous_root, CAST(p.previous_ordinal AS TEXT), p.conflicted,
          CASE WHEN p.previous_ordinal IS NULL THEN 'initial' ELSE 'accepted' END, p.accepted_at, p.subject,
          p.previous_root, json_extract(s.record_json, '$.request.candidate'), p.previous_root, NULL, p.request_digest,
          CASE WHEN p.previous_ordinal IS NULL THEN NULL ELSE '{"objects":[],"deltas":[]}' END, p.change_id
        FROM prior p LEFT JOIN prior_states s ON s.accepted_id = p.ordinal ORDER BY p.ordinal`);
      db.run("CREATE UNIQUE INDEX accepted_updates_request ON accepted_updates(tree_id, subject, request_digest) WHERE request_digest IS NOT NULL");
      db.run("CREATE UNIQUE INDEX accepted_updates_change ON accepted_updates(tree_id, change_id) WHERE change_id IS NOT NULL");
      db.run("CREATE INDEX accepted_updates_tree ON accepted_updates(tree_id)");
      db.run("CREATE INDEX accepted_updates_root ON accepted_updates(tree_id, root)");
      db.run("DELETE FROM sqlite_sequence WHERE name = 'accepted_updates'");
      db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('accepted_updates', ?)", [sequence + 5]);
      db.run(`CREATE TABLE accepted_merge_states (accepted_id TEXT PRIMARY KEY REFERENCES accepted_updates(id) ON DELETE RESTRICT, record_json TEXT NOT NULL)`);
      const states = db.query("SELECT accepted_id, record_json FROM prior_states ORDER BY accepted_id").all() as Array<{ accepted_id: number; record_json: string }>;
      for (const { accepted_id, record_json } of states) {
        const record = JSON.parse(record_json);
        db.run("INSERT INTO accepted_merge_states VALUES (?, ?)", [String(accepted_id),
          JSON.stringify({ ...record, retention: { version: 1, roots: [...new Set([record.state, record.authored])] } })]);
      }
      db.run("DROP TABLE prior"); db.run("DROP TABLE prior_states");
      const rows = db.query("SELECT ordinal, id, root FROM accepted_updates WHERE tree_id = ? ORDER BY ordinal").all(tree) as Array<{ ordinal: number; id: string; root: string }>;
      const [first, second, third] = rows, head = rows.at(-1)!;
      // An update accepted before every acceptance recorded a merge state, and
      // an old id that is not its ordinal (the row after it names it).
      db.run("DELETE FROM accepted_merge_states WHERE accepted_id = ?", [third!.id]);
      db.run("UPDATE accepted_updates SET id = 'au_legacy' WHERE ordinal = ?", [first!.ordinal]);
      db.run("UPDATE accepted_merge_states SET accepted_id = 'au_legacy' WHERE accepted_id = ?", [first!.id]);
      db.run("UPDATE accepted_updates SET previous_id = 'au_legacy' WHERE ordinal = ?", [second!.ordinal]);
      db.run(`CREATE TABLE accepted_conflicts (accepted_id TEXT PRIMARY KEY REFERENCES accepted_updates(id) ON DELETE RESTRICT, state_json TEXT NOT NULL)`);
      const decision = { id: "legacy-decision", name: "trip.md", selected: "a", alternatives: [
        { id: "a", revision: "r", value: { file: third!.root }, contributions: [] }, { id: "b", revision: "r", value: { absent: true }, contributions: [] }] };
      db.run("INSERT INTO accepted_conflicts VALUES (?, ?)", [second!.id, JSON.stringify({ decisions: [decision], resolutions: [] })]);
      db.run("INSERT INTO accepted_conflicts VALUES (?, ?)", [head.id, JSON.stringify({ decisions: options.legacyConflictAtHead ? [decision] : [], resolutions: [] })]);
      db.run(`CREATE TABLE authored_changes (accepted_id TEXT PRIMARY KEY REFERENCES accepted_updates(id) ON DELETE RESTRICT, trace_json TEXT NOT NULL, evidence_json TEXT NOT NULL)`);
      db.run("INSERT INTO authored_changes VALUES (?, '[]', '[]')", [second!.id]);
      db.run("ALTER TABLE entry_metadata RENAME TO entry_prior");
      db.run(`CREATE TABLE entry_metadata (tree_id TEXT NOT NULL REFERENCES trees(id), path TEXT NOT NULL, modified_at INTEGER NOT NULL,
        update_id TEXT NOT NULL, data_json TEXT, PRIMARY KEY (tree_id, path)) WITHOUT ROWID`);
      db.run(`INSERT INTO entry_metadata SELECT e.tree_id, e.path, e.modified_at,
        (SELECT MAX(ordinal) FROM accepted_updates u WHERE u.tree_id = e.tree_id), NULL FROM entry_prior e`);
      db.run("DROP TABLE entry_prior");
      db.run("DROP INDEX document_versions_key");
      db.run("ALTER TABLE document_versions RENAME TO versions_prior");
      db.run(`CREATE TABLE document_versions (tree_id TEXT NOT NULL REFERENCES trees(id), stable_key TEXT NOT NULL,
        update_id TEXT NOT NULL REFERENCES accepted_updates(id), entry_path TEXT NOT NULL, content_hash TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        UNIQUE (tree_id, stable_key, update_id, entry_path))`);
      db.run("CREATE INDEX document_versions_key ON document_versions(tree_id, stable_key)");
      db.run("INSERT INTO document_versions (rowid, tree_id, stable_key, update_id, entry_path, content_hash, accepted_at) SELECT rowid, * FROM versions_prior ORDER BY rowid");
      db.run("DROP TABLE versions_prior");
      db.run("UPDATE document_versions SET update_id = 'au_legacy' WHERE update_id = ?", [first!.id]);
      db.run("ALTER TABLE access ADD COLUMN claimed_profile TEXT");
      // Profile rows for roots that are no longer anyone's head, in the
      // pre-version-3 format; and one current head's row missing.
      db.run(`INSERT INTO meta (key, value) VALUES ('profile:sha256:${"0".repeat(64)}', '{"type":"group","members":["https://example.test/~a"]}')`);
      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('profile:${second!.root}', '{"type":"group","members":["https://example.test/~owner"]}')`);
      db.run("DELETE FROM meta WHERE key = (SELECT 'profile:' || ref FROM trees WHERE id = ?)", [tree]);
      db.run("UPDATE meta SET value = '17' WHERE key = 'schema_version'");
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`fixture foreign keys: ${JSON.stringify(violations)}`);
    })();
  } finally { db.close(); }
}

/** Everything the migration keeps, as schema 17 holds it. */
function kept(root: string) {
  const db = database(root);
  try {
    return {
      heads: db.query(`SELECT u.ordinal, u.tree_id, u.root, u.accepted_at, u.subject, u.request_digest, u.change_id FROM accepted_updates u
        WHERE u.ordinal = (SELECT MAX(ordinal) FROM accepted_updates WHERE tree_id = u.tree_id) ORDER BY u.ordinal`).all(),
      trees: db.query("SELECT * FROM trees ORDER BY id").all(),
      entries: db.query("SELECT tree_id, path, modified_at FROM entry_metadata ORDER BY tree_id, path").all(),
      versions: db.query("SELECT rowid, tree_id, stable_key, update_id, entry_path, content_hash, accepted_at FROM document_versions ORDER BY rowid").all(),
      access: db.query("SELECT id, tree_id, subject_kind, subject, access FROM access ORDER BY id").all(),
      accounts: db.query("SELECT * FROM accounts ORDER BY id").all(),
      devices: db.query("SELECT * FROM devices ORDER BY id").all(),
    };
  } finally { db.close(); }
}

/** The schema as SQL text, table and index names normalized. */
function schemaOf(db: Database) {
  return (db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ type: string; name: string; sql: string | null }>)
    .map(({ type, name, sql }) => ({ type, name, sql: sql?.replace(/"/g, "").replace(/\s+/g, " ").replace(/IF NOT EXISTS /g, "").trim() ?? null }));
}

test("squashes history to each head: roots, refs, ids, dates and versions survive; everything else goes; it runs once", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-016-`);
  try {
    const tree = await history(root);
    toSchema17(root, tree);
    const before = kept(root);
    const counts = (() => {
      const db = database(root);
      try {
        return {
          updates: (db.query("SELECT COUNT(*) AS n FROM accepted_updates").get() as { n: number }).n,
          sequence: (db.query("SELECT seq FROM sqlite_sequence WHERE name = 'accepted_updates'").get() as { seq: number }).seq,
          versions: (db.query("SELECT COUNT(*) AS n FROM document_versions").get() as { n: number }).n,
        };
      } finally { db.close(); }
    })();
    expect(before.heads.length).toBe(before.trees.length);
    expect(counts.updates).toBeGreaterThan(before.heads.length + 8);
    expect(counts.versions).toBeGreaterThan(2);

    const report = await migrateSquashHistory(root);
    expect(report).toMatchObject({
      migrated: true, from: "17", updates: counts.updates, removedUpdates: counts.updates - before.heads.length,
      conflictRows: 2, authoredChanges: 1, respelledHeads: 0, nextOrdinal: counts.sequence + 1, documentVersions: counts.versions,
    });
    expect(report.trees).toEqual((before.trees as Array<{ id: string; ref: string }>).map((t) => ({ id: t.id, root: t.ref,
      update: String((before.heads as Array<{ tree_id: string; ordinal: number }>).find((h) => h.tree_id === t.id)!.ordinal) })));

    const db = database(root);
    try {
      // Heads keep their ordinal (the wire id), root and receipt columns; nothing else remains.
      expect(db.query("SELECT ordinal, tree_id, root, accepted_at, subject, request_digest, change_id FROM accepted_updates ORDER BY ordinal").all()).toEqual(before.heads);
      expect(db.query("SELECT COUNT(*) AS n FROM accepted_updates WHERE previous_ordinal IS NOT NULL OR conflicted != 0").get()).toEqual({ n: 0 });
      expect(db.query("SELECT * FROM trees ORDER BY id").all()).toEqual(before.trees);
      expect(db.query("SELECT * FROM entry_metadata ORDER BY tree_id, path").all()).toEqual(before.entries);
      expect(db.query("SELECT rowid, * FROM document_versions ORDER BY rowid").all()).toEqual(before.versions);
      expect(db.query("SELECT * FROM access ORDER BY id").all()).toEqual(before.access);
      expect(db.query("SELECT * FROM accounts ORDER BY id").all()).toEqual(before.accounts);
      expect(db.query("SELECT * FROM devices ORDER BY id").all()).toEqual(before.devices);
      for (const table of ["authored_changes", "accepted_conflicts", "accepted_updates_next", "entry_metadata_prior", "document_versions_prior", "access_next"])
        expect(db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)).toBeNull();
      // One fresh, editable, history-free merge state per head.
      const states = db.query("SELECT u.tree_id, m.record_json FROM accepted_merge_states m JOIN accepted_updates u ON u.ordinal = m.accepted_id").all() as Array<{ tree_id: string; record_json: string }>;
      expect(states.map((s) => s.tree_id).sort()).toEqual((before.trees as Array<{ id: string }>).map((t) => t.id).sort());
      for (const state of states) {
        const record = JSON.parse(state.record_json);
        expect(record).toMatchObject({ decisions: [], evidence: null, request: { change: `initial:${state.tree_id}`, trace: null, resolves: [] } });
        expect(record.retention).toBeUndefined();
        expect(record.state).toBe(record.authored);
      }
      // Profile rows exist exactly for the current person and group heads:
      // the community and owner profile trees, not the configuration tree.
      const profiles = (db.query("SELECT key FROM meta WHERE key LIKE 'profile:%' ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);
      expect(profiles).toEqual((before.trees as Array<{ ref: string; policy: string }>).filter((t) => t.policy === "ordinary").map((t) => `profile:${t.ref}`).sort());
      expect(report.rebuiltProfiles).toBe(profiles.length);
      // The migrated schema is the one this build creates.
      const fresh = new Database(":memory:");
      createCanopySchema(fresh);
      expect(schemaOf(db)).toEqual(schemaOf(fresh));
      fresh.close();
    } finally { db.close(); }

    const rerun = await migrateSquashHistory(root);
    expect(rerun).toMatchObject({ migrated: false, from: "18", trees: report.trees, nextOrdinal: report.nextOrdinal });

    // This build opens the migrated root and serves its heads.
    const opened = openCanopyDatabase(join(root, "canopy.sqlite3"));
    expect((opened.query("SELECT id, ref FROM trees ORDER BY id").all() as Array<{ id: string; ref: string }>)).toEqual(
      report.trees.map((t) => ({ id: t.id, ref: t.root })));
    opened.close();
    const running = await serve(root);
    try {
      const client = new WireClient(running.url, token);
      const head = report.trees.find((t) => t.id === tree)!;
      const descriptor = await client.descriptor(tree);
      expect(descriptor.tree).toMatchObject({ update: head.update, root: head.root, conflicted: false });
      expect(descriptor.observedThrough).toBe(head.update);
      expect((await client.conflicts(tree, head.update, head.root)).decisions).toEqual([]);
      const entries = running.canopy.entryMetadata(tree)!;
      expect(Object.keys(entries.entries).sort()).toEqual((before.entries as Array<{ tree_id: string; path: string }>).filter((e) => e.tree_id === tree).map((e) => e.path).sort());
      // A new update on top: the next ordinal, with the head as its predecessor.
      const snapshotted = await client.snapshot(tree, head.root);
      const directory = decodeWireDirectory(snapshotted.objects.get(snapshotted.root)!);
      const bytes = encoder.encode("after the squash\n"), file = hashObject(bytes);
      directory.entries.push({ name: "after.md", file });
      directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const encoded = encodeWireDirectory(directory);
      const next = await client.submitUpdate(tree, head.update, { root: hashObject(encoded) as ObjectHash, objects: new Map([...snapshotted.objects, [file, bytes], [hashObject(encoded), encoded]]) });
      expect(next.outcome).toBe("accepted");
      expect(next.update.id).toBe(String(report.nextOrdinal));
      expect(next.update.previous).toEqual({ id: head.update, root: head.root });
      // A base that the squash removed is not retained.
      await expect(client.submitUpdate(tree, String(Number(head.update) - 1), { root: hashObject(encoded) as ObjectHash, objects: new Map() })).rejects.toThrow(/not retained/);
      await running.canopy.verifyIntegrity();
    } finally { await stop(running); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

for (const [name, conflict, legacyConflictAtHead] of [
  ["an open merge-state decision at a head", true, false],
  ["an open legacy conflict row at a head", false, true],
] as const) test(`${name} stops the run and changes nothing`, async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-016-open-`);
  try {
    const tree = await history(root, { conflict });
    toSchema17(root, tree, { legacyConflictAtHead });
    const db = database(root);
    const schema = db.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    const updates = db.query("SELECT COUNT(*) AS n FROM accepted_updates").get();
    db.close();
    await expect(migrateSquashHistory(root)).rejects.toBeInstanceOf(UnresolvedDecisionsError);
    await expect(migrateSquashHistory(root)).rejects.toThrow(/unresolved decisions at their head; resolve them in Canopy first: \/ \(/);
    expect(stampOf(root)).toBe("17");
    const after = database(root);
    expect(after.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(after.query("SELECT COUNT(*) AS n FROM accepted_updates").get()).toEqual(updates);
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("any stamp but 17 or 18 is refused", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-016-stamp-`);
  try {
    const tree = await history(root);
    toSchema17(root, tree);
    const db = database(root, false);
    db.run("UPDATE meta SET value = '16' WHERE key = 'schema_version'");
    db.close();
    await expect(migrateSquashHistory(root)).rejects.toThrow("Migration 016 requires schema 17, found 16");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the replay check re-accepts a pre-migration window through this build and reports a mismatch", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-016-replay-`);
  try {
    const tree = await history(root);
    toSchema17(root, tree);
    // The window includes the traced source edit.
    const report = await replayCheck(root, { last: 7, tree });
    expect(report.ok).toBe(true);
    expect(report.trees).toHaveLength(1);
    expect(report.trees[0]).toMatchObject({ id: tree, path: "/", replayed: 7, traced: 1, matched: 7, mismatches: [], skipped: [] });
    // The source copy is untouched.
    expect(stampOf(root)).toBe("17");
    // A recorded flag this build does not reproduce is a mismatch.
    const db = database(root, false);
    const last = db.query("SELECT id FROM accepted_updates WHERE tree_id = ? ORDER BY ordinal DESC LIMIT 1").get(tree) as { id: string };
    db.run("UPDATE accepted_updates SET conflicted = 1 WHERE id = ?", [last.id]);
    db.close();
    const tampered = await replayCheck(root, { last: 3, tree });
    expect(tampered.ok).toBe(false);
    expect(tampered.trees[0]!.mismatches).toEqual([{ update: last.id, expected: { root: expect.any(String), conflicted: true },
      actual: { root: expect.any(String), conflicted: false } }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
