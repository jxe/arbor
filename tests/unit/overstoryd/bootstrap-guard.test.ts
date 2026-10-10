import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasCommunity, initCommunity, serveCommunity } from "../../../packages/overstoryd/src/cli.ts";

// Rename 001 cutover guard: `canopy.sqlite3` is the database's pre-rename name.
const OLD_DATABASE = "canopy.sqlite3";
const PROFILE = `tr_${"a".repeat(52)}`;

describe("database rename guard", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "overstoryd-bootstrap-guard-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("an empty data root holds no community", async () => {
    expect(await hasCommunity(root)).toBe(false);
  });

  test("a data root with only the old database name is refused, not treated as empty", async () => {
    await writeFile(join(root, OLD_DATABASE), "");
    await expect(hasCommunity(root)).rejects.toThrow(/canopy\.sqlite3 but no overstoryd\.sqlite3.*must be renamed/);
  });

  test("the new database name wins when both files are present", async () => {
    await writeFile(join(root, OLD_DATABASE), "");
    await writeFile(join(root, "overstoryd.sqlite3"), "");
    expect(await hasCommunity(root)).toBe(true);
  });

  test("init and an unattended serve create nothing beside the old database", async () => {
    await writeFile(join(root, OLD_DATABASE), "");
    await expect(initCommunity(["commons", "--founder", `joe=${PROFILE}`, "--data", root])).rejects.toThrow("must be renamed");

    const names = ["OVERSTORYD_COMMUNITY_HANDLE", "OVERSTORYD_FIRST_WRITER_HANDLE", "OVERSTORYD_FIRST_WRITER_PROFILE", "OVERSTORYD_MAINTENANCE", "OVERSTORYD_ACCOUNTS_JSON"] as const;
    const previous = names.map((name) => process.env[name]);
    process.env.OVERSTORYD_COMMUNITY_HANDLE = "commons";
    process.env.OVERSTORYD_FIRST_WRITER_HANDLE = "joe";
    process.env.OVERSTORYD_FIRST_WRITER_PROFILE = PROFILE;
    delete process.env.OVERSTORYD_MAINTENANCE;
    delete process.env.OVERSTORYD_ACCOUNTS_JSON;
    try {
      await expect(serveCommunity([root, "--port", "0", "--hostname", "127.0.0.1"])).rejects.toThrow("must be renamed");
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
    expect(await readdir(root)).toEqual([OLD_DATABASE]);
  });
});
