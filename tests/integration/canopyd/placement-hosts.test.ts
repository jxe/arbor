import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import {
  accountChallengeBytes,
  activationElement,
  deviceSessionChallengeBytes,
  generateArborID,
  initialPersonConfig,
  personProfileTreeID,
  ProtocolClient,
  snapshotTreeConfig,
  treeConfigurationID,
  ProtocolHTTPError,
  type AccountChallenge,
  type TreeSnapshot,
} from "@overstory/protocol";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { editTreeConfig, hostTree, readTreeConfig } from "../../helpers/tree-config.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

/**
 * Security 007: a profile whose home is host A claims a placement account on
 * host B, which reads A's published device keys (accounts §1.3, §5.4). Both
 * hosts are local canopyd instances; B reads A through a proxy the test can
 * count and cut, with lifetimes short enough to watch them run out.
 */

const LIFETIME_MS = 1_000;
const REFETCH_MS = 400;
/** The staleness limit; Security 009 will make it longer than the lifetime. */
const STALE_MS = 1_000;

interface Key { key: string; sign(bytes: Uint8Array): string }

function ed25519Key(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12);
  return { key: `ed25519:${raw.toString("base64url")}`, sign: (bytes) => sign(null, bytes, privateKey).toString("base64url") };
}

function profileIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12);
  return {
    profileTree: personProfileTreeID(raw),
    publicKey: raw.toString("base64url"),
    sign: (bytes: Uint8Array) => sign(null, bytes, privateKey).toString("base64url"),
  };
}

function snapshotOf(files: Record<string, string>): Promise<TreeSnapshot> {
  return (async () => {
    const directory = await mkdtemp(join(sandbox, "snapshot-"));
    for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
    return resolveSnapshot(await snapshotDirectory(directory));
  })();
}

const alice = profileIdentity();
const bob = profileIdentity();
const mac = ed25519Key(), macID = generateArborID("dv");
const phone = ed25519Key(), phoneID = generateArborID("dv");
let sandbox: string;
let a: Awaited<ReturnType<typeof serveHost>>;
let b: Awaited<ReturnType<typeof serveHost>>;
let proxy: ReturnType<typeof Bun.serve>;
/** B reads A's device keys through the proxy; this is what B was told is alice's home. */
let homeHost: string;
let homeReachable = true;
let keyFetches = 0;

/** Reserve handles on a host's community for exact profiles, as its owner. */
async function reserve(url: string, ownerName: string, members: Record<string, string>): Promise<void> {
  const owner = await deviceClient(url, ownerName);
  const account = await owner.account();
  const community = await owner.descriptor(account.account.community.id);
  const source = join(sandbox, `community-${crypto.randomUUID()}`);
  await mkdir(source, { recursive: true });
  const lines = ["---", "type: group", "members:",
    "  -", `    profile: "arbor://${account.account.profileTree!}/"`, `    handle: "owner"`,
    ...Object.entries(members).flatMap(([handle, profile]) => ["  -", `    profile: "arbor://${profile}/"`, `    handle: "${handle}"`]),
    "---", "", "# Garden", ""];
  await writeFile(join(source, "_index.md"), lines.join("\n"));
  const next = await resolveSnapshot(await snapshotDirectory(source, new Map([[join(source, "~owner"), account.account.profileTree!]])));
  await owner.submitUpdate(community.tree.id, community.tree.update, next);
}

async function openSession(url: string, profileTree: string, device: string, key: Key): Promise<ProtocolClient> {
  const anonymous = new ProtocolClient(url);
  const challenge = await anonymous.createDeviceSessionChallenge({ profileTree, device });
  const session = await anonymous.openDeviceSession(challenge, key.sign(deviceSessionChallengeBytes(challenge)));
  return new ProtocolClient(url, session.token);
}

/** A placement claim at B for `who`, signed by its profile key. */
async function placementClaim(who: ReturnType<typeof profileIdentity>, account: string, home: string) {
  const client = new ProtocolClient(b.url);
  const configurationTree = treeConfigurationID(who.profileTree);
  const challenge: AccountChallenge = await client.createAccountChallenge({ account, profileTree: who.profileTree, configurationTree, homeHost: home });
  return {
    challenge,
    claim: () => client.claimPlacementAccount({
      account, profileTree: who.profileTree, configurationTree, challenge,
      publicKey: who.publicKey, signature: who.sign(accountChallengeBytes(challenge)),
    }),
  };
}

