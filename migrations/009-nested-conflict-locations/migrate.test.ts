import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCanopySchema, AUTHORITY_SCHEMA, assertCanopySchemaVersion } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { migrateNestedConflicts } from "./run.ts";

function fixture(stamp: "8" | "9" | "10", run: (path: string) => void) {
  const dir = mkdtempSync(`${tmpdir()}/arbor-nested-migration-`), path = `${dir}/canopy.sqlite3`;
  try {
    const db = new Database(path); createCanopySchema(db);
    const root = `sha256:${"a".repeat(64)}`;
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tree', ?, 1)", [root]);
    const store = new AcceptedUpdateStore(db);
    store.insert({ tree: "tree", root, previousRoot: null, kind: "initial", acceptedAt: 1, subject: "device", requestDigest: root });
    if (stamp === "10") {
      store.insert({ tree: "tree", root, previousRoot: root, kind: "accepted", acceptedAt: 2, subject: "device",
        change: "retained", requestDigest: `sha256:${"b".repeat(64)}`, conflicts: { resolutions: [], decisions: [{
          id: "decision", name: "note.md", selected: "one", alternatives: [
            { id: "one", revision: "r1", value: { file: root }, contributions: [{ change: "retained", operation: null }] },
            { id: "two", revision: "r2", value: { absent: true }, contributions: [] },
          ],
        }] } });
    } else {
      if (stamp === "9") store.insert({ tree: "tree", root, previousRoot: root, kind: "accepted", acceptedAt: 2,
        subject: "device", requestDigest: `sha256:${"b".repeat(64)}`, baseRoot: root, candidateRoot: root,
        sourceIntent: { change: "source-before-upgrade", operations: [{ key: "edit", kind: "editSource",
          source: { material: { kind: "basis", path: "/note.md", object: root } }, text: "a" }],
          evidence: [{ operation: "edit", path: "/note.md", source: { object: root, range: [0,1] }, text: "a", lineage: [] }] } });
      db.run("DROP TABLE accepted_conflicts");
      db.run("DROP INDEX accepted_updates_change");
      db.run("ALTER TABLE accepted_updates DROP COLUMN change_id");
      if (stamp === "8") db.run("DROP TABLE authored_changes");
    }
    db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [stamp]);
    db.close(); run(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("schema 10 root decisions and all authority rows survive byte-for-byte", () => fixture("10", path => {
  let db = new Database(path);
  const tables = Object.keys(AUTHORITY_SCHEMA).filter(t => t !== "meta");
  const before = tables.map(t => db.query(`SELECT * FROM ${t}`).all());
  expect(() => assertCanopySchemaVersion(db)).toThrow("requires 11"); db.close();
  expect(migrateNestedConflicts(path)).toEqual({ migrated: true });
  expect(migrateNestedConflicts(path)).toEqual({ migrated: false });
  db = new Database(path);
  expect(tables.map(t => db.query(`SELECT * FROM ${t}`).all())).toEqual(before);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "11" });
  db.close();
}));
for (const stamp of ["8", "9"] as const) test(`schema ${stamp} upgrades directly with history intact`, () => fixture(stamp, path => {
  let db = new Database(path);
  const provenance = stamp === "9" ? db.query("SELECT * FROM authored_changes").all() : [];
  const before = db.query("SELECT * FROM accepted_updates").all().map(row => ({ ...row as object,
    change_id: (provenance as Array<{accepted_id: string; change_id: string}>).find(p => p.accepted_id === (row as {id: string}).id)?.change_id ?? null }));
  db.close();
  expect(migrateNestedConflicts(path)).toEqual({ migrated: true });
  db = new Database(path);
  expect(db.query("SELECT * FROM accepted_updates").all()).toEqual(before);
  expect(db.query("SELECT * FROM authored_changes").all()).toEqual(provenance);
  expect(db.query("SELECT * FROM accepted_conflicts").all()).toEqual([]);
  db.close();
}));
test("failed validation rolls back schema and preserves old decisions", () => fixture("10", path => {
  let db = new Database(path);
  const before = db.query("SELECT * FROM accepted_conflicts").all();
  db.run("DROP TABLE pairings"); db.close();
  expect(() => migrateNestedConflicts(path)).toThrow();
  db = new Database(path);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "10" });
  expect(db.query("SELECT * FROM accepted_conflicts").all()).toEqual(before); db.close();
}));
test("unknown versions are refused without mutation", () => fixture("10", path => {
  const db = new Database(path); db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'"); db.close();
  expect(() => migrateNestedConflicts(path)).toThrow("Expected schema 8, 9 or 10");
}));
