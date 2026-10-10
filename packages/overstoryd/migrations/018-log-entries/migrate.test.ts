import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHost } from "@overstory/canopyd";
import { ObjectStore } from "@overstory/object-store";
import { ProtocolClient, decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type CandidateUpdate, type ObjectHash } from "@overstory/protocol";
import { AcceptedUpdateStore } from "../../../../packages/canopyd/src/updates/store.ts";
import { MergeHistory } from "../../../../packages/canopyd/src/updates/merge-history.ts";
import { executeExactSourceEdits } from "../../../../tests/support/source-edits.ts";
import { acceptedEntries } from "../../../../tests/support/log-entries.ts";
import { migrateLogEntries, UnconvertibleHistoryError } from "./run.ts";
import { rebuildCheck } from "./rebuild-check.ts";

const token = "migration-018-owner";
const serve = (root: string) => serveHost({ dataRoot: root, accounts: [{ handle: "owner", token, communityWriter: true }], publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
type Running = Awaited<ReturnType<typeof serve>>;
const stop = async (running: Running) => { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); };
const encoder = new TextEncoder();

/** History written by this build in the community tree: a snapshot, a plain
 * traced edit, two concurrent traced edits of one range (a source choice),
 * and two concurrent snapshots of another file (an entry choice), left open
 * at the head. Returns the tree and every accepted update's conflict page. */
async function history(root: string) {
  const running = await serve(root);
  try {
    const client = new ProtocolClient(running.url, token);
    const tree = (await client.account()).account.community.id;
    const head = (await client.descriptor(tree)).tree;
    const objects = new Map((await client.snapshot(tree, head.root)).objects);
    const withFiles = (basis: string, files: Record<string, string>) => {
      const directory = decodeProtocolDirectory(objects.get(basis)!);
      for (const [name, text] of Object.entries(files)) {
        const bytes = encoder.encode(text), file = hashObject(bytes); objects.set(file, bytes);
        directory.entries = [...directory.entries.filter((e) => e.name !== name), { name, file }].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      }
      const bytes = encodeProtocolDirectory(directory), hash = hashObject(bytes); objects.set(hash, bytes);
      return hash;
    };
    const all = () => [...objects].map(([hash, bytes]) => ({ hash, bytes }));
    const snapshot = (basis: string, files: Record<string, string>): CandidateUpdate =>
      ({ change: crypto.randomUUID(), candidate: withFiles(basis, files) as ObjectHash, trace: null, resolves: [], objects: all(), deltas: [] });
    const traced = async (basis: string, text: string, range: [number, number]): Promise<CandidateUpdate> => {
      const file = decodeProtocolDirectory(objects.get(basis)!).entries.find((e) => e.name === "note.md")!.file!;
      const operations = [{ key: "edit", kind: "editSource" as const, source: { material: { kind: "basis" as const, path: "/note.md", object: file }, range }, text }];
      const executed = await executeExactSourceEdits(basis, operations, async (hash) => objects.get(hash)!);
      for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
      return { change: crypto.randomUUID(), candidate: executed.root as ObjectHash, trace: [{ before: basis, after: executed.root, operations }], resolves: [], objects: all(), deltas: [] };
    };
    const submit = async (base: string, update: CandidateUpdate) => (await client.submitUpdates(tree, { base, updates: [update] })).results[0]!.update;
    const first = await submit(head.update, snapshot(head.root, { "note.md": "one two three\n", "asset.bin": "other\0" }));
    const plain = await submit(first.id, await traced(first.root, "ONE", [0, 3]));
    await submit(plain.id, await traced(plain.root, "left", [4, 7]));
    const source = await submit(plain.id, await traced(plain.root, "right", [4, 7]));
    expect(source.conflicted).toBe(true);
    for (const [hash, bytes] of (await client.snapshot(tree, source.root)).objects) objects.set(hash, bytes);
    await submit(source.id, snapshot(source.root, { "asset.bin": "mine\0" }));
    const entry = await submit(source.id, snapshot(source.root, { "asset.bin": "theirs\0" }));
    expect(entry.conflicted).toBe(true);
    const pages = new Map<string, unknown>();
    for (const update of running.canopy.acceptedUpdates(tree)) pages.set(update.id, await client.conflicts(tree, update.id, update.root));
    const kinds = (pages.get(entry.id) as { decisions: Array<{ kind: string }> }).decisions.map((d) => d.kind).sort();
    expect(kinds).toEqual(["content", "entry"]);
    return { tree, pages, head: entry };
  } finally {
    await stop(running);
  }
}

const database = (root: string, readonly = true) => new Database(join(root, "canopy.sqlite3"), readonly ? { readonly: true } : { readwrite: true });

/** Rewrite a root written by this build into the schema-18 layout: no entry
 * column, and a merge-state record per accepted update with the decisions'
 * keys and inspections, the evidence and the request as authored. */
async function toSchema18(root: string) {
  const db = database(root, false);
  const history = new MergeHistory(new AcceptedUpdateStore(db), new ObjectStore(join(root, "objects")));
  try {
    const rows = acceptedEntries(root);
    const records = new Map<string, string>();
    const ids = new Map(rows.map((row) => [row.hash, row.id]));
    for (const row of rows) {
      const previous = row.entry.previous ? ids.get(row.entry.previous) : undefined;
      const prior = previous ? await history.decisions(previous) : [];
      records.set(row.id, JSON.stringify({
        state: `sha256:${"a".repeat(64)}`, authored: `sha256:${"a".repeat(64)}`,
        decisions: (await history.decisions(row.id)).map(({ key, inspection }) => ({ key, inspection })),
        evidence: row.entry.evidence ?? null,
        request: { change: row.entry.change, candidate: row.entry.trace?.at(-1)?.after ?? row.entry.root, trace: row.entry.trace,
          resolves: row.entry.resolves.map((key) => {
            const decision = prior.find((d) => d.key === key)!;
            return { state: previous, conflict: decision.inspection.id, alternatives: decision.inspection.alternatives.map((a) => a.id) };
          }) },
      }));
    }
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      const sequence = (db.query("SELECT seq FROM sqlite_sequence WHERE name = 'accepted_updates'").get() as { seq: number }).seq;
      db.run("CREATE TABLE prior AS SELECT * FROM accepted_updates");
      db.run("DROP TABLE accepted_updates");
      db.run(`CREATE TABLE accepted_updates (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, tree_id TEXT NOT NULL REFERENCES trees(id), root TEXT NOT NULL,
        previous_ordinal INTEGER REFERENCES accepted_updates(ordinal), conflicted INTEGER NOT NULL DEFAULT 0, accepted_at INTEGER NOT NULL,
        subject TEXT, request_digest TEXT, change_id TEXT)`);
      db.run(`INSERT INTO accepted_updates SELECT ordinal, tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id FROM prior ORDER BY ordinal`);
      db.run("DROP TABLE prior");
      db.run("CREATE UNIQUE INDEX accepted_updates_request ON accepted_updates(tree_id, subject, request_digest) WHERE request_digest IS NOT NULL");
      db.run("CREATE UNIQUE INDEX accepted_updates_change ON accepted_updates(tree_id, change_id) WHERE change_id IS NOT NULL");
      db.run("CREATE INDEX accepted_updates_tree ON accepted_updates(tree_id)");
      db.run("CREATE INDEX accepted_updates_root ON accepted_updates(tree_id, root)");
      db.run("DELETE FROM sqlite_sequence WHERE name = 'accepted_updates'");
      db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('accepted_updates', ?)", [sequence + 3]);
      db.run(`CREATE TABLE accepted_merge_states (accepted_id INTEGER PRIMARY KEY REFERENCES accepted_updates(ordinal) ON DELETE RESTRICT, record_json TEXT NOT NULL)`);
      for (const [id, record] of records) db.run("INSERT INTO accepted_merge_states VALUES (?, ?)", [Number(id), record]);
      db.run("UPDATE meta SET value = '18' WHERE key = 'schema_version'");
    })();
  } finally { db.close(); }
}

