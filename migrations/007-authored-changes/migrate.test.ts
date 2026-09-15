import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCanopySchema, AUTHORITY_SCHEMA } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { migrateAuthoredChanges } from "./run.ts";
import type { ObjectHash } from "@arbor/wire";
function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(`${tmpdir()}/arbor-migration-`), path = `${dir}/state.sqlite`;
  try {
    const db = new Database(path); createCanopySchema(db);
    const root = `sha256:${"a".repeat(64)}` as ObjectHash;
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tree', ?, 1)", [root]);
    new AcceptedUpdateStore(db).insert({ tree: "tree", root, previousRoot: null, kind: "initial", acceptedAt: 1, subject: "device", requestDigest: root });
    db.run("DROP TABLE authored_changes");
    db.run("UPDATE meta SET value = '8' WHERE key = 'schema_version'"); db.close(); run(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("migration preserves all existing authority rows and is idempotent", () => fixture(path => {
  const tables = Object.keys(AUTHORITY_SCHEMA).filter(t => t !== "meta" && t !== "authored_changes");
  let db = new Database(path);
  const before = tables.map(t => db.query(`SELECT * FROM ${t}`).all()); db.close();
  expect(migrateAuthoredChanges(path)).toEqual({ migrated: true });
  expect(migrateAuthoredChanges(path)).toEqual({ migrated: false });
  db = new Database(path);
  expect(tables.map(t => db.query(`SELECT * FROM ${t}`).all())).toEqual(before);
  expect(db.query("SELECT * FROM authored_changes").all()).toEqual([]); db.close();
}));
test("invalid authority schema rolls back table creation and stamp", () => fixture(path => {
  let db = new Database(path); db.run("DROP TABLE pairings"); db.close();
  expect(() => migrateAuthoredChanges(path)).toThrow();
  db = new Database(path);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "8" });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'authored_changes'").get()).toBeNull(); db.close();
}));
test("unknown version is refused", () => fixture(path => {
  const db = new Database(path); db.run("UPDATE meta SET value = 'unknown' WHERE key = 'schema_version'"); db.close();
  expect(() => migrateAuthoredChanges(path)).toThrow("Expected schema 8");
}));
