import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overstoryPrivateRoot, HostAccountStore, HostPlacementStore, treeConfigurationID } from "@ovst/protocol";
import { StorySyncDaemon, serveStorySyncControl } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { accountProtocolClient, ProfileIdentityStore } from "@ovst/client";
import { LocalAccountService } from "../../packages/story-sync/src/account-service.ts";
import { makeProfilePublic, reserveMembers } from "../helpers/community-reservations.ts";
import { deviceClient, testAccount } from "../helpers/devices.ts";

/**
 * Security 011: once a second host's community reserves the profile by its
 * locator at the home host, `story place` onto that host connects to the
 * placement account on first use (accounts §1.3) and records it beside the
 * home connection, whose device key then opens sessions there.
 */

let sandbox: string;
let state: string;
let profile: string;
let profileTree: string;
let home: Awaited<ReturnType<typeof serveHost>>;
let placement: Awaited<ReturnType<typeof serveHost>>;

async function story(args: string[]): Promise<string> {
  const daemon = await serveStorySyncControl({ port: 0 });
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, STORY_HOME: state, STORY_SYNC_URL: daemon.url },
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
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-cli-place-connect-")));
  state = join(sandbox, "state");
  profile = join(sandbox, "profile");
  await Promise.all([state, profile].map((path) => mkdir(path, { recursive: true })));
  process.env.STORY_HOME = state;
  profileTree = (await new ProfileIdentityStore().create(profile)).profileTree;
  home = await serveHost({
    dataRoot: join(sandbox, "home"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "garden", firstWriter: { handle: "joe", profileTree } },
  });
  placement = await serveHost({
    dataRoot: join(sandbox, "placement"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "orchard", name: "orchard" }, accounts: [testAccount("owner", "orchard-owner", { communityWriter: true })],
  });
  const daemon = await StorySyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${home.url}/~joe`, profile, "Joe");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
  await makeProfilePublic((await accountProtocolClient({ configurationTree: treeConfigurationID(profileTree) }, { required: true })).client, profileTree);
});

afterAll(async () => {
  process.env.STORY_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  for (const host of [placement, home]) {
    host?.server.stop(true);
    await host?.overstoryd[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("story place onto a placement host", () => {
  test("a host that reserved nothing for the profile says what to reserve", async () => {
    const folder = join(sandbox, "early");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "_index.md"), "# Too early\n");
    await expect(story(["place", folder, `${placement.url}/~joe`])).rejects.toThrow(`reserve ${home.url}/~joe`);
    process.env.STORY_HOME = state;
    expect(await HostPlacementStore.list()).toHaveLength(0);
  });

  test("connects on first use once the host's community reserves the profile's locator, and places the root", async () => {
    await reserveMembers(await deviceClient(placement.url, "orchard-owner"), sandbox, { joe: `${home.url}/~joe` });
    const configurationTree = treeConfigurationID(profileTree);
    const before = await new HostAccountStore(configurationTree).safe();
    const folder = join(sandbox, "root");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "_index.md"), "# Joe at the orchard\n");
    expect(await story(["place", folder, `${placement.url}/~joe`])).toContain(`${placement.url}/~joe ↔ ${folder}`);
    process.env.STORY_HOME = state;
    // The home connection is unchanged and is still the only one `list` returns.
    expect(await new HostAccountStore(configurationTree).safe()).toEqual(before);
    expect((await HostAccountStore.list()).map((record) => record.origin)).toEqual([home.url]);
    const [record] = await HostPlacementStore.list();
    expect(record).toMatchObject({ configurationTree, origin: placement.url, account: `${placement.url}/~joe`, profileTree, homeHost: home.url, handle: "joe" });
    expect(placement.overstoryd.account(profileTree)).toMatchObject({ handle: "joe", homeHost: home.url });
    expect(await readdir(join(overstoryPrivateRoot(), "accounts", configurationTree, "placements"))).toHaveLength(1);
    expect(await story(["account"])).toContain(`Placement: ${placement.url}/~joe (root ${record!.placementRoot})`);
  });

  test("the home device key opens a session there, and reads the activated placement root", async () => {
    process.env.STORY_HOME = state;
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
  });

  test("story account place is gone", async () => {
    await expect(story(["account", "place", placement.url])).rejects.toThrow();
  });
});
