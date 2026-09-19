import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCanopySchema, AUTHORITY_SCHEMA } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { migrateOperationFrames } from "./run.ts";
import type { ObjectHash } from "@arbor/wire";

const basis = `sha256:${"a".repeat(64)}`;
const candidate = `sha256:${"b".repeat(64)}`;
const operations = [{ key: "edit", kind: "editSource", text: "Thursday\n",
  source: { material: { kind: "basis", path: "/note.md", object: basis }, range: [0, 8] } }];

/** A schema-13 database holding one authored change with operations and one
 * with none, so both conversions are exercised. */
function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(`${tmpdir()}/arbor-migration-`), path = `${dir}/state.sqlite`;
  try {
    const db = new Database(path); createCanopySchema(db);
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tree', ?, 1)", [basis]);
    const store = new AcceptedUpdateStore(db);
    const first = store.insert({ tree: "tree", root: basis as ObjectHash, previousRoot: null, kind: "initial", acceptedAt: 1, subject: "device", requestDigest: basis as ObjectHash });
    const second = store.insert({ tree: "tree", root: candidate as ObjectHash, previousRoot: basis as ObjectHash, kind: "accepted", acceptedAt: 2, subject: "device", requestDigest: candidate as ObjectHash });
    db.run("ALTER TABLE authored_changes RENAME COLUMN trace_json TO operations_json");
    db.run("INSERT INTO authored_changes VALUES ('tree','with-ops',?,?,?,?,?)",
      [second.id, basis, candidate, JSON.stringify(operations), JSON.stringify([{ operation: "edit", text: "Thursday\n" }])]);
    db.run("INSERT INTO authored_changes VALUES ('tree','no-ops',?,?,?,?,?)",
      [first.id, basis, basis, "[]", "[]"]);
    db.run("UPDATE meta SET value = '13' WHERE key = 'schema_version'"); db.close(); run(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a flat operation list becomes one frame from its basis to its candidate", () => fixture(path => {
  expect(migrateOperationFrames(path)).toEqual({ migrated: true, rows: 2 });
  const db = new Database(path);
  const rows = db.query("SELECT change_id, trace_json FROM authored_changes ORDER BY change_id").all() as Array<{ change_id: string; trace_json: string }>;
  expect(rows.map(r => r.change_id)).toEqual(["no-ops", "with-ops"]);
  expect(JSON.parse(rows[0]!.trace_json)).toEqual([]);
  expect(JSON.parse(rows[1]!.trace_json)).toEqual([{ before: basis, after: candidate, operations }]);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "14" });
  db.close();
}));

test("migration preserves every other authority row and is idempotent", () => fixture(path => {
  const tables = Object.keys(AUTHORITY_SCHEMA).filter(t => t !== "meta" && t !== "authored_changes");
  let db = new Database(path);
  const before = tables.map(t => db.query(`SELECT * FROM ${t}`).all()); db.close();
  expect(migrateOperationFrames(path).migrated).toBe(true);
  expect(migrateOperationFrames(path)).toEqual({ migrated: false, rows: 0 });
  db = new Database(path);
  expect(tables.map(t => db.query(`SELECT * FROM ${t}`).all())).toEqual(before); db.close();
}));

test("an invalid authority schema rolls back the rename and the stamp", () => fixture(path => {
  let db = new Database(path); db.run("DROP TABLE pairings"); db.close();
  expect(() => migrateOperationFrames(path)).toThrow();
  db = new Database(path);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "13" });
  expect((db.query("PRAGMA table_info(authored_changes)").all() as Array<{ name: string }>).map(c => c.name)).toContain("operations_json");
  db.close();
}));

test("an unknown stamp is refused", () => fixture(path => {
  const db = new Database(path); db.run("UPDATE meta SET value = '12' WHERE key = 'schema_version'"); db.close();
  expect(() => migrateOperationFrames(path)).toThrow("Expected schema 13");
}));
