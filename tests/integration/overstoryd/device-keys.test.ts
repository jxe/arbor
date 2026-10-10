import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import {
  accountChallengeBytes,
  activationElement,
  deviceSessionChallengeBytes,
  generateOverstoryID,
  initialPersonConfig,
  personProfileTreeID,
  ProtocolClient,
  snapshotTreeConfig,
  treeConfigurationID,
} from "@ovst/protocol";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { editTreeConfig, readTreeConfig } from "../../helpers/tree-config.ts";
import { deviceClient, signAsDevice, testAccount, testDevice } from "../../helpers/devices.ts";

/** A device key pair as a client holds it: the `devices.yaml` key and a signer. */
interface TestDeviceKey { key: string; sign(bytes: Uint8Array): string }

function ed25519Key(): TestDeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12);
  return { key: `ed25519:${raw.toString("base64url")}`, sign: (bytes) => sign(null, bytes, privateKey).toString("base64url") };
}

function p256Key(): TestDeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x, y } = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const odd = Buffer.from(y, "base64url")[31]! & 1;
  const compressed = Buffer.concat([Buffer.from([2 + odd]), Buffer.from(x, "base64url")]);
  return {
    key: `p256:${compressed.toString("base64url")}`,
    sign: (bytes) => sign("sha256", bytes, { key: privateKey as KeyObject, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  };
}

/** A person profile identity whose key the test holds, for claims and recovery. */
function profileIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12);
  return {
    profileTree: personProfileTreeID(raw),
    publicKey: raw.toString("base64url"),
    sign: (bytes: Uint8Array) => sign(null, bytes, privateKey).toString("base64url"),
  };
}

const ownerToken = "owner-device-credential";
const carol = profileIdentity();
let sandbox: string;
let running: Awaited<ReturnType<typeof serveHost>>;

async function openSession(profileTree: string, device: string, key: TestDeviceKey): Promise<ProtocolClient> {
  const anonymous = new ProtocolClient(running.url);
  const challenge = await anonymous.createDeviceSessionChallenge({ profileTree, device });
  const session = await anonymous.openDeviceSession(challenge, key.sign(deviceSessionChallengeBytes(challenge)));
  expect(session.device).toBe(device);
  return new ProtocolClient(running.url, session.token);
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-device-keys-"));
  running = await serveHost({
    dataRoot: join(sandbox, "overstoryd"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [testAccount("owner", ownerToken, { communityWriter: true })],
  });
  // Reserve ~carol for a self-certifying profile, so she can claim and recover.
  const owner = await deviceClient(running.url, ownerToken);
  const account = await owner.account();
  const community = await owner.descriptor(account.account.community.id);
  const source = join(sandbox, "community");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "_index.md"), [
    "---", "type: group", "members:",
    "  -", `    profile: "overstory://${account.account.profileTree!}/"`, `    handle: "owner"`,
    "  -", `    profile: "overstory://${carol.profileTree}/"`, `    handle: "carol"`,
    "---", "", "# Garden", "",
  ].join("\n"));
  const next = await resolveSnapshot(await snapshotDirectory(source, new Map([[join(source, "~owner"), account.account.profileTree!]])));
  await owner.submitUpdate(community.tree.id, community.tree.update, next);
});

