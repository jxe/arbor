import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@arbor/core";
import { loadTreeRegistry, parseCanopyAccountConfiguration, parseHostedTreesConfiguration, parseLocalPlacements } from "@arbor/stores";
import { CanopyDaemon } from "@arbor/canopy";
import { migrateCanopyRoot, migrateLocalHome, type SecretStore } from "./run.ts";

const roots: string[] = [];
const origin = "https://canopy.test";
const profileTree = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const configurationTree = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const communityTree = "tr_cccccccccccccccccccccccccc";
const otherTree = "tr_dddddddddddddddddddddddddd";
const macDevice = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const phoneDevice = "dv_bbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

class MemorySecrets implements SecretStore {
  values = new Map<string, string>();
  key(location: { service: string; name: string }) { return `${location.service}/${location.name}`; }
  async get(location: { service: string; name: string }) { return this.values.get(this.key(location)) ?? null; }
  async set(location: { service: string; name: string; value: string }) { this.values.set(this.key(location), location.value); }
}

async function schema4Canopy(): Promise<{ root: string; configurationTree: string; profileTree: string }> {
  const root = await temporary("arbor-migration-003-canopy-");
  const daemon = await CanopyDaemon.open(root, {
    handle: "community",
    name: "Community",
    accounts: [
      { handle: "owner", token: "owner-token", communityWriter: true },
      { handle: "ada", token: "ada-token" },
    ],
  });
  daemon.setCommunityHost("canopy.test", true);
  await daemon.ensureAccountConfigTrees(origin);
  const account = daemon.accountByHandle("owner")!;
  await daemon[Symbol.asyncDispose]();
  const db = new Database(join(root, "canopy.sqlite3"));
  db.run("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
  db.close();
  return { root, configurationTree: account.configTree!, profileTree: account.profileTree! };
}

async function singletonHome(options: { stamp?: string; mixed?: boolean; credential?: boolean } = {}) {
  const parent = await temporary("arbor-migration-003-home-");
  const home = join(parent, "dot-arbor");
  const backup = join(parent, "backup");
  const secrets = new MemorySecrets();
  const token = "fixture-account-token";
  await mkdir(join(home, "devices"), { recursive: true });
  await mkdir(join(home, ".state", "system"), { recursive: true });
  await mkdir(join(home, "profile"), { recursive: true });
  await mkdir(join(home, "notes"), { recursive: true });
  await writeFile(join(home, "profile", "_index.md"), "---\ntype: person\n---\n\n# Ada\n");
  await writeFile(join(home, "notes", "one.md"), "# One\n");
  await writeFile(join(home, "account.yaml"), [
    "version: 1", `community: ${origin}`, "profile:", "  handle: ada", `  tree: ${profileTree}`,
    "admins:", `  - ${macDevice}`, "",
  ].join("\n"));
  await writeFile(join(home, "trees.yaml"), [
    "version: 1", "trees:", `  ${profileTree}:`, "    canonicalPath: /~ada", "    access:",
    "      - subject:", "          kind: everyone", "        access: read",
    `  ${otherTree}:`, "    canonicalPath: /~ada/notes", "    access:",
    "      - subject:", "          kind: profile", `          tree: ${profileTree}`, "        access: write", "",
  ].join("\n"));
  await writeFile(join(home, "devices", `${macDevice}.yaml`), [
    "version: 1", "label: Mac", "placements:", `  ${profileTree}:`, `    path: ${join(home, "profile")}`,
    `    server: ${origin}`, `  ${otherTree}:`, `    path: ${join(home, "notes")}`, `    server: ${origin}`, "",
  ].join("\n"));
  await writeFile(join(home, "devices", `${phoneDevice}.yaml`), "version: 1\nlabel: iPhone\nplacements: {}\n");
  await writeFile(join(home, ".state", "version"), `${options.stamp ?? "3"}\n`);
  await writeFile(join(home, ".state", "device.json"), `${JSON.stringify({ id: macDevice })}\n`);
  await writeFile(join(home, ".state", "system", "community.md"), [
    "---", `origin: ${JSON.stringify(origin)}`, 'id: "ac_aaaaaaaaaaaaaaaaaaaaaaaaaa"', 'handle: "ada"',
    `profileTree: ${JSON.stringify(profileTree)}`, `communityTree: ${JSON.stringify(communityTree)}`,
    'communityURL: "arbor://canopy.test/"', `configurationTree: ${JSON.stringify(configurationTree)}`,
    'configurationRef: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    'configurationUpdate: "up_aaaaaaaaaaaaaaaaaaaaaaaaaa"', 'credential: "fixture/old"',
    `tokenDigest: ${JSON.stringify(sha256(token))}`, "connected: true", "---", "", "# Community account", "",
  ].join("\n"));
  if (options.credential !== false) secrets.values.set("fixture/old", token);
  if (options.mixed) await mkdir(join(home, "accounts"));
  return { home, backup, secrets };
}

describe("migration 003 Canopy root", () => {
  test("converts every v1 account tree to v2, stamps 5, reopens, and reruns exactly", async () => {
    const fixture = await schema4Canopy();
    const report = await migrateCanopyRoot(fixture.root);
    expect(report).toMatchObject({ mode: "canopy-root", fromSchema: "4", toSchema: "5", alreadyMigrated: false });
    expect(report.accounts).toHaveLength(2);
    const owner = report.accounts.find((account) => account.configurationTree === fixture.configurationTree)!;
    expect(owner).toMatchObject({ configurationTree: fixture.configurationTree, profileTree: fixture.profileTree });
    expect(owner.root).not.toBe(owner.previousRoot);
    const db = new Database(join(fixture.root, "canopy.sqlite3"), { readonly: true });
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "5" });
    expect(db.query("SELECT policy FROM trees WHERE id = ?").get(fixture.configurationTree)).toEqual({ policy: "account-config-v2" });
    expect(db.query("SELECT kind, root FROM accepted_updates WHERE tree_id = ?").all(fixture.configurationTree))
      .toEqual([{ kind: "restored", root: owner.root }]);
    db.close();
    const rerun = await migrateCanopyRoot(fixture.root);
    expect(rerun).toMatchObject({ alreadyMigrated: true, fromSchema: "5", toSchema: "5" });
    expect(rerun.accounts.find((account) => account.configurationTree === fixture.configurationTree)!.root).toBe(owner.root);
  });

  test("refuses mismatched credential/device policy without changing stamp", async () => {
    const fixture = await schema4Canopy();
    const db = new Database(join(fixture.root, "canopy.sqlite3"));
    db.run("UPDATE devices SET label = 'Different' WHERE account_id = (SELECT id FROM accounts LIMIT 1)");
    db.close();
    await expect(migrateCanopyRoot(fixture.root)).rejects.toThrow("active devices do not match");
    const reopened = new Database(join(fixture.root, "canopy.sqlite3"), { readonly: true });
    expect(reopened.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "4" });
    reopened.close();
  });
});

