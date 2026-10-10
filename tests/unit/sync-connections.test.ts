import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overstoryPrivateRoot, HostAccountStore, HostPlacementStore, treeConfigurationID, type SharedTreePlacement } from "@ovst/protocol";
import { accountProtocolClient } from "@ovst/client";
import { forgetPlacementSession } from "../../packages/story-sync/src/sync-connections.ts";

/**
 * Security 007: a folder placed on a placement host speaks to that host with
 * the placement connection's session, and a 401 there forgets that session
 * alone, never the home account's.
 */

const previousDataHome = process.env.STORY_HOME;
const previousCredentialStore = process.env.STORY_CREDENTIAL_STORE;
const temporary: string[] = [];
const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", cfg = treeConfigurationID(profile), device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const home = "https://community.example", orchard = "https://orchard.example", seed = "A".repeat(43);

async function dataHome(): Promise<{ homeSession: string; placementSession: string }> {
  const root = await mkdtemp(join(tmpdir(), "story-sync-connections-"));
  temporary.push(root); process.env.STORY_HOME = root; process.env.STORY_CREDENTIAL_STORE = "file";
  await new HostAccountStore(cfg).setDeviceKey(seed, { origin: home, account: `${home}/~joe`, accountID: profile, profileTree: profile, deviceID: device });
  await new HostPlacementStore(cfg, orchard).set({ account: `${orchard}/~joe`, accountID: profile, profileTree: profile, homeHost: home, placementRoot: "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb" });
  const placements = join(overstoryPrivateRoot(), "accounts", cfg, "placements");
  const [directory] = await readdir(placements);
  const homeSession = join(overstoryPrivateRoot(), "accounts", cfg, "session.json");
  const placementSession = join(placements, directory!, "session.json");
  for (const path of [homeSession, placementSession]) await writeFile(path, JSON.stringify({ token: "stale", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
  return { homeSession, placementSession };
}

function placement(endpoint: string): SharedTreePlacement {
  return { configurationTree: cfg, path: "/tmp/folder", tree: "tr_cccccccccccccccccccccccccc", access: "write", endpoint };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

afterEach(async () => {
  if (previousCredentialStore === undefined) delete process.env.STORY_CREDENTIAL_STORE;
  else process.env.STORY_CREDENTIAL_STORE = previousCredentialStore;
  if (previousDataHome === undefined) delete process.env.STORY_HOME;
  else process.env.STORY_HOME = previousDataHome;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a 401 from a placement host forgets its session and keeps the home's", async () => {
  const { homeSession, placementSession } = await dataHome();
  expect(await forgetPlacementSession(placement(orchard))).toBe(true);
  expect(await exists(placementSession)).toBe(false);
  expect(await exists(homeSession)).toBe(true);
});

test("a 401 from the home host forgets the home's session and keeps the placement host's", async () => {
  const { homeSession, placementSession } = await dataHome();
  expect(await forgetPlacementSession(placement(home))).toBe(true);
  expect(await exists(homeSession)).toBe(false);
  expect(await exists(placementSession)).toBe(true);
});

test("a host with no placement connection has no session to forget, and never gets the home's credential", async () => {
  const { homeSession } = await dataHome();
  const stranger = "https://stranger.example";
  expect(await forgetPlacementSession(placement(stranger))).toBe(false);
  expect(await exists(homeSession)).toBe(true);
  const anonymous = await accountProtocolClient({ configurationTree: cfg, origin: stranger });
  expect(anonymous).toMatchObject({ origin: stranger, authenticated: false });
  expect(anonymous.token).toBeUndefined();
  await expect(accountProtocolClient({ configurationTree: cfg, origin: stranger }, { required: true })).rejects.toThrow("Credential unavailable");
});
