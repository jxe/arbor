import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  editProfileConfigurationFile,
  HostAccountStore,
  HostPlacementStore,
  parseAccountDevicesConfiguration,
  ProtocolClient,
  ProtocolHTTPError,
  treeConfigurationID,
} from "@overstory/protocol";
import { ArborSyncDaemon } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { accountProtocolClient, loadLocalPlacements, ProfileIdentityStore } from "@overstory/client";
import { LocalAccountService } from "../../packages/arborsync/src/account-service.ts";
import { ArborSyncRESTClient } from "../../packages/cli/src/daemon-client.ts";
import { makeProfilePublic, reserveMembers } from "../helpers/community-reservations.ts";
import { deviceClient, testAccount } from "../helpers/devices.ts";

/**
 * Security 007 and 011 gate: two local canopyd instances, home host A and
 * placement host B, and one Arbor Sync per device. B's community reserves the
 * profile by its locator at A; the first device's `arbor place` connects to
 * the placement account and places folders under its placement root; a second
 * device, paired at A as usual, places the same tree from its own data home,
 * connecting the same way. Both edit it through B. Revoking the second device
 * at A ends its session and watch on B within B's device-key lifetime, while
 * the first device keeps syncing.
 */

const LIFETIME_MS = 1_000;
const PASSPHRASE = "orchard placement passphrase";

let sandbox: string;
let stateMac: string;
let statePhone: string;
let profileTree: string;
let configurationTree: string;
let a: Awaited<ReturnType<typeof serveHost>>;
let b: Awaited<ReturnType<typeof serveHost>>;
let bOrigin: string;
const daemons: Array<{ child: ReturnType<typeof Bun.spawn>; url: string }> = [];
let mac: { url: string; client: ArborSyncRESTClient };
let phone: { url: string; client: ArborSyncRESTClient };
let rootFolder: string;
let researchMac: string;
let researchPhone: string;
let research: string;

const repository = join(import.meta.dir, "../..");
const environment = (state: string) => ({ ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_CREDENTIAL_STORE: "file" });

