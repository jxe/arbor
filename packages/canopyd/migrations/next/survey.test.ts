import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { REVERT, survey, type CheckResult, type SurveyOptions } from "./survey.ts";
import { surveyHost } from "./survey-host.ts";

const CONFIG = "tr_configabc";
const TREE = "tr_treeabc";
const PROFILE = "tr_profileabc";
const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

/** A home whose data home, Mac app and iPhone copy hold only current state. */
async function cleanHome(): Promise<{ home: string; iphone: string; live: string }> {
  const root = await mkdtemp(join(tmpdir(), "survey-"));
  temporary.push(root);
  const home = join(root, "home"), iphone = join(root, "iphone"), live = join(root, "live.json");
  const arbor = join(home, ".arbor"), state = join(arbor, ".state");
  await put(join(arbor, "placements.yaml"), `${CONFIG}:\n  /Users/joe/notes: ${TREE}\n`);
  await put(join(arbor, "accounts", CONFIG, "devices.yaml"), "dv_mac:\n  label: Mac\n  key: ed25519:abc\n");
  await put(join(state, "workspaces.json"), { "/Users/joe/notes": { stateID: "s", rootID: TREE, path: "/Users/joe/notes" } });
  await put(join(state, "accounts", CONFIG, "connection.json"),
    { account: "https://arb.example/~joe", credential: `org.arbor.accounts/${CONFIG}-key`, deviceKey: "ed25519:abc" });
  await put(join(state, "trees", "dHJfdHJlZWFiYw", "sync", "update-control.json"), { schema: 4, settled: [] });
  await put(join(state, "self.json"), { version: 1, profileTree: PROFILE, credential: "org.arbor.person-profile/primary-v2" });
  const app = join(home, "Library", "Application Support", "Arbor");
  await put(join(app, "WorkingTrees", TREE, "sync", "update-control.json"), { schema: 4, settled: [] });
  await put(join(app, "Native Placement.json"), { version: 2, selectedTree: TREE, placements: [{ version: 1, origin: "https://arb.example", configurationTree: CONFIG, tree: { id: TREE } }] });
  const phone = join(iphone, "Library", "Application Support", "Arbor");
  await put(join(phone, "Sync", TREE, "sync", "update-control.json"), { schema: 4, settled: [] });
  await put(join(phone, "WorkingTrees", TREE, "materialized", "tree.json"),
    { schema: 2, tree: TREE, nodes: [{ path: "/a", kind: "markdown", source: "A", metadata: { modifiedAt: 1 } }] });
  await put(join(phone, "Native Placement.json"), { version: 2, placements: [{ configurationTree: CONFIG, tree: { id: TREE } }] });
  await put(live, { version: 1, schema: "23", unrevokedDevicesWithoutPublicKey: 0, bareStringGroupMembers: 0, profileResets: 0 });
  return { home, iphone, live };
}

const keychain = (accounts: string[]): SurveyOptions["security"] => (args) => {
  if (args[0] === "find-generic-password") return { status: accounts.includes(args[4]!) ? 0 : 44, stdout: "" };
  return { status: 0, stdout: accounts.map((account) =>
    `keychain: "/Users/joe/Library/Keychains/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="${account}"\n    "svce"<blob>="org.arbor.person-profile"\n`).join("") };
};

function byName(results: CheckResult[], fragment: string): CheckResult {
  const found = results.filter((check) => check.name.includes(fragment));
  if (found.length !== 1) throw new Error(`${found.length} checks match ${fragment}`);
  return found[0]!;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(root, path)] = `${(await stat(path)).mtimeMs}:${await readFile(path, "utf8")}`;
    }
  };
  await walk(root);
  return files;
}

test("a clean home passes every check and nothing is written", async () => {
  const { home, iphone, live } = await cleanHome();
  const before = await snapshot(dirname(home));
  const results = await survey({ home, iphone, live, platform: "darwin", security: keychain(["primary-v2"]) });
  expect(results.filter((check) => check.status !== "PASS").map((check) => `${check.status} ${check.name}: ${check.details}`)).toEqual([]);
  expect(results).toHaveLength(18);
  expect(await snapshot(dirname(home))).toEqual(before);
});

test("optional sources are skipped, not failed", async () => {
  const { home } = await cleanHome();
  const results = await survey({ home, platform: "linux" });
  expect(results.filter((check) => check.status === "FAIL")).toEqual([]);
  expect(byName(results, "Keychain").status).toBe("SKIP");
  expect(results.filter((check) => check.name.startsWith("iPhone")).every((check) => check.status === "SKIP")).toBe(true);
  expect(results.filter((check) => check.name.startsWith("live")).every((check) => check.status === "SKIP")).toBe(true);
});

