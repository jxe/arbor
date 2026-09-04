import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLocalPlacements } from "@arbor/stores";
import { createCanopySchema } from "../../packages/canopy/src/schema.ts";
import { migrateCanopyRoot } from "./run.ts";
import { migrateLocalHome } from "./local.ts";

const OLD_PROFILE = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_PROFILE = "tr_2pnrfg7hncrmqbeojpqt7qzhcf67ofz3vlqse6aw46sr3kxlvsiq";
const CONFIGURATION = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const DEVICE = "dv_cccccccccccccccccccccccccc";

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

  test("rekeys an offline local home without changing profile content", async () => {
    const parent = await mkdtemp(join(tmpdir(), "arbor-local-migration-004-"));
    const home = join(parent, "home");
    const profile = join(home, "profile");
    const account = join(home, "accounts", CONFIGURATION);
    const state = join(home, ".state");
    const connection = join(state, "accounts", CONFIGURATION);
    const workspaceState = "profile-workspace";
    const backup = join(parent, "backup");
    try {
      await Promise.all([
        mkdir(profile, { recursive: true }),
        mkdir(account, { recursive: true }),
        mkdir(connection, { recursive: true }),
        mkdir(join(state, "refs"), { recursive: true }),
        mkdir(join(state, "sync"), { recursive: true }),
        mkdir(join(state, "workspaces", workspaceState), { recursive: true }),
      ]);
      const canonicalProfile = await realpath(profile);
      const profileSource = "---\ntype: person\n---\n\n# Existing profile\n";
      await writeFile(join(profile, "_index.md"), profileSource);
      await writeFile(join(account, "account.yaml"), `canopy: https://arb.example\nprofile: ${OLD_PROFILE}\n`);
      await writeFile(join(account, "trees.yaml"), [
        "tr_dddddddddddddddddddddddddd:",
        "  canonical: https://arb.example/~joe/todos",
        "  access:",
        "    - subject:",
        "        kind: profile",
        `        tree: ${OLD_PROFILE}`,
        "      access: write",
        "",
      ].join("\n"));
      await writeFile(join(account, "devices.yaml"), `${DEVICE}:\n  label: Test\n  administrator: true\n`);
      await writeFile(join(connection, "connection.json"), `${JSON.stringify({
        configurationTree: CONFIGURATION,
        origin: "https://arb.example",
        account: "https://arb.example/~joe",
        accountID: "ac_eeeeeeeeeeeeeeeeeeeeeeeeee",
        profileTree: OLD_PROFILE,
        deviceID: DEVICE,
        credential: "test/credential",
        tokenDigest: "digest",
        configurationRef: "sha256:old",
        configurationUpdate: "up_old",
        connected: true,
      }, null, 2)}\n`);
      await writeFile(join(home, "placements.yaml"), [
        "tr_ffffffffffffffffffffffffff:",
        `  ${JSON.stringify(canonicalProfile)}: ${OLD_PROFILE}`,
        `${CONFIGURATION}:`,
        `  ${JSON.stringify(join(parent, "todos"))}: tr_dddddddddddddddddddddddddd`,
        "",
      ].join("\n"));
      await writeFile(join(state, "workspaces.json"), `${JSON.stringify({
        [canonicalProfile]: { stateID: workspaceState, rootID: "rt_legacy", path: canonicalProfile },
      }, null, 2)}\n`);
      const cacheTrees = [OLD_PROFILE, CONFIGURATION];
      for (const tree of cacheTrees) {
        await writeFile(join(state, "refs", `${tree}.json`), "{}\n");
        await writeFile(join(state, "sync", `${Buffer.from(tree).toString("base64url")}.json`), "{}\n");
      }
      await writeFile(join(state, "workspaces", workspaceState, "index.sqlite"), "cache");

      const result = await migrateLocalHome({
        dataHome: home,
        configurationTree: CONFIGURATION,
        previous: OLD_PROFILE,
        profileTree: NEW_PROFILE,
        profilePath: canonicalProfile,
        backup,
      });
      expect(result).toMatchObject({ mode: "local-home", alreadyMigrated: false, backup, removedProfilePlacement: true });
      expect(await readFile(join(profile, "_index.md"), "utf8")).toBe(profileSource);
      expect(await readFile(join(backup, "profile", "_index.md"), "utf8")).toBe(profileSource);
      expect(await readFile(join(backup, "accounts", CONFIGURATION, "account.yaml"), "utf8")).toContain(OLD_PROFILE);
      expect(await readFile(join(account, "account.yaml"), "utf8")).toContain(NEW_PROFILE);
      expect(await readFile(join(account, "trees.yaml"), "utf8")).toContain(NEW_PROFILE);
      expect(await readFile(join(account, "trees.yaml"), "utf8")).not.toContain(OLD_PROFILE);
      expect(JSON.parse(await readFile(join(connection, "connection.json"), "utf8"))).toMatchObject({ profileTree: NEW_PROFILE });
      expect(await readFile(join(connection, "connection.json"), "utf8")).not.toContain("configurationRef");
      expect(parseLocalPlacements(await readFile(join(home, "placements.yaml"), "utf8")))
        .toEqual([{ configurationTree: CONFIGURATION, path: join(parent, "todos"), tree: "tr_dddddddddddddddddddddddddd" }]);
      expect(JSON.parse(await readFile(join(state, "workspaces.json"), "utf8"))[canonicalProfile].rootID).toBe(NEW_PROFILE);
      await expect(readFile(join(state, "refs", `${CONFIGURATION}.json`), "utf8")).rejects.toThrow();
      await expect(readFile(join(state, "workspaces", workspaceState, "index.sqlite"), "utf8")).rejects.toThrow();

      const rerun = await migrateLocalHome({
        dataHome: home,
        configurationTree: CONFIGURATION,
        previous: OLD_PROFILE,
        profileTree: NEW_PROFILE,
        profilePath: canonicalProfile,
        backup: join(parent, "unused-backup"),
      });
      expect(rerun).toMatchObject({ alreadyMigrated: true, backup: null, removedProfilePlacement: false });
    } finally {
      await rm(parent, { recursive: true, force: true });
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