const stampOf = (root: string) => {
  const db = database(root);
  try { return (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value; } finally { db.close(); }
};

test("every accepted update gets a chained log entry with the same public decisions; it runs once", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-018-`);
  try {
    const { tree, pages, head } = await history(root);
    await toSchema18(root);
    const before = database(root);
    const rows = before.query("SELECT ordinal, tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id FROM accepted_updates ORDER BY ordinal").all();
    before.close();
    const report = await migrateLogEntries(root);
    expect(report).toMatchObject({ migrated: true, from: "18", updates: rows.length, entries: rows.length, unmappedResolutions: 0 });
    expect(report.traced).toBe(3);
    expect(report.openDecisions).toBeGreaterThanOrEqual(2);
    expect(stampOf(root)).toBe("19");
    // Rows are unchanged apart from their entry, and each tree's entries chain in ordinal order.
    const after = database(root);
    try {
      expect(after.query("SELECT ordinal, tree_id, root, previous_ordinal, conflicted, accepted_at, subject, request_digest, change_id FROM accepted_updates ORDER BY ordinal").all()).toEqual(rows);
      expect(after.query("SELECT name FROM sqlite_master WHERE name = 'accepted_merge_states'").get()).toBeNull();
    } finally { after.close(); }
    const entries = acceptedEntries(root);
    const byID = new Map(entries.map((e) => [e.id, e]));
    for (const { entry } of entries) expect(entry.previous === null || entries.some((e) => e.hash === entry.previous)).toBe(true);
    expect(report.trees.find((t) => t.id === tree)).toEqual({ id: tree, root: head.root, update: head.id, entry: byID.get(head.id)!.hash });
    // A cold sidecar rebuilds every head from its chain and keeps it as recorded.
    const rebuilt = await rebuildCheck(root);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.trees.find((t) => t.tree === tree)!.replayed).toBe(entries.filter((e) => e.entry.tree === tree).length);
    // A second run changes nothing.
    expect(await migrateLogEntries(root)).toMatchObject({ migrated: false, from: "19" });
    // This build serves the same conflict pages, audits the history, and accepts the next update after the head.
    const running = await serve(root);
    try {
      const client = new ProtocolClient(running.url, token);
      for (const [id, page] of pages) {
        const update = running.canopy.update(id)!;
        expect(await client.conflicts(tree, id, update.root)).toEqual(page as never);
      }
      await running.canopy.verifyIntegrity();
      const snapshot = await client.snapshot(tree, head.root);
      const directory = decodeProtocolDirectory(snapshot.objects.get(head.root)!);
      const bytes = encoder.encode("after\n"), file = hashObject(bytes);
      directory.entries = [...directory.entries, { name: "after.md", file }].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const encoded = encodeProtocolDirectory(directory), candidate = hashObject(encoded);
      const next = (await client.submitUpdates(tree, { base: head.id, updates: [{ change: crypto.randomUUID(), candidate, trace: null, resolves: [], deltas: [],
        objects: [...snapshot.objects, [file, bytes], [candidate, encoded]].map(([hash, bytes]) => ({ hash: hash as string, bytes: bytes as Uint8Array })) }] })).results[0]!.update;
      expect(next.id).toBe(String(report.nextOrdinal));
      expect(next.previous).toEqual({ id: head.id, root: head.root });
      expect(next.conflicted).toBe(true);
      expect(acceptedEntries(root, tree).at(-1)!.entry.previous).toBe(byID.get(head.id)!.hash);
    } finally { await stop(running); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a stamp other than 18, or an update without a merge state, stops the run with nothing changed", async () => {
  const root = await mkdtemp(`${tmpdir()}/arbor-migration-018-refuse-`);
  try {
    await history(root);
    await expect(migrateLogEntries(root)).resolves.toMatchObject({ migrated: false, from: "19" });
    await toSchema18(root);
    const db = database(root, false);
    db.run("UPDATE meta SET value = '17' WHERE key = 'schema_version'");
    db.close();
    await expect(migrateLogEntries(root)).rejects.toThrow("requires schema 18");
    const again = database(root, false);
    again.run("UPDATE meta SET value = '18' WHERE key = 'schema_version'");
    again.run("DELETE FROM accepted_merge_states WHERE accepted_id = (SELECT MAX(accepted_id) FROM accepted_merge_states)");
    again.close();
    await expect(migrateLogEntries(root)).rejects.toBeInstanceOf(UnconvertibleHistoryError);
    expect(stampOf(root)).toBe("18");
  } finally { await rm(root, { recursive: true, force: true }); }
});