test("each legacy state fails its check and names the commit to revert", async () => {
  const { home, iphone, live } = await cleanHome();
  const arbor = join(home, ".arbor"), state = join(arbor, ".state");
  const phone = join(iphone, "Library", "Application Support", "Arbor");
  await put(join(arbor, "account.yaml"), "handle: joe\n");
  await put(join(arbor, "placements.yaml"), `${CONFIG}:\n  /Users/joe/notes: ${TREE}\ntr_unknown:\n  /Users/joe/other: tr_otherabc\n`);
  await put(join(state, "workspaces.json"), { "/Users/joe/old": { stateID: "s", rootID: "rt_0123456789", path: "/Users/joe/old" } });
  await put(join(state, "accounts", "tr_earlyabc", "connection.json"), { handle: "joe", credential: "file:credential" });
  await put(join(state, "sync", `${Buffer.from(TREE).toString("base64url")}.json`), { accepted: {} });
  await put(join(state, "trees", "dHJvbGQ", "sync", "update-control.json"), { schema: 3, sourceAcceptedChanges: [] });
  await put(join(arbor, "accounts", CONFIG, "devices.yaml"), "dv_mac:\n  key: ed25519:abc\ndv_ipad:\n  label: iPad\n");
  await put(join(phone, "WorkingTrees", TREE, "sync", "update-control.json"), { schema: 3 });
  await put(join(phone, "Native Placement.json"), { version: 2, placements: [{ tree: { id: TREE } }] });
  await put(join(phone, "WorkingTrees", TREE, "materialized", "tree.json"),
    { schema: 2, tree: TREE, nodes: [{ path: "/a", kind: "markdown", source: "A", modifiedAt: 1788000000000 }] });
  await put(live, { version: 1, schema: "23", unrevokedDevicesWithoutPublicKey: 1, bareStringGroupMembers: 2, profileResets: 1 });

  const results = await survey({ home, iphone, live, platform: "darwin", security: keychain(["primary-v2", "self-0123456789abcdef01234567"]) });
  const failed = (fragment: string) => {
    const check = byName(results, fragment);
    expect(check.status, `${check.name}: ${check.details}`).toBe("FAIL");
    return check;
  };
  expect(failed("pre-plural").revert).toBe(REVERT.prePluralFiles);
  expect(failed("placements.yaml").details).toContain("tr_unknown");
  expect(failed("rt_ root IDs").revert).toBe(REVERT.rtRootIDs);
  expect(failed("has account").details).toContain("tr_earlyabc");
  expect(failed("names device-key").details).toContain("file:credential");
  expect(failed("devices.yaml").details).toContain("dv_ipad");
  expect(failed("base64url").details).toContain(TREE);
  expect(failed("data home: every update-control").revert).toBe(REVERT.updateControl);
  expect(failed("Keychain").details).toContain("self-0123456789abcdef01234567");
  expect(failed("iPhone: every update-control").details).toContain("schema 3");
  expect(failed("iPhone: every Native Placement").details).toContain(TREE);
  expect(failed("iPhone: no node record").revert).toBe(REVERT.legacyModifiedAt);
  expect(failed("public key").details).toContain("1");
  expect(failed("bare string").revert).toBe(REVERT.scalarMembers);
  failed("profile_resets");
  expect(byName(results, "Mac app: every update-control").status).toBe("PASS");
});

test("a data home without an indexed identity fails the Keychain check", async () => {
  const { home } = await cleanHome();
  await rm(join(home, ".arbor", ".state", "self.json"));
  const check = byName(await survey({ home, platform: "darwin", security: keychain(["primary-v2"]) }), "Keychain");
  expect(check.status).toBe("FAIL");
  expect(check.revert).toBe(REVERT.keychainIdentities);
});

test("the command exits non-zero when a check fails and reads --home", async () => {
  const { home } = await cleanHome();
  const run = (args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "survey.ts"), "--home", home, ...args], { env: { ...process.env, SURVEY_HOME: "" } });
  const clean = run([]);
  expect(clean.exitCode, clean.stdout.toString()).toBe(0);
  expect(clean.stdout.toString()).toMatch(/^PASS {2}data home: no pre-plural account files {2}\| {2}revert "Remove the pre-plural/m);
  await put(join(home, ".arbor", "trees.yaml"), "x: 1\n");
  const failing = run([]);
  expect(failing.exitCode).toBe(1);
  expect(failing.stdout.toString()).toMatch(/^FAIL {2}data home: no pre-plural account files .*found trees\.yaml$/m);
});

test("survey-host reports counts from a read-only database", async () => {
  const root = await mkdtemp(join(tmpdir(), "survey-host-"));
  temporary.push(root);
  const db = new Database(join(root, "canopy.sqlite3"));
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO meta VALUES ('schema_version', '23')");
  db.run("CREATE TABLE devices (id TEXT PRIMARY KEY, token_digest TEXT, public_key TEXT, revoked_at INTEGER)");
  db.run("INSERT INTO devices VALUES ('dv_a', 'sha256:x', NULL, NULL), ('dv_b', NULL, 'ed25519:y', NULL), ('dv_c', 'sha256:z', NULL, 5)");
  db.run("CREATE TABLE profile_facts (tree_id TEXT PRIMARY KEY, facts TEXT NOT NULL)");
  db.run("INSERT INTO profile_facts VALUES (?, ?), (?, ?)", [
    "tr_group", JSON.stringify({ version: 3, type: "group", members: [{ profile: "/~alice", legacy: true }, { profile: "arbor://tr_bob/" }, "/~carol"] }),
    "tr_person", JSON.stringify({ version: 3, type: "person", members: [] }),
  ]);
  db.run("CREATE TABLE profile_resets (id TEXT)");
  db.close();
  expect(surveyHost(root)).toEqual({ version: 1, schema: "23", unrevokedDevicesWithoutPublicKey: 1, bareStringGroupMembers: 2, profileResets: 0 });
  const dropped = new Database(join(root, "canopy.sqlite3"));
  dropped.run("DROP TABLE profile_resets");
  dropped.close();
  expect(surveyHost(root).profileResets).toBeNull();
});
