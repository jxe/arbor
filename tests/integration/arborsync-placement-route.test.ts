import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostAccountStore, HostPlacementStore, ProtocolClient, treeConfigurationID } from "@overstory/protocol";
import { ArborSyncDaemon } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { accountProtocolClient, ProfileIdentityStore } from "@overstory/client";
import { LocalAccountService } from "../../packages/arborsync/src/account-service.ts";
import { makeProfilePublic, reserveMembers } from "../helpers/community-reservations.ts";
import { deviceClient, testAccount } from "../helpers/devices.ts";

/**
 * `POST /v1/bootstrap/placements`, the route a local app (the Mac's Canopy)
 * connects a placement account through: B's community reserved the profile by
 * its locator at A, and the data home's device key opens a session there
 * (accounts §1.3). Home host A, placement hosts B and C, and one Arbor Sync
 * control service in its own process.
 */

let sandbox: string;
let state: string;
let profileTree: string;
let configurationTree: string;
let a: Awaited<ReturnType<typeof serveHost>>;
let b: Awaited<ReturnType<typeof serveHost>>;
let c: Awaited<ReturnType<typeof serveHost>>;
let daemon: { child: ReturnType<typeof Bun.spawn>; url: string };

const repository = join(import.meta.dir, "../..");
/** C's staleness limit for its copy of A's device keys. */
const STALE_MS = 400;

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${daemon.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-placement-route-")));
  state = join(sandbox, "state");
  const profile = join(sandbox, "profile");
  await Promise.all([state, profile].map((path) => mkdir(path, { recursive: true })));
  process.env.ARBOR_DATA_HOME = state;
  profileTree = (await new ProfileIdentityStore().create(profile)).profileTree;
  configurationTree = treeConfigurationID(profileTree);
  // A is joe's home; B and C are run by their own owners.
  a = await serveHost({
    dataRoot: join(sandbox, "home"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "garden", firstWriter: { handle: "joe", profileTree } },
  });
  const placementHost = (name: string, handle: string, lifetimes?: Parameters<typeof serveHost>[0]["lifetimes"]) => serveHost({
    dataRoot: join(sandbox, name), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle, name: handle }, accounts: [testAccount("owner", `${name}-owner`, { communityWriter: true })],
    ...(lifetimes ? { lifetimes } : {}),
  });
  [b, c] = await Promise.all([
    placementHost("placement", "orchard"),
    placementHost("third", "meadow", { deviceKeyLifetimeMs: STALE_MS / 2, deviceKeyRefetchMs: STALE_MS / 4, deviceKeyStaleMs: STALE_MS }),
  ]);
  const local = await ArborSyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: local.trees, events: local.events }).claimHostAccount(`${a.url}/~joe`, profile, "Joe");
  } finally {
    await local[Symbol.asyncDispose]();
  }
  // joe's profile is readable by anyone, so B and C can resolve its locator.
  await makeProfilePublic((await accountProtocolClient({ configurationTree }, { required: true })).client, profileTree);
  const child = Bun.spawn(["bun", "packages/arborsync/src/cli.ts", "--control", "--port", "0"], {
    cwd: repository, env: { ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_CREDENTIAL_STORE: "file" }, stdout: "pipe", stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Arbor Sync exited before listening: ${output}`);
    output += new TextDecoder().decode(value);
    const match = /listening at (http:\/\/\S+)/.exec(output);
    if (match) { reader.releaseLock(); daemon = { child, url: match[1]! }; break; }
  }
}, 60_000);

afterAll(async () => {
  daemon?.child.kill();
  await daemon?.child.exited;
  for (const host of [c, b, a]) {
    host?.server.stop(true);
    await host?.canopy[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("POST /v1/bootstrap/placements", () => {
  test("refuses a body without a host", async () => {
    const response = await post("/v1/bootstrap/placements", {});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid-request");
  });

  test("refuses the profile's home host", async () => {
    const response = await post("/v1/bootstrap/placements", { host: a.url });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("conflict");
    expect(response.body.message).toContain("home host");
  });

  test("a host that reserved nothing for this profile says what to reserve", async () => {
    const response = await post("/v1/bootstrap/placements", { host: b.url });
    expect(response.status).toBe(404);
    expect(response.body.message).toContain(`reserve ${new URL(a.url).origin}/~joe`);
  });

  test("connects to the placement account B's community reserved, records it, and connects again idempotently", async () => {
    const bOrigin = new URL(b.url).origin;
    await reserveMembers(await deviceClient(b.url, "placement-owner"), sandbox, { joe: `${new URL(a.url).origin}/~joe` });
    const claimed = await post("/v1/bootstrap/placements", { host: b.url });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      placement: { configurationTree, origin: bOrigin, account: `${bOrigin}/~joe`, profileTree, homeHost: new URL(a.url).origin, placed: true },
    });
    process.env.ARBOR_DATA_HOME = state;
    const record = await new HostPlacementStore(configurationTree, bOrigin).safe();
    expect(record).toEqual(claimed.body.placement as never);
    // The daemon's credential route now serves B's session, which reads the placement account.
    const credential = await fetch(`${daemon.url}/v1/credential?configurationTree=${configurationTree}&origin=${encodeURIComponent(bOrigin)}`);
    const { token } = await credential.json() as { token: string };
    const { account } = await new ProtocolClient(bOrigin, token).placementAccount();
    expect(account.placementRoot.id).toBe(record!.placementRoot);
    expect(account.placementRoot.tree ?? null).toBeNull();

    const again = await post("/v1/bootstrap/placements", { host: `${b.url}/~joe` });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ placement: claimed.body.placement });
    // The home connection is untouched.
    expect((await new HostAccountStore(configurationTree).safe())!.origin).toBe(new URL(a.url).origin);
  }, 30_000);

  test("keeps a placement host's error code and details.homeHost when the home host is unreachable", async () => {
    const homeOrigin = new URL(a.url).origin;
    await reserveMembers(await deviceClient(c.url, "third-owner"), sandbox, { joe: `${homeOrigin}/~joe` });
    expect((await post("/v1/bootstrap/placements", { host: c.url })).status).toBe(200);
    a.server.stop(true);
    // Once C's copy of A's device keys is too old, C cannot open this device's session.
    await Bun.sleep(STALE_MS * 2);
    const response = await post("/v1/bootstrap/placements", { host: c.url });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: "internal-error", retryable: true, details: { homeHost: homeOrigin } });
    expect(response.body.message).toContain(homeOrigin);
  }, 30_000);
});
