import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCanopySchema,
  assertCurrentCanopySchema,
} from "../../packages/canopy/src/schema.ts";
import { migrateMergeState } from "./run.ts";

test("schema 11 to 12 preserves all existing rows and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arbor-merge-migration-")),
    path = join(dir, "canopy.sqlite3");
  try {
    const db = new Database(path, { create: true });
    createCanopySchema(db);
    db.run("DROP TABLE accepted_merge_states");
    db.run("UPDATE meta SET value='11' WHERE key='schema_version'");
    db.run("INSERT INTO meta VALUES ('retained-evidence','unchanged')");
    db.close();
    expect(migrateMergeState(path)).toEqual({ migrated: true });
    expect(migrateMergeState(path)).toEqual({ migrated: false });
    const after = new Database(path, { readonly: true });
    assertCurrentCanopySchema(after);
    expect(
      after.query("SELECT value FROM meta WHERE key='retained-evidence'").get()
    ).toEqual({ value: "unchanged" });
    expect(after.query("SELECT * FROM accepted_merge_states").all()).toEqual(
      []
    );
    after.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("invalid source shape fails without advancing the stamp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arbor-merge-migration-")),
    path = join(dir, "canopy.sqlite3");
  try {
    const db = new Database(path, { create: true });
    createCanopySchema(db);
    db.run("DROP TABLE accepted_merge_states");
    db.run("UPDATE meta SET value='11' WHERE key='schema_version'");
    db.run("ALTER TABLE authored_changes ADD COLUMN invalid TEXT");
    db.close();
    expect(() => migrateMergeState(path)).toThrow("Unexpected source schema");
    const after = new Database(path, { readonly: true });
    expect(
      after.query("SELECT value FROM meta WHERE key='schema_version'").get()
    ).toEqual({ value: "11" });
    expect(
      after
        .query(
          "SELECT name FROM sqlite_master WHERE name='accepted_merge_states'"
        )
        .get()
    ).toBeNull();
    after.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