async function until<T>(check: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-placement-hosts-"));
  a = await serveHost({
    dataRoot: join(sandbox, "a"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [testAccount("owner", "placement-owner-a", { communityWriter: true })],
  });
  b = await serveHost({
    dataRoot: join(sandbox, "b"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "orchard", name: "Orchard" },
    accounts: [testAccount("owner", "placement-owner-b", { communityWriter: true })],
    lifetimes: { deviceKeyLifetimeMs: LIFETIME_MS, deviceKeyRefetchMs: REFETCH_MS, deviceKeyStaleMs: STALE_MS },
  });
  proxy = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!homeReachable) return new Response("unreachable", { status: 502 });
      if (url.pathname.endsWith("/device-keys")) keyFetches += 1;
      return fetch(`${a.url}${url.pathname}${url.search}`, { method: request.method, headers: request.headers });
    },
  });
  homeHost = proxy.url.origin;

  // Alice's home is A: she claims ~alice there with her Mac, an
  // administrator device, and pairs her phone, an ordinary one.
  await reserve(a.url, "placement-owner-a", { alice: alice.profileTree });
  const origin = new URL(a.url).origin;
  const configurationTree = treeConfigurationID(alice.profileTree);
  const home = new ProtocolClient(a.url);
  const challenge = await home.createAccountChallenge({ account: `${origin}/~alice`, profileTree: alice.profileTree, configurationTree });
  await home.joinAccount({
    account: `${origin}/~alice`, profileTree: alice.profileTree, configurationTree, challenge,
    publicKey: alice.publicKey, signature: alice.sign(accountChallengeBytes(challenge)),
    device: { id: macID, label: "Alice's Mac", key: mac.key },
    configuration: activationElement(snapshotTreeConfig(initialPersonConfig(alice.profileTree, { id: macID, label: "Alice's Mac", key: mac.key }))),
  });
  const macAtA = await openSession(a.url, alice.profileTree, macID, mac);
  const offer = await macAtA.createPairing();
  await new ProtocolClient(a.url).claimPairing(offer.id, offer.secret, { id: phoneID, label: "Alice's phone", key: phone.key });

  // B reserves ~alice for her and ~bob for someone else.
  await reserve(b.url, "placement-owner-b", { alice: alice.profileTree, bob: bob.profileTree });
});