afterAll(async () => {
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

let ownerState: { profileTree: string; macID: string; mac: TestDeviceKey } | undefined;
const ownerProfile = () => ownerState!.profileTree;
const ownerMac = () => ownerState!.macID;
const ownerKey = () => ownerState!.mac;

describe("key devices (accounts §5.1, §5.2)", () => {
  const owner = testDevice(ownerToken);
  const profileTree = owner.profileTree;
  const macID = owner.device;
  const mac: TestDeviceKey = { key: owner.key, sign: (bytes) => signAsDevice(ownerToken, bytes) };
  let macClient: ProtocolClient;

  test("every device is a key device, whose key never changes", async () => {
    macClient = await openSession(profileTree, macID, mac);
    expect((await macClient.account()).account.profileTree).toBe(profileTree);
    ownerState = { profileTree, macID, mac };
    expect((await readTreeConfig(macClient, profileTree, "person")).values.devices![macID]!.key).toBe(mac.key);
    // No bearer credential authenticates a device; only a session does.
    await expect(new ProtocolClient(running.url, ownerToken).account()).rejects.toThrow("unauthenticated");

    // A key never changes, nothing removes it, only pairing lists one, and no
    // entry is listed without one.
    await expect(editTreeConfig(macClient, profileTree, "person", (current) => ({
      ...current, devices: { ...current.devices, [macID]: { ...current.devices![macID]!, key: ed25519Key().key } },
    }))).rejects.toThrow("never changes");
    await expect(editTreeConfig(macClient, profileTree, "person", (current) => {
      const { key: _key, ...keyless } = current.devices![macID]!;
      return { ...current, devices: { ...current.devices, [macID]: keyless } };
    })).rejects.toThrow("never changes");
    const stranger = generateOverstoryID("dv");
    await expect(editTreeConfig(macClient, profileTree, "person", (current) => ({
      ...current, devices: { ...current.devices, [stranger]: { id: stranger, label: "Unpaired", administrator: false } },
    }))).rejects.toThrow("has no key");
    await expect(editTreeConfig(macClient, profileTree, "person", (current) => ({
      ...current, devices: { ...current.devices, [stranger]: { id: stranger, label: "Unpaired", administrator: false, key: ed25519Key().key } },
    }))).rejects.toThrow("only when it pairs");
  });

  test("a challenge is single use, bound to its host, and needs the device's own signature", async () => {
    const anonymous = new ProtocolClient(running.url);
    const challenge = await anonymous.createDeviceSessionChallenge({ profileTree, device: macID });
    const signature = mac.sign(deviceSessionChallengeBytes(challenge));
    await expect(anonymous.openDeviceSession(challenge, ed25519Key().sign(deviceSessionChallengeBytes(challenge)))).rejects.toThrow("permission-denied");
    const elsewhere = { ...challenge, origin: "https://other.example" };
    await expect(anonymous.openDeviceSession(elsewhere, mac.sign(deviceSessionChallengeBytes(elsewhere)))).rejects.toThrow("another host");
    await anonymous.openDeviceSession(challenge, signature);
    await expect(anonymous.openDeviceSession(challenge, signature)).rejects.toThrow("already used");
    // A challenge the host never issued is refused even when signed.
    const forged = { ...challenge, id: generateOverstoryID("ax") };
    await expect(anonymous.openDeviceSession(forged, mac.sign(deviceSessionChallengeBytes(forged)))).rejects.toThrow("already used");
  });

  test("a device paired with a P-256 key signs in, and deleting it ends its session", async () => {
    const phone = p256Key();
    const phoneID = generateOverstoryID("dv");
    const offer = await macClient.createPairing();
    const claimed = await new ProtocolClient(running.url).claimPairing(offer.id, offer.secret, { id: phoneID, label: "Phone", key: phone.key });
    expect(claimed.device.id).toBe(phoneID);
    expect((await readTreeConfig(macClient, profileTree, "person")).values.devices![phoneID]).toEqual({ id: phoneID, label: "Phone", administrator: false, key: phone.key });

    const phoneClient = await openSession(profileTree, phoneID, phone);
    expect((await phoneClient.account()).account.profileTree).toBe(profileTree);
    // An ordinary device may not add a key to anyone's entry but its own.
    await expect(editTreeConfig(phoneClient, profileTree, "person", (current) => ({
      ...current, devices: { ...current.devices, [macID]: { ...current.devices![macID]!, label: "Renamed" } },
    }))).rejects.toThrow();

    await editTreeConfig(macClient, profileTree, "person", (current) => {
      const { [phoneID]: _phone, ...rest } = current.devices!;
      return { ...current, devices: rest };
    });
    await expect(phoneClient.account()).rejects.toThrow("unauthenticated");
    await expect(new ProtocolClient(running.url).createDeviceSessionChallenge({ profileTree, device: phoneID })).rejects.toThrow("not-found");
  });

  test("a session stops working when it expires", async () => {
    const lifetime = running.overstoryd.sessionLifetimeMs;
    running.overstoryd.sessionLifetimeMs = 50;
    try {
      const short = await openSession(profileTree, macID, mac);
      expect((await short.account()).account.profileTree).toBe(profileTree);
      // A watch opened with the session ends with it (access control §3.2).
      const ended = (async () => {
        for await (const event of short.watch(profileTree, null)) if (event.kind === "resync-required") return event;
        return "ended";
      })();
      await Bun.sleep(80);
      await expect(short.account()).rejects.toThrow("unauthenticated");
      // Every route refuses it, so a client knows to open a new session rather than seeing "not found".
      await expect(short.descriptor(profileTree)).rejects.toThrow("unauthenticated");
      // It closes without resync-required: a snapshot would not help.
      expect(await ended).toBe("ended");
    } finally {
      running.overstoryd.sessionLifetimeMs = lifetime;
    }
  });
});

describe("published device keys (accounts §5.4)", () => {
  test("the home host publishes each listed key device, without labels or deleted devices", async () => {
    const owner = new ProtocolClient(running.url, (await (async () => {
      // The owner profile's phone was paired and deleted above.
      const challenge = await new ProtocolClient(running.url).createDeviceSessionChallenge({ profileTree: ownerProfile(), device: ownerMac() });
      return (await new ProtocolClient(running.url).openDeviceSession(challenge, ownerKey().sign(deviceSessionChallengeBytes(challenge)))).token;
    })()));
    const listed = (await readTreeConfig(owner, ownerProfile(), "person")).values.devices!;
    const published = await new ProtocolClient(running.url).publishedDeviceKeys(ownerProfile());
    expect(published).toEqual({
      profileTree: ownerProfile(),
      devices: Object.values(listed).flatMap((device) => device.key ? [{ id: device.id, key: device.key, administrator: device.administrator }] : []),
    });
    expect(published.devices.map((device) => device.id)).toEqual([ownerMac()]);
    const response = await fetch(`${running.url}/.overstory/profiles/${ownerProfile()}/device-keys`);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(JSON.stringify(await response.json())).not.toContain("label");
    await expect(new ProtocolClient(running.url).publishedDeviceKeys("tr_aaaaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toThrow("not-found");
  });
});

describe("recovery pairing (accounts §5.3)", () => {
  const laptop = ed25519Key();
  const laptopID = generateOverstoryID("dv");
  let laptopClient: ProtocolClient;

  test("a profile claimed with a key device signs in with it", async () => {
    const origin = new URL(running.url).origin;
    const configurationTree = treeConfigurationID(carol.profileTree);
    const client = new ProtocolClient(running.url);
    const challenge = await client.createAccountChallenge({ account: `${origin}/~carol`, profileTree: carol.profileTree, configurationTree });
    await client.joinAccount({
      account: `${origin}/~carol`,
      profileTree: carol.profileTree,
      configurationTree,
      challenge,
      publicKey: carol.publicKey,
      signature: carol.sign(accountChallengeBytes(challenge)),
      device: { id: laptopID, label: "Carol's laptop", key: laptop.key },
      configuration: activationElement(snapshotTreeConfig(initialPersonConfig(carol.profileTree, { id: laptopID, label: "Carol's laptop", key: laptop.key }))),
    });
    laptopClient = await openSession(carol.profileTree, laptopID, laptop);
    expect((await laptopClient.account()).account.profileTree).toBe(carol.profileTree);
  });

  test("an operator's recovery pairing makes the claiming device the only one, an administrator", async () => {
    // Carol has lost her laptop; the operator issues a recovery pairing for ~carol.
    const offer = running.overstoryd.createRecoveryPairing("carol");
    expect(offer.id.startsWith("pr_")).toBe(true);
    expect(offer.expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    // Until it is claimed, her devices keep working.
    expect((await laptopClient.account()).account.profileTree).toBe(carol.profileTree);

    const phone = p256Key();
    const phoneID = generateOverstoryID("dv");
    await new ProtocolClient(running.url).claimPairing(offer.id, offer.secret, { id: phoneID, label: "Carol's phone", key: phone.key });
    await expect(laptopClient.account()).rejects.toThrow("unauthenticated");
    await expect(new ProtocolClient(running.url).createDeviceSessionChallenge({ profileTree: carol.profileTree, device: laptopID })).rejects.toThrow("not-found");
    const phoneClient = await openSession(carol.profileTree, phoneID, phone);
    const { values } = await readTreeConfig(phoneClient, carol.profileTree, "person");
    expect(values.devices).toEqual({ [phoneID]: { id: phoneID, label: "Carol's phone", administrator: true, key: phone.key } });
    // A recovery pairing, like any pairing, is single use.
    await expect(new ProtocolClient(running.url).claimPairing(offer.id, offer.secret, { id: generateOverstoryID("dv"), label: "Again", key: ed25519Key().key }))
      .rejects.toThrow();
  });

  test("an ordinary pairing still adds an ordinary device beside the others", async () => {
    const owner = new ProtocolClient(running.url, (await (async () => {
      const challenge = await new ProtocolClient(running.url).createDeviceSessionChallenge({ profileTree: ownerProfile(), device: ownerMac() });
      return (await new ProtocolClient(running.url).openDeviceSession(challenge, ownerKey().sign(deviceSessionChallengeBytes(challenge)))).token;
    })()));
    const offer = await owner.createPairing();
    expect(offer.id.startsWith("pa_")).toBe(true);
    const tablet = ed25519Key();
    const tabletID = generateOverstoryID("dv");
    await new ProtocolClient(running.url).claimPairing(offer.id, offer.secret, { id: tabletID, label: "Tablet", key: tablet.key });
    const devices = (await readTreeConfig(owner, ownerProfile(), "person")).values.devices!;
    expect(devices[ownerMac()]!.administrator).toBe(true);
    expect(devices[tabletID]).toEqual({ id: tabletID, label: "Tablet", administrator: false, key: tablet.key });
  });
});
