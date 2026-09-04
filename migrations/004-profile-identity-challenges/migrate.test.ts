import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanopySchema } from "../../packages/canopy/src/schema.ts";
import { migrateCanopyRoot } from "./run.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arbor-migration-004-"));
  await mkdir(join(root, "objects"));
  const db = new Database(join(root, "canopy.sqlite3"), { create: true });
  db.transaction(() => createCanopySchema(db))();
  db.run("DROP TABLE account_challenges");
  db.run("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
  db.close();
  return root;
}

describe("migration 004", () => {
  test("adds only the challenge ledger and is idempotent", async () => {
    const root = await fixture();
    try {
      expect(await migrateCanopyRoot(root)).toMatchObject({ fromSchema: "5", toSchema: "6", alreadyMigrated: false });
      expect(await migrateCanopyRoot(root)).toMatchObject({ fromSchema: "6", toSchema: "6", alreadyMigrated: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses an unknown source stamp", async () => {
    const root = await fixture();
    try {
      const db = new Database(join(root, "canopy.sqlite3"));
      db.run("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
      db.close();
      await expect(migrateCanopyRoot(root)).rejects.toThrow("requires 5");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
