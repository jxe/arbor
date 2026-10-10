// Rename 001's throwaway `story migrate`, run against scratch directories
// only. Deleted with packages/cli/src/migrate-rename-001.ts at the plan's
// close-out; the old names here are intended.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseLocalPlacements } from "@ovst/client";
import { generateOverstoryID, HostAccountStore, treeConfigurationID } from "@ovst/protocol";
import { testDevice } from "../helpers/devices.ts";

const repository = join(import.meta.dir, "../..");
let sandbox: string;
/** A loopback URL nothing listens on, and one something does. */
let silent: string;
let answering: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-migrate-")));
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  silent = `http://127.0.0.1:${closed.port}/v1/status`;
  await closed.stop(true);
  answering = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ service: "arborsync" }) });
});

afterAll(async () => {
  await answering.stop(true);
  await rm(sandbox, { recursive: true, force: true });
});

async function story(args: string[], environment: Record<string, string | undefined> = {}): Promise<{ exit: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...Bun.env, STORY_CREDENTIAL_STORE: "file", STORY_CLOUD_HOME: join(sandbox, "unused-cloud-home"), ...environment };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], { cwd: repository, env, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}

interface Scratch { oldHome: string; newHome: string; oldSupport: string; newSupport: string; args: string[] }

async function scratch(name: string): Promise<Scratch> {
  const root = join(sandbox, name);
  const oldHome = join(root, ".arbor"), newHome = join(root, ".story");
  const oldSupport = join(root, "Library", "Application Support", "Arbor"), newSupport = join(root, "Library", "Application Support", "Story");
  await mkdir(join(oldHome, ".state"), { recursive: true });
  await mkdir(dirname(oldSupport), { recursive: true });
  return { oldHome, newHome, oldSupport, newSupport,
    args: ["migrate", "--old-home", oldHome, "--new-home", newHome, "--old-support", oldSupport, "--new-support", newSupport, "--probe-url", silent] };
}