describe("migration 003 local data home", () => {
  test("backs up and atomically converts the singleton graph and only current-device placements", async () => {
    const fixture = await singletonHome();
    const report = await migrateLocalHome(fixture.home, fixture.backup, fixture.secrets);
    expect(report).toMatchObject({
      mode: "local-home", fromLayout: "singleton-v1", toLayout: "accounts-v2", alreadyMigrated: false,
      configurationTree, profileTree, currentDevice: macDevice, placements: 2,
    });
    expect(report.backupChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await readdir(fixture.home)).toContain("accounts");
    await expect(readFile(join(fixture.home, "account.yaml"), "utf8")).rejects.toThrow();
    expect(await readFile(join(fixture.backup, "account.yaml"), "utf8")).toContain("version: 1");
    expect(await readFile(join(fixture.home, ".state", "version"), "utf8")).toBe("4\n");
    expect(await readFile(join(fixture.home, "notes", "one.md"), "utf8")).toBe("# One\n");
    const checkout = join(fixture.home, "accounts", configurationTree);
    const account = parseCanopyAccountConfiguration(await readFile(join(checkout, "account.yaml"), "utf8"));
    const trees = parseHostedTreesConfiguration(await readFile(join(checkout, "trees.yaml"), "utf8"), account);
    expect(account).toEqual({ canopy: origin, profile: profileTree });
    expect(trees[otherTree]!.canonical).toBe(`${origin}/~ada/notes`);
    const placements = parseLocalPlacements(await readFile(join(fixture.home, "placements.yaml"), "utf8"));
    expect(placements.map(({ configurationTree: config, tree }) => ({ config, tree }))).toEqual([
      { config: configurationTree, tree: otherTree }, { config: configurationTree, tree: profileTree },
    ]);
    const rerun = await migrateLocalHome(fixture.home, join(fixture.home, "unused"), fixture.secrets);
    expect(rerun).toMatchObject({ alreadyMigrated: true, placements: 2 });
    const previousHome = process.env.ARBOR_DATA_HOME;
    const previousGuard = process.env.ARBOR_REQUIRE_DATA_HOME;
    process.env.ARBOR_DATA_HOME = fixture.home;
    process.env.ARBOR_REQUIRE_DATA_HOME = "1";
    try {
      const restarted = await loadTreeRegistry();
      expect(restarted.plural).toBe(true);
      expect(restarted.placements.map((placement) => placement.tree).sort()).toEqual([
        configurationTree, otherTree, profileTree,
      ].sort());
    } finally {
      if (previousHome === undefined) delete process.env.ARBOR_DATA_HOME; else process.env.ARBOR_DATA_HOME = previousHome;
      if (previousGuard === undefined) delete process.env.ARBOR_REQUIRE_DATA_HOME; else process.env.ARBOR_REQUIRE_DATA_HOME = previousGuard;
    }
    const restored = join(fixture.home, "..", "restored");
    await cp(fixture.backup, restored, { recursive: true });
    expect(await readFile(join(restored, "account.yaml"), "utf8")).toContain("version: 1");
    expect(await readFile(join(restored, ".state", "version"), "utf8")).toBe("3\n");
  });

  test("refuses mixed layouts, unknown stamps, and unavailable credentials before backup", async () => {
    const mixed = await singletonHome({ mixed: true });
    await expect(migrateLocalHome(mixed.home, mixed.backup, mixed.secrets)).rejects.toThrow("mixed, partial");
    const stamped = await singletonHome({ stamp: "future" });
    await expect(migrateLocalHome(stamped.home, stamped.backup, stamped.secrets)).rejects.toThrow("version future");
    const missing = await singletonHome({ credential: false });
    await expect(migrateLocalHome(missing.home, missing.backup, missing.secrets)).rejects.toThrow("credential is unavailable");
    await expect(readFile(join(missing.home, "account.yaml"), "utf8")).resolves.toContain("version: 1");
  });
});
