import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { arborPrivateRoot, HostAccountStore, HostPlacementStore, treeConfigurationID } from "@overstory/protocol";
import { ArborSyncDaemon, serveArborSyncControl } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { accountProtocolClient, ProfileIdentityStore } from "@overstory/client";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { LocalAccountService } from "../../packages/arborsync/src/account-service.ts";

/**
 * Security 007, Phase 3: `arbor account place` claims a placement account at
 * a second host with the profile key and records it beside the home
 * connection, whose device key then opens sessions there.
 */

let sandbox: string;
let state: string;
let profile: string;
let profileTree: string;
let home: Awaited<ReturnType<typeof serveHost>>;
let placement: Awaited<ReturnType<typeof serveHost>>;

async function arbor(args: string[]): Promise<string> {
  const daemon = await serveArborSyncControl({ port: 0 });
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_SYNC_URL: daemon.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  daemon.server.stop(true);
  await daemon.service[Symbol.asyncDispose]();
  if (exit !== 0) throw new Error(stderr);
  return stdout.trim();
}

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-cli-account-place-")));
  state = join(sandbox, "state");
  profile = join(sandbox, "profile");
  await Promise.all([state, profile].map((path) => mkdir(path, { recursive: true })));
  process.env.ARBOR_DATA_HOME = state;
  profileTree = (await new ProfileIdentityStore().create(profile)).profileTree;
  const host = (name: string, handle: string) => serveHost({
    dataRoot: join(sandbox, name), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle, name: handle, firstWriter: { handle: "joe", profileTree } },
  });
  home = await host("home", "garden");
  placement = await host("placement", "orchard");
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${home.url}/~joe`, profile, "Joe");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
});

afterAll(async () => {
  process.env.ARBOR_DATA_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  for (const host of [placement, home]) {
    host?.server.stop(true);
    await host?.canopy[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("arbor account place", () => {
  test("refuses the profile's own home host", async () => {
    await expect(arbor(["account", "place", home.url])).rejects.toThrow("home host");
  });

  test("claims the placement account and records it beside the home connection, which stays as it was", async () => {
    const configurationTree = treeConfigurationID(profileTree);
    const before = await new HostAccountStore(configurationTree).safe();
    const output = await arbor(["account", "place", placement.url]);
    expect(output).toContain(`Claimed placement account ${placement.url}/~joe`);
    expect(output).toContain(`Home host: ${home.url}`);
    expect(output).toContain("(not yet activated)");
    process.env.ARBOR_DATA_HOME = state;
    // The home connection is unchanged and is still the only one `list` returns.
    expect(await new HostAccountStore(configurationTree).safe()).toEqual(before);
    expect((await HostAccountStore.list()).map((record) => record.origin)).toEqual([home.url]);
    const [record] = await HostPlacementStore.list();
    expect(record).toMatchObject({ configurationTree, origin: placement.url, account: `${placement.url}/~joe`, profileTree, homeHost: home.url, handle: "joe" });
    expect(placement.canopy.account(profileTree)).toMatchObject({ handle: "joe", homeHost: home.url });
    expect(await readdir(join(arborPrivateRoot(), "accounts", configurationTree, "placements"))).toHaveLength(1);
    expect(await arbor(["account"])).toContain(`Placement: ${placement.url}/~joe (root ${record!.placementRoot})`);
  });

  test("running it again connects to the account instead of claiming it twice", async () => {
    expect(await arbor(["account", "place", `${placement.url}/~joe`])).toContain(`Connected placement account ${placement.url}/~joe`);
    process.env.ARBOR_DATA_HOME = state;
    expect(await HostPlacementStore.list()).toHaveLength(1);
  });

  test("the home device key opens a session there, and an administrator device places a tree under the placement root", async () => {
    process.env.ARBOR_DATA_HOME = state;
    const configurationTree = treeConfigurationID(profileTree);
    const atHome = await accountProtocolClient({ configurationTree });
    expect(atHome).toMatchObject({ origin: home.url, authenticated: true });
    expect(atHome.placement).toBeUndefined();
    const selected = await accountProtocolClient({ configurationTree, origin: placement.url }, { required: true });
    const byOrigin = await accountProtocolClient({ origin: placement.url }, { required: true });
    expect(byOrigin.token).toBe(selected.token!);
    expect(selected).toMatchObject({ origin: placement.url, configurationTree, authenticated: true, placement: { homeHost: home.url } });
    const { account } = await selected.client.placementAccount();
    const deviceID = (await new HostAccountStore(configurationTree).safe())!.deviceID;
    expect(account).toMatchObject({ profileTree, homeHost: home.url, device: { id: deviceID } });

    const folder = join(sandbox, "root");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "_index.md"), "# Joe at the orchard\n");
    await selected.client.submitUpdate(account.placementRoot.id, null, await resolveSnapshot(await snapshotDirectory(folder)));
    expect((await selected.client.placementAccount()).account.placementRoot.tree).toMatchObject({ canonical: { path: "/~joe" }, access: "write" });
  });
});