const exists = (path: string) => lstat(path).then(() => true, () => false);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("story migrate (Rename 001)", () => {
  test("moves a scratch home and support directory and rewrites everything that recorded the old paths", async () => {
    const { oldHome, newHome, oldSupport, newSupport, args } = await scratch("full");
    const placed = join(sandbox, "full", "Documents", "notes"), nested = join(placed, "nested-tree");
    const insideHome = join(oldHome, "trees", "inside"), insideSupport = join(oldSupport, "Trees", "app");
    const cloudSession = "cs_0123456789abcdefghij";

    // An identity, created the way a person creates one.
    const created = await story(["me", "create", join(oldHome, "profile")], { STORY_HOME: oldHome });
    expect(created.exit).toBe(0);
    const profileTree = /Profile TreeID: (tr_\w+)/.exec(created.stdout)![1]!;
    const configurationTree = treeConfigurationID(profileTree);
    const selfBefore = await json(join(oldHome, ".state", "self.json"));
    const identityBefore = await json(join(oldHome, ".state", "self.identity.json"));
    expect(identityBefore.profilePath).toBe(join(oldHome, "profile"));

    // An account with a device key, a cached session, and a placement connection's session.
    const device = testDevice("migrate-rename-001");
    const home = process.env.STORY_HOME;
    try {
      process.env.STORY_HOME = oldHome;
      await new HostAccountStore(configurationTree).setDeviceKey(device.seed, {
        origin: "https://garden.example", account: "https://garden.example/~joe", accountID: profileTree, profileTree, deviceID: device.device,
      });
    } finally { process.env.STORY_HOME = home; }
    const account = join(".state", "accounts", configurationTree);
    const connectionBefore = await readFile(join(oldHome, account, "connection.json"), "utf8");
    await writeFile(join(oldHome, account, "session.json"), "{}");
    await mkdir(join(oldHome, account, "placements", "host-abc"), { recursive: true });
    await writeFile(join(oldHome, account, "placements", "host-abc", "session.json"), "{}");
    await writeFile(join(oldHome, account, "placements", "host-abc", "connection.json"), "{}");

    // Placed folders: one outside both locations with a nested placed tree, one under the home, one under app support.
    const trees = { placed: generateOverstoryID("tr"), nested: generateOverstoryID("tr"), insideHome: generateOverstoryID("tr"), insideSupport: generateOverstoryID("tr") };
    for (const directory of [placed, nested, insideHome, insideSupport, join(placed, "sub"), join(placed, "deep", "er"), join(placed, ".git"), join(placed, "node_modules", "x"), join(placed, ".arbor")]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(join(placed, ".arborignore"), "drafts/\n");
    await writeFile(join(placed, "deep", "er", ".arborignore"), "*.tmp\n");
    await writeFile(join(placed, "sub", ".arborignore"), "old\n");
    await writeFile(join(placed, "sub", ".overstoryignore"), "new\n");
    await writeFile(join(placed, ".git", ".arborignore"), "git\n");
    await writeFile(join(placed, "node_modules", "x", ".arborignore"), "module\n");
    await writeFile(join(placed, ".arbor", ".arborignore"), "reserved\n");
    await writeFile(join(nested, ".arborignore"), "nested\n");
    await writeFile(join(insideHome, ".arborignore"), "inside\n");
    await writeFile(join(placed, ".note.md.arbor-write-1234"), "stray");
    await writeFile(join(placed, "sub", ".page.md.arbor-txn-77"), "stray");
    await writeFile(join(placed, "note.md"), "# Note\n");
    await writeFile(join(oldHome, "placements.yaml"), [
      "# Placements on this Mac",
      `${configurationTree}:`,
      `  ${placed}: ${trees.placed}`,
      `  "${nested}": ${trees.nested}`,
      `  ${insideHome}: ${trees.insideHome}`,
      `  ${insideSupport}: { tree: ${trees.insideSupport}, host: "https://orchard.example" }`,
      "",
    ].join("\n"));

    // Workspace records and their rebuildable indexes.
    const workspacesPath = join(oldHome, ".state", "workspaces.json");
    const workspaces = await json(workspacesPath);
    expect(Object.keys(workspaces)).toEqual([join(oldHome, "profile")]);
    workspaces[placed] = { stateID: "aaaaaaaaaaaa-11111111", rootID: trees.placed, path: placed };
    workspaces[insideHome] = { stateID: "bbbbbbbbbbbb-22222222", rootID: trees.insideHome, path: insideHome, device: "1", inode: "2" };
    workspaces[insideSupport] = { stateID: "cccccccccccc-33333333", rootID: trees.insideSupport, path: insideSupport };
    await writeFile(workspacesPath, `${JSON.stringify(workspaces, null, 2)}\n`);
    const workspaceState = join(".state", "workspaces", "aaaaaaaaaaaa-11111111");
    await mkdir(join(oldHome, workspaceState), { recursive: true });
    for (const name of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm", "changes.json"]) await writeFile(join(oldHome, workspaceState, name), name);
    const versionBefore = await readFile(join(oldHome, ".state", "version"), "utf8");

    // A finished cloud session.
    await mkdir(join(oldHome, "cloud-sessions"), { recursive: true });
    const session = {
      version: 1, sessionID: cloudSession, bundleID: "cb_0123456789abcdefghij", configurationTree, root: join(sandbox, "full", "cloud-root"),
      dataHome: join(oldHome, "cloud-sessions", "sessions", cloudSession, "data"), instanceID: "instance", phase: "finished",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
      placements: [{ treeID: trees.placed, canonicalURL: "https://garden.example/~joe/notes", relativePath: "notes", path: join(sandbox, "full", "cloud-root", "notes") }],
    };
    await writeFile(join(oldHome, "cloud-sessions", "sessions.json"), JSON.stringify({ version: 1, sessions: [session] }));

    // The app's support directory.
    for (const directory of ["CLI/0.1.0-abc/bin", "Logs", "Avatars", "LinkPreviews", "EditorRecovery", "WorkingTrees/key/sync", "Identity"]) {
      await mkdir(join(oldSupport, directory), { recursive: true });
    }
    await writeFile(join(oldSupport, "CLI/0.1.0-abc/bin/arborsync.js"), "old runtime");
    await writeFile(join(oldSupport, "Logs", "2026-10-01.jsonl"), "{}");
    await writeFile(join(oldSupport, "Directory.json"), "{}");
    await writeFile(join(oldSupport, "Visits.json"), JSON.stringify({ version: 1, visits: [] }));
    await writeFile(join(oldSupport, "WorkingTrees/key/sync/update-control.json"), "{}");
    await writeFile(join(oldSupport, "Identity", "setup.sqlite"), "");
    const descriptor = (id: string) => ({ id, canonicalPath: "/~joe/notes" });
    await writeFile(join(oldSupport, "Native Placement.json"), JSON.stringify({
      version: 2, selectedTree: trees.insideHome,
      placements: [
        { version: 1, origin: "https://garden.example", configurationTree, tree: descriptor(trees.insideHome), osPath: insideHome },
        { version: 1, origin: "https://garden.example", configurationTree, tree: descriptor(trees.insideSupport), osPath: insideSupport },
        { version: 1, origin: "https://garden.example", configurationTree, tree: descriptor(trees.placed), osPath: placed },
        { version: 1, origin: "https://garden.example", configurationTree, tree: descriptor(trees.nested) },
      ],
    }));

    // A dry run prints the actions and changes nothing.
    const dry = await story([...args, "--dry-run"]);
    expect(dry.stderr).toBe("");
    expect(dry.exit).toBe(0);
    expect(dry.stdout).toContain(`would rename ${oldHome} to ${newHome}`);
    expect(dry.stdout).toContain(`would rename ${join(placed, ".arborignore")} to .overstoryignore`);
    expect(dry.stdout).toContain(`would delete ${join(oldHome, account, "session.json")}`);
    expect(dry.stdout).toContain("would update profilePath inside the identity record");
    expect(dry.stdout).not.toContain("did ");
    expect(await exists(newHome)).toBe(false);
    expect(await exists(newSupport)).toBe(false);
    expect(await exists(join(oldHome, ".state", "migration.lock"))).toBe(false);
    expect(await exists(join(placed, ".arborignore"))).toBe(true);
    expect(await exists(join(placed, ".note.md.arbor-write-1234"))).toBe(true);
    expect(await json(workspacesPath)).toEqual(workspaces);
    expect(await json(join(oldHome, ".state", "self.identity.json"))).toEqual(identityBefore);

    // The real run.
    const migrated = await story(args);
    expect(migrated.stderr).toBe("");
    expect(migrated.exit).toBe(0);
    expect(migrated.stdout).toContain("story daemon install");
    expect(migrated.stdout).toContain("story status");
    expect(await exists(oldHome)).toBe(false);
    expect(await exists(oldSupport)).toBe(false);
    expect(await exists(join(newHome, ".state", "migration.lock"))).toBe(false);
    expect(await readFile(join(newHome, ".state", "version"), "utf8")).toBe(versionBefore);

    const movedInsideHome = join(newHome, "trees", "inside"), movedInsideSupport = join(newSupport, "Trees", "app");
    const placementsSource = await readFile(join(newHome, "placements.yaml"), "utf8");
    expect(placementsSource).toStartWith("# Placements on this Mac\n");
    expect(placementsSource).not.toContain(oldHome);
    expect(placementsSource).not.toContain(oldSupport);
    expect(parseLocalPlacements(placementsSource)).toEqual([
      { configurationTree, path: placed, tree: trees.placed },
      { configurationTree, path: nested, tree: trees.nested },
      { configurationTree, path: movedInsideHome, tree: trees.insideHome },
      { configurationTree, path: movedInsideSupport, tree: trees.insideSupport, host: "https://orchard.example" },
    ]);

    const movedWorkspaces = await json(join(newHome, ".state", "workspaces.json"));
    expect(Object.keys(movedWorkspaces).sort()).toEqual([join(newHome, "profile"), placed, movedInsideHome, movedInsideSupport].sort());
    expect(movedWorkspaces[movedInsideHome]).toEqual({ ...workspaces[insideHome], path: movedInsideHome });
    expect(movedWorkspaces[movedInsideSupport]).toEqual({ ...workspaces[insideSupport], path: movedInsideSupport });
    expect(movedWorkspaces[placed]).toEqual(workspaces[placed]);
    expect(movedWorkspaces[join(newHome, "profile")]).toEqual({ ...workspaces[join(oldHome, "profile")], path: join(newHome, "profile") });

    // The identity: metadata and the stored record both name the moved folder; the credential reference and key do not change.
    expect(await json(join(newHome, ".state", "self.json"))).toEqual({ ...selfBefore, profilePath: join(newHome, "profile") });
    expect(await json(join(newHome, ".state", "self.identity.json"))).toEqual({ ...identityBefore, profilePath: join(newHome, "profile") });
    expect(migrated.stdout).toContain("(read back)");

    expect((await json(join(newHome, "cloud-sessions", "sessions.json"))).sessions).toEqual([
      { ...session, dataHome: join(newHome, "cloud-sessions", "sessions", cloudSession, "data") },
    ]);

    // App support: moved, with the rebuildable entries dropped.
    expect((await readdir(newSupport)).sort()).toEqual(["Identity", "Native Placement.json", "Trees", "Visits.json", "WorkingTrees"]);
    expect(await exists(join(newSupport, "WorkingTrees/key/sync/update-control.json"))).toBe(true);
    const native = await json(join(newSupport, "Native Placement.json"));
    expect(native.selectedTree).toBe(trees.insideHome);
    expect(native.placements.map((placement: { osPath?: string }) => placement.osPath)).toEqual([movedInsideHome, movedInsideSupport, placed, undefined]);
    expect(native.placements[0].tree).toEqual(descriptor(trees.insideHome));

    // Placed folders.
    expect(await readFile(join(placed, ".overstoryignore"), "utf8")).toBe("drafts/\n");
    expect(await readFile(join(placed, "deep", "er", ".overstoryignore"), "utf8")).toBe("*.tmp\n");
    expect(await readFile(join(nested, ".overstoryignore"), "utf8")).toBe("nested\n");
    expect(await readFile(join(movedInsideHome, ".overstoryignore"), "utf8")).toBe("inside\n");
    for (const path of [join(placed, ".arborignore"), join(placed, "deep", "er", ".arborignore"), join(nested, ".arborignore"), join(movedInsideHome, ".arborignore")]) {
      expect(await exists(path)).toBe(false);
    }
    // An existing .overstoryignore wins; the old file is kept and reported.
    expect(await readFile(join(placed, "sub", ".arborignore"), "utf8")).toBe("old\n");
    expect(await readFile(join(placed, "sub", ".overstoryignore"), "utf8")).toBe("new\n");
    expect(migrated.stdout).toContain(`Attention: ${join(placed, "sub", ".arborignore")} was kept`);
    for (const skipped of [join(placed, ".git"), join(placed, "node_modules", "x"), join(placed, ".arbor")]) {
      expect(await exists(join(skipped, ".arborignore"))).toBe(true);
      expect(await exists(join(skipped, ".overstoryignore"))).toBe(false);
    }
    expect(await exists(join(placed, ".note.md.arbor-write-1234"))).toBe(false);
    expect(await exists(join(placed, "sub", ".page.md.arbor-txn-77"))).toBe(false);
    expect(await readFile(join(placed, "note.md"), "utf8")).toBe("# Note\n");
    // The nested placed tree is walked once, as its own root.
    expect(migrated.stdout.split(`rename ${join(nested, ".arborignore")} to`).length).toBe(2);

    // Rebuildable state is gone; everything else under the account stays byte for byte.
    expect(await exists(join(newHome, account, "session.json"))).toBe(false);
    expect(await exists(join(newHome, account, "placements", "host-abc", "session.json"))).toBe(false);
    expect(await exists(join(newHome, account, "placements", "host-abc", "connection.json"))).toBe(true);
    expect(await readFile(join(newHome, account, "connection.json"), "utf8")).toBe(connectionBefore);
    expect((await readdir(join(newHome, workspaceState))).sort()).toEqual(["changes.json"]);

    // The device key is still found under the moved home.
    try {
      process.env.STORY_HOME = newHome;
      const store = new HostAccountStore(configurationTree);
      expect(await store.hasDeviceKey()).toBe(true);
      expect(await store.deviceKeySeed()).toEqual({ deviceID: device.device, seed: device.seed });
    } finally { process.env.STORY_HOME = home; }

    // The CLI reads the new home, and nothing under the old paths comes back.
    const me = await story(["me"], { STORY_HOME: newHome });
    expect(me.exit).toBe(0);
    expect(me.stdout).toContain(`Profile TreeID: ${profileTree}`);
    expect(me.stdout).toContain(`Profile folder: ${join(newHome, "profile")}`);
    expect(me.stdout).toContain("Private key: available");
    const status = await story(["status", "--json"], { STORY_HOME: newHome, STORY_SYNC_URL: silent.replace("/v1/status", "") });
    expect(JSON.parse(status.stdout).context.dataHome).toBe(newHome);
    expect(await exists(oldHome)).toBe(false);
    expect(await exists(oldSupport)).toBe(false);
    expect(await exists(join(newHome, ".state", "migration.lock"))).toBe(false);
  }, 60_000);

  describe("refuses, changing nothing,", () => {
    async function refused(name: string, prepare: (scratch: Scratch) => Promise<void>, expected: string, extra: string[] = []) {
      const locations = await scratch(name);
      await prepare(locations);
      const before = (await readdir(locations.oldHome, { recursive: true })).sort();
      const result = await story([...locations.args, ...extra]);
      expect(result.stderr).toContain("Refusing to migrate");
      expect(result.stderr).toContain(expected);
      expect(result.stderr).toContain("Nothing was changed.");
      expect(result.exit).toBe(1);
      expect((await readdir(locations.oldHome, { recursive: true })).sort()).toEqual(before);
      expect(await exists(join(locations.oldHome, ".state", "migration.lock"))).toBe(name === "refuse-lock");
    }

    test("when the new home exists", async () => {
      await refused("refuse-new-home", async ({ newHome }) => { await mkdir(newHome); }, "already exists");
    });
    test("while an account claim is in progress", async () => {
      await refused("refuse-claim", ({ oldHome }) => writeFile(join(oldHome, ".state", "bootstrap-account-claim.json"), "{}"), "an account claim is in progress");
    });
    test("while a device pairing is in progress", async () => {
      await refused("refuse-pairing", ({ oldHome }) => writeFile(join(oldHome, ".state", "bootstrap-pairing.json"), "{}"), "a device pairing is in progress");
    });
    test("while a cloud session is not finished", async () => {
      await refused("refuse-cloud", async ({ oldHome }) => {
        await mkdir(join(oldHome, "cloud-sessions"));
        await writeFile(join(oldHome, "cloud-sessions", "sessions.json"), JSON.stringify({ version: 1, sessions: [
          { sessionID: "cs_finished", phase: "finished" }, { sessionID: "cs_live", phase: "needs-sync" },
        ] }));
      }, "1 cloud session(s) are not finished: cs_live (needs-sync)");
    });
    test("while something answers the daemon's status URL", async () => {
      await refused("refuse-daemon", async () => {}, "something answers", ["--probe-url", `http://127.0.0.1:${answering.port}/v1/status`]);
    });
    test("when an earlier migration left its lock", async () => {
      await refused("refuse-lock", ({ oldHome }) => writeFile(join(oldHome, ".state", "migration.lock"), "{}"), "an earlier migration did not finish");
    });
    test("when a state file it would rewrite is unreadable", async () => {
      await refused("refuse-placements", ({ oldHome }) => writeFile(join(oldHome, "placements.yaml"), "tr_x: [not, a, mapping]\n"), "placements.yaml is invalid");
    });
    test("when an entry it would move already exists in the new support directory", async () => {
      await refused("refuse-support", async ({ oldSupport, newSupport }) => {
        await mkdir(join(newSupport, "CLI"), { recursive: true });
        await mkdir(oldSupport);
        await writeFile(join(oldSupport, "Visits.json"), JSON.stringify({ version: 1, visits: [] }));
        await writeFile(join(newSupport, "Visits.json"), JSON.stringify({ version: 1, visits: [] }));
      }, "Visits.json already exists");
    });

    test("when only some locations are overridden", async () => {
      const { oldHome, newHome } = await scratch("refuse-partial");
      const result = await story(["migrate", "--old-home", oldHome, "--new-home", newHome, "--probe-url", silent]);
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toContain("Override all four locations or none");
      expect(await exists(newHome)).toBe(false);
    });

    // The defaults resolve under HOME, which is a scratch directory here.
    for (const variable of ["STORY_HOME", "ARBOR_DATA_HOME"]) {
      test(`when ${variable} is set and the default locations are used`, async () => {
        const root = join(sandbox, `refuse-${variable}`);
        await mkdir(join(root, ".arbor", ".state"), { recursive: true });
        const result = await story(["migrate", "--probe-url", silent], { HOME: root, STORY_HOME: undefined, STORY_REQUIRE_HOME: undefined, [variable]: join(root, "elsewhere") });
        expect(result.stdout).toContain(`Data home:   ${join(root, ".arbor")} -> ${join(root, ".story")}`);
        expect(result.stderr).toContain(`${variable} is set`);
        expect(result.exit).toBe(1);
        expect(await exists(join(root, ".story"))).toBe(false);
        expect(await readdir(join(root, ".arbor", ".state"))).toEqual([]);
      });
    }
  });

  test("moves the default locations when nothing is overridden", async () => {
    // HOME is a scratch directory, so `~/.arbor` and Application Support are too.
    const root = join(sandbox, "defaults");
    const oldHome = join(root, ".arbor"), newHome = join(root, ".story");
    const oldSupport = join(root, "Library", "Application Support", "Arbor"), newSupport = join(root, "Library", "Application Support", "Story");
    await mkdir(oldSupport, { recursive: true });
    await writeFile(join(oldSupport, "Visits.json"), JSON.stringify({ version: 1, visits: [] }));
    const defaults = { HOME: root, STORY_HOME: undefined, STORY_REQUIRE_HOME: undefined };
    expect((await story(["me", "create", join(oldHome, "profile")], { HOME: root, STORY_HOME: oldHome, STORY_REQUIRE_HOME: undefined })).exit).toBe(0);
    const migrated = await story(["migrate", "--probe-url", silent], defaults);
    expect(migrated.stderr).toBe("");
    expect(migrated.exit).toBe(0);
    expect(await exists(oldHome)).toBe(false);
    expect(await exists(oldSupport)).toBe(false);
    expect(await readdir(newSupport)).toEqual(["Visits.json"]);
    expect((await json(join(newHome, ".state", "self.identity.json"))).profilePath).toBe(join(newHome, "profile"));
    const me = await story(["me"], defaults);
    expect(me.stdout).toContain(`Profile folder: ${join(newHome, "profile")}`);
    expect(me.stdout).toContain("Private key: available");
    expect(await exists(oldHome)).toBe(false);
  }, 60_000);

  // The owner's Mac: `Application Support/Arbor` is a symlink to `~/.arbor`,
  // so the data home also holds the app's files.
  test("handles an app-support path that is a symlink to the data home", async () => {
    const root = join(sandbox, "linked");
    const oldHome = join(root, ".arbor"), newHome = join(root, ".story");
    const oldSupport = join(root, "Library", "Application Support", "Arbor"), newSupport = join(root, "Library", "Application Support", "Story");
    const outside = join(root, "Documents", "arbor-rehearsals", "todos-2026-08-25-f");
    await mkdir(dirname(oldSupport), { recursive: true });
    await mkdir(outside, { recursive: true });
    const args = ["migrate", "--old-home", oldHome, "--new-home", newHome, "--old-support", oldSupport, "--new-support", newSupport, "--probe-url", silent];

    const created = await story(["me", "create", join(oldHome, "profile")], { STORY_HOME: oldHome });
    expect(created.exit).toBe(0);
    const profileTree = /Profile TreeID: (tr_\w+)/.exec(created.stdout)![1]!;
    const configurationTree = treeConfigurationID(profileTree);
    await symlink(oldHome, oldSupport);
    const viaHome = (...parts: string[]) => join(oldHome, ...parts), viaSupport = (...parts: string[]) => join(oldSupport, ...parts);
    const moved = (...parts: string[]) => join(newHome, ...parts);

    const checkout = join("configurations", configurationTree);
    for (const directory of [checkout, "Avatars", "LinkPreviews", "Logs", "CLI/0.1.0-abc", "Identity", "Pending Voice Recordings", "RemoteSync", "RemoteWorkingTrees", "WorkingTrees/key/sync"]) {
      await mkdir(viaHome(directory), { recursive: true });
    }
    for (const file of ["Directory.json", "Logs/2026-10-01.jsonl", "Identity/setup.sqlite", "Pending Voice Recordings/a.m4a", "RemoteSync/state.json", "RemoteWorkingTrees/x.json", "WorkingTrees/key/sync/update-control.json", `${checkout}/devices.yaml`]) {
      await writeFile(viaHome(file), "{}");
    }
    await writeFile(viaHome("profile", ".arborignore"), "drafts/\n");
    await writeFile(join(outside, ".arborignore"), "tmp/\n");
    await writeFile(join(outside, "todo.md"), "# Todo\n");

    // The same directory is recorded under both spellings.
    const trees = { outside: generateOverstoryID("tr") };
    const placements = [
      `${configurationTree}:`,
      `  ${viaHome(checkout)}: ${configurationTree}`,
      `  ${viaSupport("profile")}: ${profileTree}`,
      `  ${outside}: ${trees.outside}`,
      "",
    ].join("\n");
    await writeFile(viaHome("placements.yaml"), placements);
    const workspaces = await json(viaHome(".state", "workspaces.json"));
    expect(Object.keys(workspaces)).toEqual([viaHome("profile")]);
    workspaces[viaSupport(checkout)] = { stateID: "aaaaaaaaaaaa-11111111", rootID: configurationTree, path: viaSupport(checkout) };
    workspaces[outside] = { stateID: "bbbbbbbbbbbb-22222222", rootID: trees.outside, path: outside };
    await writeFile(viaHome(".state", "workspaces.json"), `${JSON.stringify(workspaces, null, 2)}\n`);
    const self = await json(viaHome(".state", "self.json"));
    await writeFile(viaHome(".state", "self.json"), `${JSON.stringify({ ...self, profilePath: viaSupport("profile") }, null, 2)}\n`);
    const identity = await json(viaHome(".state", "self.identity.json"));
    const descriptor = (id: string) => ({ id, canonicalPath: "/~joe" });
    const native = { version: 2, selectedTree: profileTree, placements: [
      { version: 1, origin: "https://garden.example", configurationTree, tree: descriptor(profileTree), osPath: viaSupport("profile") },
      { version: 1, origin: "https://garden.example", configurationTree, tree: descriptor(configurationTree), osPath: viaHome(checkout) },
      { version: 1, origin: "https://garden.example", configurationTree, tree: descriptor(trees.outside), osPath: outside },
    ] };
    await writeFile(viaHome("Native Placement.json"), JSON.stringify(native));
    const visits = { version: 1, visits: [{ version: 1, origin: "https://garden.example", tree: descriptor(generateOverstoryID("tr")), locator: "overstory://garden.example/~ada", visitedAt: "2026-09-01T00:00:00Z" }] };
    await writeFile(viaHome("Visits.json"), JSON.stringify(visits));
    const before = (await readdir(oldHome, { recursive: true })).sort();

    // The dry run says how the symlink is handled and changes nothing.
    const dry = await story([...args, "--dry-run"]);
    expect(dry.stderr).toBe("");
    expect(dry.exit).toBe(0);
    if (process.env.STORY_MIGRATE_SHOW_DRY_RUN) console.log(dry.stdout.replaceAll(root, "<scratch>"));
    expect(dry.stdout).toContain(`${oldSupport} is a symlink to ${oldHome}: the two are one directory.`);
    expect(dry.stdout).toContain(`would remove the symlink ${oldSupport}`);
    expect(dry.stdout).toContain(`would create the symlink ${newSupport} -> ${newHome}`);
    expect(dry.stdout).toContain(`would remove ${viaHome("Logs")} (rebuildable)`);
    expect(dry.stdout).toContain(`would rewrite 2 placement path(s)`);
    expect(dry.stdout).not.toContain(`move ${oldSupport}`);
    expect(dry.stdout).not.toContain("did ");
    expect((await readdir(oldHome, { recursive: true })).sort()).toEqual(before);
    expect((await lstat(oldSupport)).isSymbolicLink()).toBe(true);
    expect(await exists(newHome)).toBe(false);
    expect(await exists(newSupport)).toBe(false);
    expect(await readFile(viaHome("placements.yaml"), "utf8")).toBe(placements);
    expect(await exists(join(outside, ".arborignore"))).toBe(true);

    const migrated = await story(args);
    expect(migrated.stderr).toBe("");
    expect(migrated.exit).toBe(0);
    expect(await exists(oldHome)).toBe(false);
    expect(await exists(oldSupport)).toBe(false);
    expect((await lstat(newSupport)).isSymbolicLink()).toBe(true);
    expect(await readlink(newSupport)).toBe(newHome);
    expect(await realpath(newSupport)).toBe(newHome);
    expect(await exists(moved(".state", "migration.lock"))).toBe(false);

    // Dropped and kept, inside the home.
    expect((await readdir(newHome)).sort()).toEqual([
      ".state", "Identity", "Native Placement.json", "Pending Voice Recordings", "RemoteSync", "RemoteWorkingTrees", "Visits.json", "WorkingTrees",
      "configurations", "placements.yaml", "profile",
    ].sort());
    for (const kept of ["Identity/setup.sqlite", "Pending Voice Recordings/a.m4a", "RemoteSync/state.json", "RemoteWorkingTrees/x.json", "WorkingTrees/key/sync/update-control.json", `${checkout}/devices.yaml`, "profile/_index.md"]) {
      expect(await exists(moved(kept))).toBe(true);
    }

    // Both spellings converge on the new home's; the outside tree is untouched.
    expect(parseLocalPlacements(await readFile(moved("placements.yaml"), "utf8"))).toEqual([
      { configurationTree, path: moved(checkout), tree: configurationTree },
      { configurationTree, path: moved("profile"), tree: profileTree },
      { configurationTree, path: outside, tree: trees.outside },
    ]);
    const movedWorkspaces = await json(moved(".state", "workspaces.json"));
    expect(Object.keys(movedWorkspaces).sort()).toEqual([moved("profile"), moved(checkout), outside].sort());
    expect(movedWorkspaces[moved(checkout)].path).toBe(moved(checkout));
    expect(movedWorkspaces[outside]).toEqual(workspaces[outside]);
    expect(await json(moved(".state", "self.json"))).toEqual({ ...self, profilePath: moved("profile") });
    expect(await json(moved(".state", "self.identity.json"))).toEqual({ ...identity, profilePath: moved("profile") });
    const movedNative = await json(moved("Native Placement.json"));
    expect(movedNative.placements.map((placement: { osPath: string }) => placement.osPath)).toEqual([moved("profile"), moved(checkout), outside]);
    expect({ ...movedNative, placements: movedNative.placements.map((placement: object) => ({ ...placement, osPath: undefined })) })
      .toEqual({ ...native, placements: native.placements.map((placement) => ({ ...placement, osPath: undefined })) });
    expect(await json(moved("Visits.json"))).toEqual(visits);
    for (const file of ["placements.yaml", ".state/workspaces.json", ".state/self.json", ".state/self.identity.json", "Native Placement.json"]) {
      const source = await readFile(moved(file), "utf8");
      expect(source).not.toContain(oldHome);
      expect(source).not.toContain(oldSupport);
      expect(source).not.toContain(newSupport);
    }
    expect(await exists(outside)).toBe(true);
    expect(await readFile(join(outside, ".overstoryignore"), "utf8")).toBe("tmp/\n");
    expect(await readFile(join(outside, "todo.md"), "utf8")).toBe("# Todo\n");
    expect(await readFile(moved("profile", ".overstoryignore"), "utf8")).toBe("drafts/\n");

    // The app's root is the new symlink; the CLI reads the new home; nothing old comes back.
    expect(await exists(join(newSupport, "Native Placement.json"))).toBe(true);
    const me = await story(["me"], { STORY_HOME: newHome });
    expect(me.stdout).toContain(`Profile folder: ${moved("profile")}`);
    expect(me.stdout).toContain("Private key: available");
    expect(await exists(oldHome)).toBe(false);
    expect(await exists(oldSupport)).toBe(false);
  }, 60_000);

  test("refuses a symlinked app-support path when the new one exists or the link points elsewhere", async () => {
    const taken = await scratch("linked-taken");
    await symlink(taken.oldHome, taken.oldSupport);
    await mkdir(taken.newSupport);
    const first = await story(taken.args);
    expect(first.exit).toBe(1);
    expect(first.stderr).toContain(`${taken.newSupport} already exists`);
    expect(first.stderr).toContain("Nothing was changed.");
    expect(await exists(taken.newHome)).toBe(false);
    expect((await lstat(taken.oldSupport)).isSymbolicLink()).toBe(true);

    const elsewhere = await scratch("linked-elsewhere");
    const other = join(sandbox, "linked-elsewhere", "other");
    await mkdir(other);
    await symlink(other, elsewhere.oldSupport);
    for (const extra of [[], ["--dry-run"]]) {
      const second = await story([...elsewhere.args, ...extra]);
      expect(second.exit).toBe(1);
      expect(second.stderr).toContain(`is a symlink to ${other}, which is not the data home`);
      expect(second.stderr).toContain("Nothing was changed.");
    }
    expect(await exists(elsewhere.newHome)).toBe(false);
    expect(await readlink(elsewhere.oldSupport)).toBe(other);
    expect(await exists(join(elsewhere.oldHome, ".state", "migration.lock"))).toBe(false);
  });

  test("refuses when two records spell one directory differently and would collide", async () => {
    const { oldHome, newHome, oldSupport, args } = await scratch("linked-collision");
    await symlink(oldHome, oldSupport);
    await writeFile(join(oldHome, ".state", "workspaces.json"), JSON.stringify({
      [join(oldHome, "profile")]: { stateID: "a", rootID: "tr_a", path: join(oldHome, "profile") },
      [join(oldSupport, "profile")]: { stateID: "b", rootID: "tr_a", path: join(oldSupport, "profile") },
    }));
    const result = await story(args);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(`.state/workspaces.json names ${join(newHome, "profile")} twice after the move`);
    expect(await exists(newHome)).toBe(false);
    expect(await exists(join(oldHome, ".state", "migration.lock"))).toBe(false);
  });

  test("stops without rolling back when a step fails after the rename, leaving the lock and saying what was done", async () => {
    const { oldHome, newHome, args } = await scratch("failure");
    const placed = join(sandbox, "failure", "notes"), unreadable = join(placed, "locked");
    const configurationTree = treeConfigurationID(testDevice("migrate-failure").profileTree);
    await mkdir(unreadable, { recursive: true });
    await writeFile(join(placed, ".arborignore"), "drafts/\n");
    await writeFile(join(oldHome, "placements.yaml"), `${configurationTree}:\n  ${placed}: ${generateOverstoryID("tr")}\n  ${join(oldHome, "inside")}: ${generateOverstoryID("tr")}\n`);
    await chmod(unreadable, 0o000);
    try {
      const result = await story(args);
      expect(result.exit).toBe(1);
      expect(result.stderr).toContain("Migration stopped while it was to rename .arborignore and delete stray temporaries in placed folders");
      expect(result.stderr).toContain(`Done:\n  - rename ${oldHome} to ${newHome}`);
      expect(result.stderr).toContain("- rewrite 1 placement path(s)");
      expect(result.stderr).toContain("Not done");
      expect(result.stderr).toContain("- delete accounts/**/session.json and workspaces/*/index.sqlite*");
      expect(result.stderr).toContain(`The lock ${join(newHome, ".state", "migration.lock")} is left in place`);
      // No rollback: the home stays moved and locked, and Story refuses to use it.
      expect(await exists(oldHome)).toBe(false);
      expect(await exists(join(newHome, ".state", "migration.lock"))).toBe(true);
      expect(await readFile(join(newHome, "placements.yaml"), "utf8")).toContain(join(newHome, "inside"));
      const me = await story(["me"], { STORY_HOME: newHome });
      expect(me.exit).not.toBe(0);
      expect(me.stderr).toContain("locked for an offline migration");
    } finally {
      await chmod(unreadable, 0o700);
    }
  }, 60_000);
});
