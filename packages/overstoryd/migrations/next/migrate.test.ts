import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@ovst/object-store";
import {
  canonicalPageFile, decodeProtocolDirectory, decodeProtocolPage, decodeProtocolRows, decodeProtocolTable, encodeProtocolPage,
  encodeProtocolTable, hashObject, parsePage, CBORTag, type ObjectHash,
} from "@ovst/protocol";
import { encodeCanonicalCBOR } from "@ovst/protocol/cbor";
import { decodeLogEntry } from "@ovst/merge-protocol";
import { createHostSchema } from "../../src/schema.ts";
import { compileLogicalSchema } from "@ovst/collection-schema";
import { convertVerified } from "../../../../tools/convert-usl-to-beetle.ts";
import { HostDaemon } from "@ovst/overstoryd";
import { runBatch } from "../tools/batch.ts";
import { migrateNextBatch, steps } from "./run.ts";

let sandbox: string, schema32: string;
const usl = "main model Event {\n  name Text\n  on Date\n}\n";
// The fingerprint the USL had is the converted Beetle's: the converter checks it.
const fingerprint = compileLogicalSchema(convertVerified(usl)).fingerprint;
const enc = new TextEncoder();

/** A data root as the live host holds it before the flag day: schema 32, and
 * objects without entry times, built by hand since today's code writes only
 * the new format. */
async function legacyRoot(path: string): Promise<void> {
  await mkdir(join(path, "objects"), { recursive: true });
  const store = new ObjectStore(join(path, "objects"));
  const objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> = [];
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.push({ hash, bytes }); return hash; };
  const directory = (entries: object[], extra: object = {}) => put(encodeCanonicalCBOR({ type: "directory", entries, ...extra }));
  const notes = put(enc.encode("---\ntitle: Notes\n---\n\nHello\n"));
  const a1 = put(enc.encode("one")), a2 = put(enc.encode("two")), b = put(enc.encode("bee"));
  const page = put(encodeProtocolPage(parsePage(enc.encode("# MDX\n"))!));
  // Tree t_one: three updates.
  const r1 = directory([
    { name: "a.txt", file: a1 },
    { name: "dir", directory: directory([{ name: "b.txt", file: b }]) },
    { name: "notes.md", file: notes },
  ]);
  const r2 = directory([
    { name: "a.txt", file: a2 },
    { name: "c.txt", file: b },
    { name: "dir", directory: directory([{ name: "keep.txt", file: a1 }]) },
    { name: "notes.md", file: notes },
  ]);
  const r3 = directory([
    { name: "a.txt", file: a2 },
    { name: "c.txt", file: b },
    { name: "notes.md", file: notes },
    { name: "x.mdx", page },
  ]);
  // Tree t_two: a profile with a collection whose rows hold RFC 3339 times and a Date.
  const schema = put(enc.encode(usl));
  const rows = put(encodeCanonicalCBOR({ type: "rows", rows: [
    { key: [["id", "e1"]], fields: { name: "Launch", on: "2026-11-11" }, created: "2026-11-01T10:00:00.000Z", modified: "2026-11-02T10:00:00.000Z" },
  ] }));
  const table = put(encodeProtocolTable({ type: "table", rows: 1, chunks: [{ rows: 1, chunk: rows as `sha256:${string}` }] }));
  const events = directory([{ name: "schema.usl", file: schema }], {
    collection: { version: 1, modelFingerprint: fingerprint, tables: [{ model: "Event", table }] },
  });
  const index = put(enc.encode("---\ntype: person\nname: Two\n---\n\n# Two\n"));
  const two = directory([{ name: "_index.md", file: index }, { name: "events", directory: events }]);

  const access = put(enc.encode("rules: []\n"));
  const config = directory([{ name: "access.yaml", file: access }]);
  await store.store(objects);

  // Today's schema, set back to 32: no devices.clients, and entry_metadata.
  const db = new Database(join(path, "overstoryd.sqlite3"), { create: true });
  createHostSchema(db);
  db.run("ALTER TABLE devices DROP COLUMN clients");
  db.run("CREATE TABLE entry_metadata (tree_id TEXT NOT NULL REFERENCES trees(id), path TEXT NOT NULL, modified_at INTEGER NOT NULL, PRIMARY KEY (tree_id, path)) WITHOUT ROWID");
  db.run("UPDATE meta SET value = '32' WHERE key = 'schema_version'");
  db.run("INSERT INTO trees (id, ref, governs) VALUES ('t_one', ?, NULL), ('t_two', ?, NULL), ('c_one', ?, 't_one'), ('c_two', ?, 't_two')", [r3, two, config, config]);
  db.run("INSERT INTO tree_admins (tree_id, profile_tree) VALUES ('t_one', 'pr_admin'), ('t_two', 'pr_admin')");
  db.run("INSERT INTO boundaries (path, tree_id, parent_tree) VALUES ('/', 't_two', NULL)");
  const entry: string = `sha256:${"1".repeat(64)}`;
  const accept = (tree: string, root: ObjectHash, previous: number | null, at: number, conflicted = 0) =>
    db.run("INSERT INTO accepted_updates (tree_id, root, previous_ordinal, conflicted, accepted_at, entry) VALUES (?, ?, ?, ?, ?, ?)", [tree, root, previous, conflicted, at, entry]);
  accept("t_one", r1, null, 1000);
  accept("t_two", two, null, 1500, 1);
  accept("t_one", r2, 1, 2000);
  accept("t_one", r3, 3, 3000);
  accept("c_one", config, null, 900);
  accept("c_two", config, null, 900);
  db.run("INSERT INTO document_versions (tree_id, stable_key, update_id, entry_path, content_hash, accepted_at) VALUES ('t_one', 'path:/notes.md', 'x', '/notes.md', ?, 500)", [notes]);
  db.run("INSERT INTO entry_metadata (tree_id, path, modified_at) VALUES ('t_two', '/_index.md', 700)");
  db.close();
  for (const stale of ["provenance/v1", "materialized/t_one"]) await mkdir(join(path, stale), { recursive: true });
  await writeFile(join(path, "entry-times.sqlite3"), "");
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-migration-next-"));
  schema32 = join(sandbox, "schema32");
  await legacyRoot(schema32);
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the batch's steps run in order from the live schema", () => {
  const all = steps();
  expect(all.map((step) => step.from)).toEqual([32, 33]);
});