afterAll(async () => {
  proxy?.stop(true);
  for (const host of [b, a]) {
    host?.server.stop(true);
    await host?.canopy[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

let placementRoot: string;

describe("claiming a placement account (accounts §1.3)", () => {
  test("B refuses its own origin as the home host, an unreadable home host, and another profile's reservation", async () => {
    const bOrigin = new URL(b.url).origin;
    await expect(placementClaim(alice, `${bOrigin}/~alice`, bOrigin)).rejects.toThrow("names another host");

    // A home host that does not answer: the challenge is issued, the claim refused, and nothing recorded.
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("gone", { status: 404 }) });
    const unreadable = closed.url.origin;
    closed.stop(true);
    const attempt = await placementClaim(alice, `${bOrigin}/~alice`, unreadable);
    expect(attempt.challenge.homeHost).toBe(unreadable);
    await expect(attempt.claim()).rejects.toThrow("does not publish its device keys");
    expect(b.canopy.account(alice.profileTree)).toBeNull();

    // ~bob is reserved for another profile.
    await expect(placementClaim(alice, `${bOrigin}/~bob`, homeHost)).rejects.toThrow("exact profile reservation");

    // A signature over a challenge whose home host was altered does not verify.
    const honest = await placementClaim(alice, `${bOrigin}/~alice`, homeHost);
    const client = new ProtocolClient(b.url);
    const altered = { ...honest.challenge, homeHost: unreadable };
    await expect(client.claimPlacementAccount({
      account: `${bOrigin}/~alice`, profileTree: alice.profileTree, configurationTree: treeConfigurationID(alice.profileTree),
      challenge: altered, publicKey: alice.publicKey, signature: alice.sign(accountChallengeBytes(altered)),
    })).rejects.toThrow("invalid");
  });

  test("B records the placement account with its home host and declares the placement root at /~alice", async () => {
    const bOrigin = new URL(b.url).origin;
    const { claim } = await placementClaim(alice, `${bOrigin}/~alice`, homeHost);
    const before = keyFetches;
    const result = await claim();
    expect(keyFetches).toBe(before + 1);
    expect(result.account).toMatchObject({
      id: alice.profileTree, handle: "alice", profileTree: alice.profileTree, profileURL: null, homeHost,
      placementRoot: { path: "/~alice", tree: null },
    });
    expect(result.account).not.toHaveProperty("configuration");
    placementRoot = result.account.placementRoot.id;
    expect(b.canopy.account(alice.profileTree)).toEqual({ id: alice.profileTree, handle: "alice", enabled: true, homeHost });
    // An exact replay answers the same account; a home claim of the same profile is refused.
    expect((await claim()).account.placementRoot.id).toBe(placementRoot);
    const home = new ProtocolClient(b.url);
    await expect(home.createAccountChallenge({ account: `${bOrigin}/~alice`, profileTree: alice.profileTree, configurationTree: treeConfigurationID(alice.profileTree) }))
      .rejects.toThrow();
    // B never republishes the keys it read.
    await expect(new ProtocolClient(b.url).publishedDeviceKeys(alice.profileTree)).rejects.toThrow("not-found");
  });

  test("a challenge naming an unknown DeviceID refetches A's keys at most once per interval", async () => {
    const anonymous = new ProtocolClient(b.url);
    const unknown = () => anonymous.createDeviceSessionChallenge({ profileTree: alice.profileTree, device: generateArborID("dv") });
    // The claim just fetched: nothing refetches within the interval.
    const start = keyFetches;
    for (let i = 0; i < 3; i++) await expect(unknown()).rejects.toThrow("not-found");
    expect(keyFetches).toBe(start);
    await Bun.sleep(REFETCH_MS + 50);
    await expect(unknown()).rejects.toThrow("not-found");
    expect(keyFetches).toBe(start + 1);
    for (let i = 0; i < 3; i++) await expect(unknown()).rejects.toThrow("not-found");
    expect(keyFetches).toBe(start + 1);
  });
});

describe("sessions and trees on a placement host", () => {
  let macAtB: ProtocolClient;
  let phoneAtB: ProtocolClient;
  let notes: string;

  test("each device A lists opens a session on B with its own key, bound to B", async () => {
    macAtB = await openSession(b.url, alice.profileTree, macID, mac);
    phoneAtB = await openSession(b.url, alice.profileTree, phoneID, phone);
    const { account } = await macAtB.placementAccount();
    expect(account).toMatchObject({ profileTree: alice.profileTree, homeHost, handle: "alice", device: { id: macID } });
    await expect(macAtB.account()).rejects.toThrow("placement host");
    // A session opened on B is B's alone.
    await expect(new ProtocolClient(a.url, (await (async () => {
      const challenge = await new ProtocolClient(b.url).createDeviceSessionChallenge({ profileTree: alice.profileTree, device: macID });
      return (await new ProtocolClient(b.url).openDeviceSession(challenge, mac.sign(deviceSessionChallengeBytes(challenge)))).token;
    })())).account()).rejects.toThrow("unauthenticated");
    // A key A does not list for that device does not sign in.
    const challenge = await new ProtocolClient(b.url).createDeviceSessionChallenge({ profileTree: alice.profileTree, device: macID });
    await expect(new ProtocolClient(b.url).openDeviceSession(challenge, phone.sign(deviceSessionChallengeBytes(challenge)))).rejects.toThrow("permission-denied");
  });

  test("B has no configuration of the profile: its pairing and configuration routes name the home host", async () => {
    const refused = await macAtB.createPairing().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProtocolHTTPError);
    expect(refused).toMatchObject({ status: 403, code: "permission-denied", details: { homeHost } });
    expect((refused as Error).message).toContain(`home host ${homeHost}`);
    await expect(macAtB.treeConfiguration(alice.profileTree)).rejects.toThrow(`home host ${homeHost}`);
    expect(() => b.canopy.createRecoveryPairing("alice")).toThrow(`home host ${homeHost}`);
  });

  test("an administrator device activates the placement root and places a tree under it", async () => {
    await macAtB.submitUpdate(placementRoot, null, await snapshotOf({ "_index.md": "# Alice at the orchard\n" }));
    const { account } = await macAtB.placementAccount();
    expect(account.placementRoot.tree).toMatchObject({ id: placementRoot, canonical: { path: "/~alice" }, access: "write" });
    notes = await hostTree(macAtB, await snapshotOf({ "_index.md": "# Notes\n" }), {
      parent: { tree: placementRoot, name: "notes", kind: "tree" },
      access: [{ who: "everyone", allow: ["read"] }],
    });
    expect((await macAtB.descriptor(notes)).tree.canonical?.path).toBe("/~alice/notes");
    expect(await (await fetch(`${b.url}/~alice/notes`, { headers: { accept: "text/markdown" } })).text()).toContain("# Notes");
  });

  test("both devices edit the tree; only the administrator device edits its configuration", async () => {
    const current = await phoneAtB.descriptor(notes);
    const edited = await phoneAtB.submitUpdate(notes, current.tree.update, await snapshotOf({ "_index.md": "# Notes\n\nFrom the phone.\n" }));
    expect(edited.outcome).toBe("accepted");
    const again = await macAtB.descriptor(notes);
    await macAtB.submitUpdate(notes, again.tree.update, await snapshotOf({ "_index.md": "# Notes\n\nFrom the phone.\n\nFrom the Mac.\n" }));

    await expect(editTreeConfig(phoneAtB, notes, "tree", (values) => ({ ...values, access: [...values.access, { who: { profile: bob.profileTree }, allow: ["read"] }] })))
      .rejects.toThrow("administrator device");
    await expect(phoneAtB.declareTree(generateArborID("tr"), snapshotTreeConfig({ access: [{ who: { profile: alice.profileTree }, allow: ["admin"] }], mounts: {} })))
      .rejects.toThrow("administrator device");
    await editTreeConfig(macAtB, notes, "tree", (values) => ({ ...values, access: values.access.filter((rule) => rule.who !== "everyone") }));
    expect((await readTreeConfig(macAtB, notes, "tree")).values.access).toEqual([{ who: { profile: alice.profileTree }, allow: ["admin"] }]);
  });

  test("deleting the phone at A ends its session and watch on B within the copy's lifetime", async () => {
    const watching = (async () => {
      for await (const event of phoneAtB.watch(notes, null)) if (event.kind === "resync-required") return event;
      return null;
    })();
    await Bun.sleep(100);
    const macAtA = await openSession(a.url, alice.profileTree, macID, mac);
    await editTreeConfig(macAtA, alice.profileTree, "person", (values) => {
      const { [phoneID]: _phone, ...rest } = values.devices!;
      return { ...values, devices: rest };
    });
    const deleted = Date.now();
    expect(await Promise.race([watching, Bun.sleep(LIFETIME_MS + 1_000).then(() => "still open")]))
      .toMatchObject({ kind: "resync-required", reason: "Authorization was revoked" });
    expect(Date.now() - deleted).toBeLessThan(LIFETIME_MS + 500);
    await expect(phoneAtB.descriptor(notes)).rejects.toThrow("unauthenticated");
    await expect(openSession(b.url, alice.profileTree, phoneID, phone)).rejects.toThrow("not-found");
    // The Mac is still listed and keeps working.
    expect((await macAtB.descriptor(notes)).tree.id).toBe(notes);
  });

  test("with A unreachable past the staleness limit, B opens no new session; open ones run to their expiry", async () => {
    homeReachable = false;
    try {
      await Bun.sleep(Math.max(LIFETIME_MS, STALE_MS) + 200);
      const response = await fetch(`${b.url}/.arbor/device-sessions/challenges`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileTree: alice.profileTree, device: macID }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ retryable: true, details: { homeHost } });
      // The session opened before is the backstop's to end, at its expiry.
      expect((await macAtB.descriptor(notes)).tree.id).toBe(notes);
    } finally {
      homeReachable = true;
    }
    await until(async () => (await openSession(b.url, alice.profileTree, macID, mac).catch(() => undefined)) ?? undefined, 2_000);
  });
});

test("the placement root's configuration is B's own, readable by its administrators through /~alice;arbor-config", async () => {
  const macAtB = await openSession(b.url, alice.profileTree, macID, mac);
  const resolved = await macAtB.resolveConfiguration("/~alice");
  expect(resolved.enclosingTree?.id).toBe(treeConfigurationID(placementRoot));
  const root = (await readTreeConfig(macAtB, placementRoot, "tree")).values;
  expect(root.access).toEqual([{ who: { profile: alice.profileTree }, allow: ["admin"] }]);
  expect(Object.values(root.mounts)).toHaveLength(1);
  expect(root.devices).toBeUndefined();
  expect(root.apps).toBeUndefined();
});