/** An Arbor Sync control service for one device's data home, in its own process. */
async function startArborSync(state: string): Promise<{ url: string; client: ArborSyncRESTClient }> {
  const child = Bun.spawn(["bun", "packages/arborsync/src/cli.ts", "--control", "--port", "0"], {
    cwd: repository, env: environment(state), stdout: "pipe", stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Arbor Sync exited before listening: ${output}`);
    output += new TextDecoder().decode(value);
    const match = /listening at (http:\/\/\S+)/.exec(output);
    if (match) {
      reader.releaseLock();
      daemons.push({ child, url: match[1]! });
      return { url: match[1]!, client: new ArborSyncRESTClient({ baseURL: match[1]! }) };
    }
  }
}

async function arbor(state: string, daemon: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: repository, env: { ...environment(state), ARBOR_SYNC_URL: daemon }, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

/** The accepted `_index.md` of a tree at B, read with an account session there. */
async function atB(token: string, tree: string, name = "_index.md"): Promise<string> {
  const client = new ProtocolClient(bOrigin, token);
  const { tree: descriptor } = await client.descriptor(tree);
  const snapshot = await client.snapshot(tree, descriptor.root);
  const { decodeProtocolDirectory } = await import("@overstory/protocol");
  const entry = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!).entries.find((candidate) => candidate.name === name);
  return new TextDecoder().decode(snapshot.objects.get(entry!.file!)!);
}

async function credential(daemon: string, origin: string): Promise<string> {
  const response = await fetch(`${daemon}/v1/credential?configurationTree=${configurationTree}&origin=${encodeURIComponent(origin)}`);
  if (!response.ok) throw new Error(`credential: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { token: string }).token;
}

async function post(daemon: string, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${daemon}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
}

async function idle(client: ArborSyncRESTClient, tree: string): Promise<boolean> {
  return (await client.trees()).snapshot.find((candidate) => candidate.id === tree)?.sync === "idle";
}

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-placement-host-")));
  stateMac = join(sandbox, "mac");
  statePhone = join(sandbox, "phone");
  const profileMac = join(sandbox, "profile-mac");
  await Promise.all([stateMac, statePhone, profileMac].map((path) => mkdir(path, { recursive: true })));
  process.env.ARBOR_DATA_HOME = stateMac;
  profileTree = (await new ProfileIdentityStore().create(profileMac)).profileTree;
  configurationTree = treeConfigurationID(profileTree);
  a = await serveHost({
    dataRoot: join(sandbox, "home"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "garden", firstWriter: { handle: "joe", profileTree } },
  });
  // A revocation reaches B through its refresh each lifetime; A stays
  // reachable, so the staleness limit (the grace, from Security 009) only
  // needs to outlast the test and never ends a session on its own.
  b = await serveHost({
    dataRoot: join(sandbox, "placement"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "orchard", name: "orchard" }, accounts: [testAccount("owner", "orchard-owner", { communityWriter: true })],
    lifetimes: { deviceKeyLifetimeMs: LIFETIME_MS, deviceKeyRefetchMs: 400, deviceKeyStaleMs: 120_000 },
  });
  bOrigin = new URL(b.url).origin;
  // The first device claims the home account at A, an administrator device.
  const daemon = await ArborSyncDaemon.open(profileMac);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${a.url}/~joe`, profileMac, "Joe");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
  // joe's profile is public at A, and B's community reserves it by its locator there.
  process.env.ARBOR_DATA_HOME = stateMac;
  await makeProfilePublic((await accountProtocolClient({ configurationTree }, { required: true })).client, profileTree);
  await reserveMembers(await deviceClient(b.url, "orchard-owner"), sandbox, { joe: `${new URL(a.url).origin}/~joe` });
  mac = await startArborSync(stateMac);
  phone = await startArborSync(statePhone);
}, 60_000);

afterAll(async () => {
  for (const { child } of daemons) child.kill();
  await Promise.all(daemons.map(({ child }) => child.exited));
  for (const host of [b, a]) {
    host?.server.stop(true);
    await host?.canopy[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("Arbor Sync places folders under a placement root", () => {
  test("the first device connects to B on first use and activates the placement root with a folder", async () => {
    rootFolder = join(sandbox, "orchard-root");
    await mkdir(rootFolder);
    await writeFile(join(rootFolder, "_index.md"), "# Joe at the orchard\n");
    expect(await arbor(stateMac, mac.url, ["place", rootFolder, `${bOrigin}/~joe`])).toContain(`${bOrigin}/~joe ↔ ${rootFolder}`);
    process.env.ARBOR_DATA_HOME = stateMac;
    const [record] = await HostPlacementStore.list();
    expect((await loadLocalPlacements()).placements).toContainEqual({ configurationTree, path: rootFolder, tree: record!.placementRoot, host: bOrigin });
    // The home connection holds no placement: nothing about A changed.
    expect((await new HostAccountStore(configurationTree).safe())!.origin).toBe(new URL(a.url).origin);
    await until(() => idle(mac.client, record!.placementRoot), 15_000, "the placement root to sync");
    const token = await credential(mac.url, bOrigin);
    const { account } = await new ProtocolClient(bOrigin, token).placementAccount();
    expect(account.placementRoot.tree).toMatchObject({ canonical: { path: "/~joe" }, access: "write" });
    expect(await atB(token, record!.placementRoot)).toBe("# Joe at the orchard\n");
    // Arbor Sync reports the tree at B's canonical address.
    const descriptor = (await mac.client.trees()).snapshot.find((candidate) => candidate.id === record!.placementRoot);
    expect(descriptor?.canonical).toMatchObject({ endpoint: bOrigin, path: "/~joe" });
  }, 60_000);

  test("the first device declares a new tree under the placement root from a folder", async () => {
    researchMac = join(sandbox, "research-mac");
    await mkdir(researchMac);
    await writeFile(join(researchMac, "_index.md"), "# Research\n");
    const output = await arbor(stateMac, mac.url, ["place", researchMac, `${bOrigin}/~joe/research`]);
    expect(output).toContain(`${bOrigin}/~joe/research ↔ ${researchMac}`);
    process.env.ARBOR_DATA_HOME = stateMac;
    research = (await loadLocalPlacements()).placements.find((placement) => placement.path === researchMac)!.tree;
    await until(() => idle(mac.client, research), 15_000, "the research tree to sync");
    const token = await credential(mac.url, bOrigin);
    expect((await new ProtocolClient(bOrigin, token).descriptor(research)).tree.canonical?.path).toBe("/~joe/research");
    expect(await atB(token, research)).toBe("# Research\n");
    // The tree is B's alone: A has never heard of it.
    await expect(new ProtocolClient(a.url, await credential(mac.url, new URL(a.url).origin)).descriptor(research)).rejects.toThrow();
    const listing = await arbor(stateMac, mac.url, ["account"]);
    expect(listing).toContain(`Placement: ${bOrigin}/~joe`);
    expect(listing).toContain(`${researchMac} (${research})`);
    // A tree never moves between hosts.
    await expect(arbor(stateMac, mac.url, ["mv", `${bOrigin}/~joe/research`, `${a.url}/~joe/research`])).rejects.toThrow("another Canopy is not supported");
  }, 60_000);

  test("a second device pairs at A, then places the same tree from its own data home", async () => {
    process.env.ARBOR_DATA_HOME = stateMac;
    const backup = join(sandbox, "identity-backup.json");
    await new ProfileIdentityStore().backup(backup, PASSPHRASE);
    const offer = await (await accountProtocolClient({ configurationTree }, { required: true })).client.createPairing();
    const profilePhone = join(sandbox, "profile-phone");
    await post(phone.url, "/v1/me/restore", { path: profilePhone, backup: JSON.parse(await readFile(backup, "utf8")), passphrase: PASSPHRASE });
    await post(phone.url, "/v1/bootstrap/pairings/claim", { payload: { version: 1, origin: new URL(a.url).origin, pairing: { id: offer.id, secret: offer.secret } } });
    // The account is already B's: the second device connects to it with its own key on first use.
    researchPhone = join(sandbox, "research-phone");
    const output = await arbor(statePhone, phone.url, ["place", `${bOrigin}/~joe/research`, researchPhone]);
    expect(output).toContain(researchPhone);
    process.env.ARBOR_DATA_HOME = statePhone;
    expect((await loadLocalPlacements()).placements).toEqual([{ configurationTree, path: researchPhone, tree: research, host: bOrigin }]);
    await until(async () => (await readFile(join(researchPhone, "_index.md"), "utf8")) === "# Research\n", 15_000, "the phone's folder");
  }, 60_000);

  test("both devices edit the tree through B", async () => {
    await until(() => idle(phone.client, research), 15_000, "the phone to be idle");
    await writeFile(join(researchPhone, "_index.md"), "# Research\n\nFrom the phone.\n");
    await until(async () => (await readFile(join(researchMac, "_index.md"), "utf8")).includes("From the phone."), 15_000, "the phone's edit on the Mac");
    await until(() => idle(mac.client, research), 15_000, "the Mac to be idle");
    await writeFile(join(researchMac, "_index.md"), "# Research\n\nFrom the phone.\n\nFrom the Mac.\n");
    await until(async () => (await readFile(join(researchPhone, "_index.md"), "utf8")).includes("From the Mac."), 15_000, "the Mac's edit on the phone");
    expect(await atB(await credential(mac.url, bOrigin), research)).toBe("# Research\n\nFrom the phone.\n\nFrom the Mac.\n");
  }, 60_000);

  test("revoking the phone at A ends its session and watch on B within the lifetime; the Mac keeps syncing", async () => {
    await until(() => idle(phone.client, research), 15_000, "the phone to be idle");
    const phoneToken = await credential(phone.url, bOrigin);
    process.env.ARBOR_DATA_HOME = statePhone;
    const phoneDevice = (await new HostAccountStore(configurationTree).safe())!.deviceID;
    const watching = (async () => {
      for await (const event of new ProtocolClient(bOrigin, phoneToken).watch(research, null)) if (event.kind === "resync-required") return event;
      return null;
    })();
    await Bun.sleep(100);

    // The Mac deletes the phone from the profile's devices.yaml; its Arbor Sync pushes the edit to A.
    process.env.ARBOR_DATA_HOME = stateMac;
    await editProfileConfigurationFile(configurationTree, "devices.yaml", (document) => { document.deleteIn([phoneDevice]); },
      (source) => { parseAccountDevicesConfiguration(source); });
    await mac.client.synchronizeNow(configurationTree);
    const revoked = Date.now();
    expect(await Promise.race([watching, Bun.sleep(LIFETIME_MS + 1_500).then(() => "still open")]))
      .toMatchObject({ kind: "resync-required", reason: "Authorization was revoked" });
    const refused = await new ProtocolClient(bOrigin, phoneToken).descriptor(research).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProtocolHTTPError);
    expect((refused as ProtocolHTTPError).status).toBe(401);
    expect(Date.now() - revoked).toBeLessThan(LIFETIME_MS + 1_500);
    // The phone's Arbor Sync, refused by B, forgets its session there and cannot open another.
    await until(async () => (await credential(phone.url, bOrigin).then(() => false, () => true)) || undefined, 10_000, "the phone's session at B to be forgotten");

    // An edit from the phone never reaches B; the Mac's edits keep syncing.
    await writeFile(join(researchPhone, "_index.md"), "# Research\n\nFrom the revoked phone.\n");
    await until(() => idle(mac.client, research), 15_000, "the Mac to be idle");
    await writeFile(join(researchMac, "_index.md"), "# Research\n\nFrom the phone.\n\nFrom the Mac.\n\nAfter the revocation.\n");
    const macToken = await credential(mac.url, bOrigin);
    await until(async () => (await atB(macToken, research)).includes("After the revocation."), 15_000, "the Mac's edit at B");
    await until(() => idle(mac.client, research), 15_000, "the Mac to be idle again");
    expect(await atB(macToken, research)).not.toContain("From the revoked phone.");
  }, 60_000);
});