test("each tree starts again at one update holding its head with entry times, pages and row times", async () => {
  const root = join(sandbox, "migrated");
  await cp(schema32, root, { recursive: true });
  const report = await migrateNextBatch(root);
  const roots = Object.fromEntries(report.trees!.map((tree) => [tree.id, tree.root]));
  expect(report).toMatchObject({ migrated: true, from: 32, to: 34, steps: ["033-device-clients", "034-protocol-003"] });
  expect(report.protocol003).toEqual({
    trees: 4, droppedUpdates: 6, converted: { pages: 2, mdx: 1, collections: 1, schemas: 1 }, conflicted: ["t_two"], undated: [],
  });
  expect(report.shortIds!.trees.map((tree) => tree.id)).toEqual(["c_one", "c_two", "t_one", "t_two"]);

  const db = new Database(join(root, "overstoryd.sqlite3"), { readonly: true });
  const store = new ObjectStore(join(root, "objects"));
  const updates = db.query("SELECT tree_id, root, previous_ordinal, conflicted, accepted_at, change_id, entry FROM accepted_updates ORDER BY tree_id").all() as
    Array<{ tree_id: string; root: string; previous_ordinal: null; conflicted: number; accepted_at: number; change_id: string; entry: string }>;
  expect(updates.map((u) => [u.tree_id, u.previous_ordinal, u.conflicted, u.accepted_at, u.change_id])).toEqual([
    ["c_one", null, 0, 900, "protocol-003"], ["c_two", null, 0, 900, "protocol-003"],
    ["t_one", null, 0, 3000, "protocol-003"], ["t_two", null, 0, 1500, "protocol-003"],
  ]);
  for (const update of updates) {
    expect(update.root).toBe(roots[update.tree_id]!);
    expect((db.query("SELECT ref FROM trees WHERE id = ?").get(update.tree_id) as { ref: string }).ref).toBe(update.root);
    const entry = decodeLogEntry(await store.read(update.entry));
    expect(entry).toMatchObject({ tree: update.tree_id, previous: null, root: update.root, trace: null, decisions: [] });
  }

  const one = decodeProtocolDirectory(await store.read(roots.t_one!)).entries;
  const byName = Object.fromEntries(one.map((entry) => [entry.name, entry]));
  // notes.md: a page, dated from document_versions; a.txt changed at 2000;
  // c.txt moved from dir/b.txt, keeping its times; x.mdx is a file now.
  expect(byName["notes.md"]).toMatchObject({ created: 500, modified: 500 });
  expect(byName["notes.md"]!.page).toBeDefined();
  expect(byName["a.txt"]).toMatchObject({ created: 1000, modified: 2000 });
  expect(byName["c.txt"]).toMatchObject({ created: 1000, modified: 1000 });
  expect(byName["x.mdx"]).toMatchObject({ created: 3000, modified: 3000 });
  expect(new TextDecoder().decode(await store.read(byName["x.mdx"]!.file!))).toBe(new TextDecoder().decode(canonicalPageFile(decodeProtocolPage(encodeProtocolPage(parsePage(enc.encode("# MDX\n"))!)))));

  const two = decodeProtocolDirectory(await store.read(roots.t_two!));
  expect(two.entries.find((e) => e.name === "_index.md")).toMatchObject({ created: 700, modified: 700 });
  const events = decodeProtocolDirectory(await store.read(two.entries.find((e) => e.name === "events")!.directory!));
  const table = decodeProtocolTable(await store.read(events.collection!.tables[0]!.table));
  const [row] = decodeProtocolRows(await store.read(table.chunks[0]!.chunk)).rows;
  expect(row).toMatchObject({ created: Date.parse("2026-11-01T10:00:00.000Z"), modified: Date.parse("2026-11-02T10:00:00.000Z") });
  expect(row!.fields.on).toBeInstanceOf(CBORTag);
  expect(events.collection!.modelFingerprint).toBe(fingerprint);
  expect(events.entries.map((e) => e.name)).toEqual(["schema.beetle"]);
  expect(new TextDecoder().decode(await store.read(events.entries[0]!.file!))).toBe(convertVerified(usl));

  expect((db.query("SELECT tree_id, facts FROM profile_facts").all() as Array<{ tree_id: string; facts: string }>).map((r) => [r.tree_id, JSON.parse(r.facts).type])).toEqual([["t_two", "person"]]);
  expect(db.query("SELECT 1 FROM document_versions").all()).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'entry_metadata'").get()).toBeNull();
  db.close();
  for (const stale of ["provenance", "materialized", "entry-times.sqlite3"]) expect(existsSync(join(root, stale))).toBe(false);

  expect(await migrateNextBatch(root)).toEqual({ migrated: false, from: 34, to: 34, steps: [] });

  // Today's build opens the migrated root and serves its heads.
  const host = await HostDaemon.open(root);
  try {
    const snapshot = await host.snapshotForRoot("t_one", roots.t_one! as ObjectHash);
    expect(snapshot?.root).toBe(roots.t_one!);
  } finally { await host[Symbol.asyncDispose](); }
});

test("it refuses, changing nothing, a schema it does not start from", async () => {
  const old = join(sandbox, "old");
  await cp(schema32, old, { recursive: true });
  const stamped = new Database(join(old, "overstoryd.sqlite3"));
  stamped.run("UPDATE meta SET value = '31' WHERE key = 'schema_version'");
  stamped.close();
  expect(() => runBatch(old, steps())).toThrow("found 31");
});
