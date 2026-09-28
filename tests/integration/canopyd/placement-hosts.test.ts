import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import {
  accountChallengeBytes,
  activationElement,
  decodeProtocolDirectory,
  deviceSessionChallengeBytes,
  generateArborID,
  initialPersonConfig,
  personProfileTreeID,
  ProtocolClient,
  snapshotTreeConfig,
  treeConfigurationID,
  ProtocolHTTPError,
  type TreeSnapshot,
} from "@overstory/protocol";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { editTreeConfig, hostTree, readTreeConfig } from "../../helpers/tree-config.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

/**
 * Security 007 and 011: B's community reserves ~alice by the locator of her
 * profile at her home host A, which makes her a placement account on B that
 * reads A's published device keys (accounts §1.3, §5.4). B keeps serving its
 * copy through a grace while A is down, and a rule on B naming a group A
 * holds, by its locator there, matches that group's members (access control
 * §3.3); each locator is pinned to the TreeID it first resolved to (locators
 * §1). Both hosts are local canopyd instances; B reads A through proxies the
 * test can count and cut, with lifetimes short enough to watch them run out.
 */

const LIFETIME_MS = 1_000;
const REFETCH_MS = 400;
/** The grace, longer than the lifetime as the one hour is than the minute. */
const STALE_MS = 3_000;
/** A remote group's copy: the same lifetime and interval, and its own grace. */
const GROUP_STALE_MS = 3_000;

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
/** When each fetch of A's device keys reached A, by profile. */
const keyFetchTimes: number[] = [];
/** B reads the groups A holds through this proxy: the `homeHost` B's rules name for them. */
let groupProxy: ReturnType<typeof Bun.serve>;
let groupHost: string;
let groupHostReachable = true;

/** Reserve handles on a host's community, as its owner: each for a Profile
 * TreeID, or for a profile another host holds, by its locator there. */
async function reserve(url: string, ownerName: string, members: Record<string, string>): Promise<void> {
  const owner = await deviceClient(url, ownerName);
  const account = await owner.account();
  const community = await owner.descriptor(account.account.community.id);
  const source = join(sandbox, `community-${crypto.randomUUID()}`);
  await mkdir(source, { recursive: true });
  const lines = ["---", "type: group", "members:",
    "  -", `    profile: "arbor://${account.account.profileTree!}/"`, `    handle: "owner"`,
    ...Object.entries(members).flatMap(([handle, profile]) => ["  -", `    profile: "${profile.startsWith("tr_") ? `arbor://${profile}/` : profile}"`, `    handle: "${handle}"`]),
    "---", "", "# Garden", ""];
  await writeFile(join(source, "_index.md"), lines.join("\n"));
  // Every tree the community root mounts keeps its entry: only _index.md changes.
  const head = await owner.snapshot(community.tree.id, community.tree.root);
  const mounted = decodeProtocolDirectory(head.objects.get(head.root)!).entries.flatMap((entry) =>
    entry.tree ? [[join(source, entry.name), entry.tree] as [string, string]] : []);
  const next = await resolveSnapshot(await snapshotDirectory(source, new Map(mounted)));
  await owner.submitUpdate(community.tree.id, community.tree.update, next);
}

async function openSession(url: string, profileTree: string, device: string, key: Key): Promise<ProtocolClient> {
  const anonymous = new ProtocolClient(url);
  const challenge = await anonymous.createDeviceSessionChallenge({ profileTree, device });
  const session = await anonymous.openDeviceSession(challenge, key.sign(deviceSessionChallengeBytes(challenge)));
  return new ProtocolClient(url, session.token);
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
    lifetimes: {
      deviceKeyLifetimeMs: LIFETIME_MS, deviceKeyRefetchMs: REFETCH_MS, deviceKeyStaleMs: STALE_MS,
      remoteGroupLifetimeMs: LIFETIME_MS, remoteGroupRefetchMs: REFETCH_MS, remoteGroupStaleMs: GROUP_STALE_MS,
    },
  });
  proxy = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!homeReachable) return new Response("unreachable", { status: 502 });
      if (url.pathname.endsWith("/device-keys")) { keyFetches += 1; keyFetchTimes.push(Date.now()); }
      return fetch(`${a.url}${url.pathname}${url.search}`, { method: request.method, headers: request.headers });
    },
  });
  homeHost = proxy.url.origin;
  groupProxy = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!groupHostReachable) return new Response("unreachable", { status: 502 });
      return fetch(`${a.url}${url.pathname}${url.search}`, { method: request.method, headers: request.headers });
    },
  });
  groupHost = groupProxy.url.origin;

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
    configuration: activationElement(snapshotTreeConfig(publicProfile(initialPersonConfig(alice.profileTree, { id: macID, label: "Alice's Mac", key: mac.key })))),
  });
  const macAtA = await openSession(a.url, alice.profileTree, macID, mac);
  // Her profile is readable by anyone, so another host can resolve /~alice.
  await macAtA.submitUpdate(alice.profileTree, null, await snapshotOf({ "_index.md": "---\ntype: person\ndisplayName: Alice\n---\n" }));
  const offer = await macAtA.createPairing();
  await new ProtocolClient(a.url).claimPairing(offer.id, offer.secret, { id: phoneID, label: "Alice's phone", key: phone.key });

  // B reserves ~bob for a profile of its own; ~alice comes below.
  await reserve(b.url, "placement-owner-b", { bob: bob.profileTree });
});

