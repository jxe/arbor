import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient, decodeWireDirectory, encodeWireDirectory, hashObject, type ObjectHash, type WireDirectoryEntry } from "@overstory/protocol";
import { migrateCompactHistory } from "./run.ts";

const token = "migration-015-owner";
const serve = (root: string) => serveCanopy({ dataRoot: root, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });

/** Accepted history written by the schema-17 host: an added page, an edit, a
 * rename without a content change, a binary file, a nested directory added
 * and then removed. Returns the community tree. */
async function history(root: string): Promise<string> {
  const running = await serve(root);
  try {
    const client = new WireClient(running.url, token);
    const tree = (await client.account()).account.community.id;
    let head = (await client.descriptor(tree)).tree;
    const initial = await client.snapshot(tree, head.root);
    const objects = new Map(initial.objects);
    const existing = decodeWireDirectory(objects.get(initial.root)!).entries;
    const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
    const file = (text: string) => put(new TextEncoder().encode(text));
    const dir = (entries: WireDirectoryEntry[]) => put(encodeWireDirectory({ type: "directory", entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
    const submit = async (entries: WireDirectoryEntry[]) => {
      const result = await client.submitUpdate(tree, head.update, { root: dir([...existing, ...entries]), objects });
      head = { ...head, update: result.update.id as typeof head.update, root: result.update.root as typeof head.root };
    };
    const page = "---\nid: pg_trip\n---\nTrip\n", png = file("png");
    const nested = dir([{ name: "_index.md", file: file("Body\n") }, { name: "note.md", file: file("Note\n") }]);
    await submit([{ name: "trip.md", file: file(page) }]);
    await submit([{ name: "trip.md", file: file(page + "More\n") }, { name: "photo.png", file: png }]);
    await submit([{ name: "renamed.md", file: file(page + "More\n") }, { name: "photo.png", file: png }, { name: "folder", directory: nested }]);
    await submit([{ name: "renamed.md", file: file(page + "More\n") }, { name: "photo.png", file: png }]);
    return tree;
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
  }
}

/** Everything the migration must reproduce exactly. */
const snapshot = (root: string) => {
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  try {
    return {
      updates: db.query("SELECT * FROM accepted_updates ORDER BY ordinal").all(),
      trees: db.query("SELECT * FROM trees ORDER BY id").all(),
      entries: db.query("SELECT * FROM entry_metadata ORDER BY tree_id, path").all(),
      // Rowid order is read only within one document: the newest version is its largest rowid.
      versions: db.query("SELECT * FROM document_versions ORDER BY tree_id, stable_key, rowid").all(),
      merges: db.query("SELECT * FROM accepted_merge_states ORDER BY accepted_id").all(),
      accounts: db.query("SELECT * FROM accounts ORDER BY id").all(),
      devices: db.query("SELECT * FROM devices ORDER BY id").all(),
    };
  } finally { db.close(); }
};

/** Rewrite a schema-17 root into the schema-15 layout it was cut over from:
 * the observation log (plus one legacy status row and a sequence that ran
 * ahead), the reflog, full `authored_changes` rows, `accounts.token_digest`
 * (the first device's digest, as account creation wrote it), and (for 15) no
 * entry tables. */
function downgrade(root: string, stamp: "15" | "16", authored: { tree: string; change: string; basis: string; candidate: string } | null = null) {
  const db = new Database(join(root, "canopy.sqlite3"));
  try {
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      const columns = "id, tree_id, root, previous_root, previous_id, conflicted, kind, accepted_at, subject, base_root, candidate_root, remote_root, merge_summary, request_digest, transition_json, change_id";
      db.run(`CREATE TABLE prior AS SELECT ordinal, ${columns} FROM accepted_updates`);
      db.run("DROP TABLE accepted_updates");
      db.run(`CREATE TABLE accepted_updates (
        id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id), root TEXT NOT NULL, previous_root TEXT, previous_id TEXT,
        conflicted INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, accepted_at INTEGER NOT NULL, subject TEXT, base_root TEXT,
        candidate_root TEXT, remote_root TEXT, merge_summary TEXT, request_digest TEXT, transition_json TEXT, change_id TEXT)`);
      db.run(`INSERT INTO accepted_updates (${columns}) SELECT ${columns} FROM prior ORDER BY ordinal`);
      db.run("CREATE UNIQUE INDEX accepted_updates_request ON accepted_updates(tree_id, subject, request_digest) WHERE request_digest IS NOT NULL");
      db.run("CREATE UNIQUE INDEX accepted_updates_change ON accepted_updates(tree_id, change_id) WHERE change_id IS NOT NULL");
      db.run("CREATE INDEX accepted_updates_tree ON accepted_updates(tree_id)");
      db.run(`CREATE TABLE observations (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, cursor TEXT NOT NULL UNIQUE,
        tree_id TEXT NOT NULL REFERENCES trees(id), kind TEXT NOT NULL, update_id TEXT REFERENCES accepted_updates(id),
        change_json TEXT, created_at INTEGER NOT NULL)`);
      db.run("CREATE INDEX observations_tree_order ON observations(tree_id, ordinal)");
      db.run("CREATE INDEX observations_update ON observations(update_id, ordinal)");
      db.run(`INSERT INTO observations (ordinal, cursor, tree_id, kind, update_id, change_json, created_at)
        SELECT ordinal, CAST(ordinal AS TEXT), tree_id, 'tree.update', id, NULL, accepted_at FROM prior`);
      const last = (db.query("SELECT MAX(ordinal) AS n FROM prior").get() as { n: number }).n;
      db.run("INSERT INTO observations (ordinal, cursor, tree_id, kind, update_id, change_json, created_at) SELECT ?, 'legacy-status', tree_id, 'tree.status', NULL, '{}', 1 FROM prior LIMIT 1", [last + 1]);
      db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = 'observations'", [last + 5]);
      db.run("DELETE FROM sqlite_sequence WHERE name = 'accepted_updates'");
      db.run("CREATE TABLE reflog (tree_id TEXT NOT NULL, ref TEXT NOT NULL, previous_ref TEXT, changed_at INTEGER NOT NULL)");
      db.run("INSERT INTO reflog SELECT tree_id, root, previous_root, accepted_at FROM prior ORDER BY ordinal");
      db.run("DROP TABLE prior");
      db.run("DROP TABLE authored_changes");
      db.run(`CREATE TABLE authored_changes (tree_id TEXT NOT NULL REFERENCES trees(id), change_id TEXT NOT NULL,
        accepted_id TEXT NOT NULL UNIQUE REFERENCES accepted_updates(id) ON DELETE RESTRICT, basis_root TEXT NOT NULL,
        candidate_root TEXT NOT NULL, trace_json TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY (tree_id, change_id))`);
      if (authored) {
        const owner = db.query("SELECT id FROM accepted_updates WHERE tree_id = ? AND change_id = ?").get(authored.tree, authored.change) as { id: string };
        db.run("INSERT INTO authored_changes VALUES (?, ?, ?, ?, ?, '[]', '[]')", [authored.tree, authored.change, owner.id, authored.basis, authored.candidate]);
      }
      db.run("CREATE TABLE accounts_prior AS SELECT * FROM accounts");
      db.run("DROP TABLE accounts");
      db.run(`CREATE TABLE accounts (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, profile_tree TEXT, config_tree TEXT,
        token_digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, claim_digest TEXT)`);
      db.run(`INSERT INTO accounts (id, handle, profile_tree, config_tree, token_digest, enabled, claim_digest)
        SELECT a.id, a.handle, a.profile_tree, a.config_tree,
          (SELECT d.token_digest FROM devices d WHERE d.account_id = a.id ORDER BY d.created_at LIMIT 1), a.enabled, a.claim_digest
        FROM accounts_prior a`);
      db.run("DROP TABLE accounts_prior");
      if (stamp === "15") { db.run("DROP TABLE entry_metadata"); db.run("DROP TABLE document_versions"); }
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [stamp]);
    })();
  } finally { db.close(); }
}

