import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCanopySchema, AUTHORITY_SCHEMA } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { migrateAcceptedConflicts } from "./run.ts";
import type { ObjectHash } from "@arbor/wire";
function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(`${tmpdir()}/arbor-migration-`), path = `${dir}/state.sqlite`;
  try {
    const db = new Database(path); createCanopySchema(db);
    const root = `sha256:${"a".repeat(64)}` as ObjectHash;
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tree', ?, 1)", [root]);
    new AcceptedUpdateStore(db).insert({ tree: "tree", root, previousRoot: null, kind: "initial", acceptedAt: 1, subject: "device", requestDigest: root });
    new AcceptedUpdateStore(db).insert({ tree: "tree", root, previousRoot: root, kind: "accepted", acceptedAt: 2, subject: "device", requestDigest: `sha256:${"b".repeat(64)}`, baseRoot: root, candidateRoot: root,
      sourceIntent: { change: "retained-change", trace: [{ before: root, after: root, operations: [{ key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/note.txt", object: root } }, text: "x" }] }],
        evidence: [{ operation: "edit", path: "/note.txt", source: { object: root, range: [0,1] }, text: "x", lineage: [] }] } });
    db.run("DROP TABLE accepted_conflicts");
    db.run("DROP INDEX accepted_updates_change");
    db.run("ALTER TABLE accepted_updates DROP COLUMN change_id");
    db.run("UPDATE meta SET value = '9' WHERE key = 'schema_version'"); db.close(); run(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("migration preserves all existing authority rows and is idempotent", () => fixture(path => {
  const tables = Object.keys(AUTHORITY_SCHEMA).filter(t => t !== "meta" && t !== "accepted_conflicts");
  let db = new Database(path);
  const before = tables.map(t => db.query(`SELECT * FROM ${t}`).all().map(row => t === "accepted_updates" ? { ...row as object, change_id: (db.query("SELECT change_id FROM authored_changes WHERE accepted_id = ?").get((row as {id:string}).id) as {change_id:string} | null)?.change_id ?? null } : row)); db.close();
  expect(migrateAcceptedConflicts(path)).toEqual({ migrated: true });
  expect(migrateAcceptedConflicts(path)).toEqual({ migrated: false });
  db = new Database(path);
  expect(tables.map(t => db.query(`SELECT * FROM ${t}`).all())).toEqual(before);
  expect(db.query("SELECT * FROM accepted_conflicts").all()).toEqual([]); db.close();
}));
test("invalid authority schema rolls back table creation and stamp", () => fixture(path => {
  let db = new Database(path); db.run("DROP TABLE pairings"); db.close();
  expect(() => migrateAcceptedConflicts(path)).toThrow();
  db = new Database(path);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "9" });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'accepted_conflicts'").get()).toBeNull(); db.close();
}));
test("unknown version is refused", () => fixture(path => {
  const db = new Database(path); db.run("UPDATE meta SET value = 'unknown' WHERE key = 'schema_version'"); db.close();
  expect(() => migrateAcceptedConflicts(path)).toThrow("Expected schema 8 or 9");
}));

test("the deployed schema 8 upgrades directly without resetting accepted history", () => fixture(path => {
  const db = new Database(path);
  const before = db.query("SELECT * FROM accepted_updates").all().map(row => ({ ...row as object, change_id: null }));
  db.run("DROP TABLE authored_changes");
  db.run("UPDATE meta SET value = '8' WHERE key = 'schema_version'"); db.close();
  expect(migrateAcceptedConflicts(path)).toEqual({ migrated: true });
  const upgraded = new Database(path);
  expect(upgraded.query("SELECT * FROM accepted_updates").all()).toEqual(before);
  expect(upgraded.query("SELECT * FROM authored_changes").all()).toEqual([]);
  upgraded.close();
}));