/** A person configuration whose profile anyone may read. */
function publicProfile<T extends { access: unknown[] }>(config: T): T {
  return { ...config, access: [...config.access, { who: "everyone", allow: ["read"] }] };
}

afterAll(async () => {
  proxy?.stop(true);
  groupProxy?.stop(true);
  for (const host of [b, a]) {
    host?.server.stop(true);
    await host?.canopy[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

let placementRoot: string;

describe("reserving a placement account (accounts §1.3)", () => {
  test("B refuses a reservation it cannot resolve, naming the host, and records nothing", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("gone", { status: 404 }) });
    const unreadable = closed.url.origin;
    closed.stop(true);
    const refused = await reserve(b.url, "placement-owner-b", { bob: bob.profileTree, carol: `${unreadable}/~carol` }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProtocolHTTPError);
    expect(refused).toMatchObject({ status: 503, retryable: true, details: { homeHost: unreadable } });
    // A locator A answers but that names no readable profile is refused outright.
    await expect(reserve(b.url, "placement-owner-b", { bob: bob.profileTree, carol: `${homeHost}/~nobody` })).rejects.toThrow("does not name a readable profile");
    expect(b.canopy.account(alice.profileTree)).toBeNull();
  });

  test("B records the placement account with its home host and declares the placement root at /~alice", async () => {
    const before = keyFetches;
    await reserve(b.url, "placement-owner-b", { alice: `${homeHost}/~alice`, bob: bob.profileTree });
    // B checked that A publishes her device keys before recording her.
    expect(keyFetches).toBe(before + 1);
    expect(b.canopy.account(alice.profileTree)).toEqual({ id: alice.profileTree, handle: "alice", enabled: true, homeHost });
    placementRoot = b.canopy.placementRootOf(b.canopy.account(alice.profileTree)!)!;
    expect(placementRoot).toMatch(/^tr_/);
    // A home claim of the same profile is refused.
    const bOrigin = new URL(b.url).origin;
    await expect(new ProtocolClient(b.url).createAccountChallenge({ account: `${bOrigin}/~alice`, profileTree: alice.profileTree, configurationTree: treeConfigurationID(alice.profileTree) }))
      .rejects.toThrow();
    // B never republishes the keys it read.
    await expect(new ProtocolClient(b.url).publishedDeviceKeys(alice.profileTree)).rejects.toThrow("not-found");
  });

  test("a challenge naming an unknown DeviceID refetches A's keys at most once per interval", async () => {
    const anonymous = new ProtocolClient(b.url);
    const unknown = () => anonymous.createDeviceSessionChallenge({ profileTree: alice.profileTree, device: generateArborID("dv") });
    // However many arrive, A is asked at most once per interval: a challenge
    // for an unknown device waits out the interval of the last fetch, and
    // those waiting share the one fetch that follows.
    const from = keyFetchTimes.length;
    for (let round = 0; round < 2; round++) {
      await Promise.all([0, 1].map(() => expect(unknown()).rejects.toThrow("not-found")));
    }
    const times = keyFetchTimes.slice(from - 1);
    expect(times.length).toBeGreaterThan(1);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(REFETCH_MS - 50);
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
    expect(account).toMatchObject({ profileTree: alice.profileTree, homeHost, handle: "alice", device: { id: macID }, placementRoot: { id: placementRoot, path: "/~alice", tree: null } });
    expect(account).not.toHaveProperty("configuration");
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
    // A session on B ends when the copy it opened from runs out of grace.
    macAtB = await openSession(b.url, alice.profileTree, macID, mac);
    phoneAtB = await openSession(b.url, alice.profileTree, phoneID, phone);
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

  test("a session on B ends by the time the copy it opened from runs out of grace", async () => {
    const challenge = await new ProtocolClient(b.url).createDeviceSessionChallenge({ profileTree: alice.profileTree, device: macID });
    const opened = Date.now();
    const session = await new ProtocolClient(b.url).openDeviceSession(challenge, mac.sign(deviceSessionChallengeBytes(challenge)));
    expect(session.expiresAt).toBeLessThanOrEqual(opened + STALE_MS + 50);
    expect(session.expiresAt).toBeGreaterThan(opened + STALE_MS - LIFETIME_MS - 100);
  });

  test("with A unreachable, B opens sessions and takes administrator edits from its copy through the grace, then refuses and its sessions end", async () => {
    homeReachable = false;
    const cut = Date.now();
    try {
      // Past the copy's lifetime, within the grace.
      await Bun.sleep(LIFETIME_MS + 200);
      const during = await openSession(b.url, alice.profileTree, macID, mac);
      expect((await during.descriptor(notes)).tree.id).toBe(notes);
      await editTreeConfig(during, notes, "tree", (values) => ({ ...values, access: [...values.access, { who: "everyone", allow: ["read"] }] }));
      await expect(openSession(b.url, alice.profileTree, generateArborID("dv"), mac)).rejects.toThrow("not-found");
      // Past the grace: no new session, and the ones open have ended.
      await Bun.sleep(Math.max(0, cut + STALE_MS + 200 - Date.now()));
      const response = await fetch(`${b.url}/.arbor/device-sessions/challenges`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileTree: alice.profileTree, device: macID }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ retryable: true, details: { homeHost } });
      await expect(during.descriptor(notes)).rejects.toThrow("unauthenticated");
      await expect(macAtB.descriptor(notes)).rejects.toThrow("unauthenticated");
    } finally {
      homeReachable = true;
    }
    const again = await until(async () => (await openSession(b.url, alice.profileTree, macID, mac).catch(() => undefined)) ?? undefined, 2_000);
    await editTreeConfig(again, notes, "tree", (values) => ({ ...values, access: values.access.filter((rule) => rule.who !== "everyone") }));
  });
});

describe("a rule on B naming a group A holds by its locator (access control §3.3, locators §1)", () => {
  let ownerA: ProtocolClient;
  let ownerProfile: string;
  let club: string;
  let orchard: string;
  const clubAt = () => `${groupHost}/~owner/club`;

  let session: ProtocolClient | undefined;
  /** Alice on B: one session, opened again once it ends (a session on B
   * lasts no longer than the grace), as a client would. */
  async function aliceAtB(): Promise<ProtocolClient> {
    session ??= await openSession(b.url, alice.profileTree, macID, mac);
    try {
      await session.placementAccount();
    } catch (error) {
      if (!(error instanceof ProtocolHTTPError) || error.status !== 401) throw error;
      session = await openSession(b.url, alice.profileTree, macID, mac);
    }
    return session;
  }
  const groupSource = (members: string[]) => snapshotOf({
    "_index.md": ["---", "type: group", "members:", ...members.flatMap((profile) => ["  -", `    profile: "arbor://${profile}/"`]),
      // A scalar entry names nobody.
      `  - "arbor://${bob.profileTree}/"`, "---", "", "# Club", ""].join("\n"),
  });
  async function setMembers(tree: string, members: string[]): Promise<void> {
    const current = await ownerA.descriptor(tree);
    await ownerA.submitUpdate(tree, current.tree.update, await groupSource(members));
  }
  /** Alice's whole-tree access to the orchard on B, from a fresh session. */
  async function aliceAccess(): Promise<string | null> {
    const client = await aliceAtB();
    try {
      return (await client.descriptor(orchard)).tree.access;
    } catch (error) {
      if (error instanceof ProtocolHTTPError && error.status === 404) return null;
      throw error;
    }
  }

  beforeAll(async () => {
    // A holds two groups listing alice, at /~owner/club and /~owner/secret:
    // the club is public, the secret is not.
    ownerA = await deviceClient(a.url, "placement-owner-a");
    ownerProfile = (await ownerA.account()).account.profileTree!;
    club = await hostTree(ownerA, await groupSource([alice.profileTree]), {
      access: [{ who: "everyone", allow: ["read"] }], parent: { tree: ownerProfile, name: "club", kind: "person" },
    });
    await hostTree(ownerA, await groupSource([alice.profileTree]), { parent: { tree: ownerProfile, name: "secret", kind: "person" } });
    // B's owner grants the club read on a tree of B's.
    const ownerB = await deviceClient(b.url, "placement-owner-b");
    orchard = await hostTree(ownerB, await snapshotOf({ "_index.md": "# Orchard\n" }), {
      access: [{ who: { profile: clubAt() }, allow: ["read"] }],
    });
  });

  test("a public remote group's member gains its access on B; a private group cannot be named", async () => {
    expect(await until(async () => (await aliceAccess()) ?? undefined, LIFETIME_MS + 1_000)).toBe("read");
    // B could not resolve the secret's locator, so no rule names it.
    const ownerB = await deviceClient(b.url, "placement-owner-b");
    await expect(editTreeConfig(ownerB, orchard, "tree", (values) => ({ ...values, access: [...values.access, { who: { profile: `${groupHost}/~owner/secret` }, allow: ["write"] }] })))
      .rejects.toThrow("does not name a readable profile");
    expect(await aliceAccess()).toBe("read");
    expect(b.canopy.pinnedProfile(orchard, clubAt())).toBe(club);
  });

  test("a member removed at A loses the access on B, and its watch ends, within the refresh", async () => {
    const watcher = await aliceAtB();
    const watching = (async () => {
      for await (const event of watcher.watch(orchard, null)) if (event.kind === "resync-required") return event;
      return null;
    })();
    await Bun.sleep(100);
    await setMembers(club, []);
    const removed = Date.now();
    expect(await Promise.race([watching, Bun.sleep(LIFETIME_MS + 1_000).then(() => "still open")]))
      .toMatchObject({ kind: "resync-required", reason: "Authorization was revoked" });
    expect(Date.now() - removed).toBeLessThan(LIFETIME_MS + 500);
    expect(await aliceAccess()).toBeNull();
    await setMembers(club, [alice.profileTree]);
    expect(await until(async () => (await aliceAccess()) ?? undefined, LIFETIME_MS + 1_000)).toBe("read");
  });

  test("with the group's host unreachable, B's copy serves through the grace, then matches nobody", async () => {
    groupHostReachable = false;
    const cut = Date.now();
    try {
      await Bun.sleep(LIFETIME_MS + 200);
      expect(await aliceAccess()).toBe("read");
      await Bun.sleep(Math.max(0, cut + GROUP_STALE_MS + LIFETIME_MS - Date.now()));
      expect(await aliceAccess()).toBeNull();
    } finally {
      groupHostReachable = true;
    }
    expect(await until(async () => (await aliceAccess()) ?? undefined, LIFETIME_MS + 1_000)).toBe("read");
  });

  test("another group at the locator makes the rule match nobody until the rule is saved again, which pins afresh", async () => {
    const other = await hostTree(ownerA, await groupSource([alice.profileTree]), { access: [{ who: "everyone", allow: ["read"] }] });
    await editTreeConfig(ownerA, ownerProfile, "person", (values) => ({ ...values, mounts: { ...values.mounts, club: other } }));
    expect(await until(async () => (await aliceAccess()) === null || undefined, LIFETIME_MS + 1_000)).toBe(true);
    expect(b.canopy.pinnedProfile(orchard, clubAt())).toBeNull();
    // Saving the rule again pins the locator to the group A names now.
    const ownerB = await deviceClient(b.url, "placement-owner-b");
    await editTreeConfig(ownerB, orchard, "tree", (values) => ({ ...values, access: [...values.access, { who: { profile: clubAt() }, allow: ["read"], within: "/notes" }] }));
    expect(b.canopy.pinnedProfile(orchard, clubAt())).toBe(other);
    expect(await until(async () => (await aliceAccess()) ?? undefined, LIFETIME_MS + 1_000)).toBe("read");
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

test("removing ~alice from B's members disables her placement account and ends its sessions; restoring it re-enables her", async () => {
  const macAtB = await openSession(b.url, alice.profileTree, macID, mac);
  await reserve(b.url, "placement-owner-b", { bob: bob.profileTree });
  expect(b.canopy.account(alice.profileTree)?.enabled).toBe(false);
  await expect(macAtB.placementAccount()).rejects.toThrow("unauthenticated");
  await expect(openSession(b.url, alice.profileTree, macID, mac)).rejects.toThrow();
  // Her placement root and its trees stay.
  expect(b.canopy.get(placementRoot)?.status).toBe("active");
  await reserve(b.url, "placement-owner-b", { alice: `${homeHost}/~alice`, bob: bob.profileTree });
  expect(b.canopy.account(alice.profileTree)?.enabled).toBe(true);
  expect(b.canopy.placementRootOf(b.canopy.account(alice.profileTree)!)).toBe(placementRoot);
  expect((await (await openSession(b.url, alice.profileTree, macID, mac)).placementAccount()).account.placementRoot.id).toBe(placementRoot);
});