/** A retained accepted update with a change identity and authored roots, as the old intent rows named them. */
function authoredOwner(root: string, tree: string) {
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  try {
    return db.query(`SELECT tree_id AS tree, change_id AS change, base_root AS basis, candidate_root AS candidate
      FROM accepted_updates WHERE tree_id = ? AND change_id IS NOT NULL AND base_root IS NOT NULL AND candidate_root IS NOT NULL
      ORDER BY ordinal DESC LIMIT 1`).get(tree) as { tree: string; change: string; basis: string; candidate: string };
  } finally { db.close(); }
}

for (const stamp of ["15", "16"] as const) test(`from schema ${stamp}: history, cursors and authored intent survive exactly, and it runs once`, async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-015-`);
  try {
    const tree = await history(root);
    const live = snapshot(root);
    expect(live.entries.length).toBeGreaterThan(0);
    const owner = authoredOwner(root, tree);
    expect(owner).toBeTruthy();
    const lastOrdinal = (live.updates.at(-1) as { ordinal: number }).ordinal;
    downgrade(root, stamp, owner);

    const report = await migrateCompactHistory(root);
    expect(report).toMatchObject({ migrated: true, from: stamp, updates: live.updates.length, statusObservations: 1,
      respelledCursors: 0, reflogRows: live.updates.length, authoredChanges: 1, nextOrdinal: lastOrdinal + 6, prunedHistory: 0 });
    expect(snapshot(root)).toEqual(live);
    const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    expect(db.query("SELECT * FROM authored_changes").all()).toEqual([{ accepted_id: expect.any(String), trace_json: "[]", evidence_json: "[]" }]);
    for (const table of ["observations", "reflog", "authored_changes_prior", "accepted_updates_next", "accounts_next"])
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)).toBeNull();
    expect((db.query("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain("token_digest");
    db.close();

    const rerun = await migrateCompactHistory(root);
    expect(rerun).toMatchObject({ migrated: false, nextOrdinal: lastOrdinal + 6 });
    expect(snapshot(root)).toEqual(live);

    // The migrated root opens with the current build: an old update cursor is
    // still a replay anchor, the legacy status cursor is not, and the next
    // accepted update takes an ordinal past the old observation sequence.
    const running = await serve(root);
    try {
      const client = new WireClient(running.url, token);
      const descriptor = await client.descriptor(tree);
      expect(descriptor.observedThrough).toBe(String(lastOrdinal));
      const canopy = running.canopy;
      expect(canopy.observationPosition(tree, String(lastOrdinal))).toEqual({ retained: true, through: lastOrdinal });
      expect(canopy.observationPosition(tree, "legacy-status").retained).toBe(false);
      const snapshotted = await client.snapshot(tree, descriptor.tree.root);
      const directory = decodeWireDirectory(snapshotted.objects.get(snapshotted.root)!);
      const bytes = new TextEncoder().encode("after the cutover\n"), file = hashObject(bytes);
      directory.entries.push({ name: "after.md", file });
      directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const encoded = encodeWireDirectory(directory);
      const objects = new Map([...snapshotted.objects, [file, bytes], [hashObject(encoded), encoded]]);
      // `client` authenticated with the device token alone.
      const next = await client.submitUpdate(tree, descriptor.tree.update, { root: hashObject(encoded) as ObjectHash, objects });
      expect(next.update.id).toBe(String(lastOrdinal + 6));
      expect(next.update.previous?.id).toBe(descriptor.tree.update);
    } finally {
      running.server.stop(true); await running.canopy[Symbol.asyncDispose]();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an authored-change copy that disagrees with its accepted update stops the run and changes nothing", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-015-copy-`);
  try {
    const tree = await history(root);
    downgrade(root, "15", { ...authoredOwner(root, tree), candidate: "sha256:" + "0".repeat(64) });
    const before = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    const schema = before.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    before.close();
    await expect(migrateCompactHistory(root)).rejects.toThrow(/authored changes disagree/);
    const after = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    expect((after.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("15");
    expect(after.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an account without a device credential stops the run and leaves schema 15", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-015-deviceless-`);
  try {
    await history(root);
    downgrade(root, "15");
    const db = new Database(join(root, "canopy.sqlite3"));
    db.run("DELETE FROM devices");
    db.close();
    await expect(migrateCompactHistory(root)).rejects.toThrow(/no device credential/);
    const after = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    expect((after.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("15");
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing accepted root stops the run and leaves schema 15", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-015-missing-`);
  try {
    await history(root);
    downgrade(root, "15");
    const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    const current = (db.query("SELECT ref FROM trees ORDER BY rowid DESC LIMIT 1").get() as { ref: ObjectHash }).ref;
    db.close();
    await rm(join(root, "objects", current.slice(7, 9), current.slice(9)));
    await expect(migrateCompactHistory(root)).rejects.toThrow(/missing object/);
    const after = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    expect((after.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("15");
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
