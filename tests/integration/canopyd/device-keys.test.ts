import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import {
  accountChallengeBytes,
  deviceSessionChallengeBytes,
  generateArborID,
  initialPersonConfig,
  personProfileTreeID,
  profileResetChallengeBytes,
  ProtocolClient,
  snapshotTreeConfig,
  treeConfigurationID,
} from "@overstory/protocol";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { editTreeConfig, readTreeConfig } from "../../helpers/tree-config.ts";

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

/** A person profile identity whose key the test holds, for claims and resets. */
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
  sandbox = await mkdtemp(join(tmpdir(), "arbor-device-keys-"));
  running = await serveHost({
    dataRoot: join(sandbox, "canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden" },
    accounts: [{ handle: "owner", token: ownerToken, communityWriter: true }],
  });
  // Reserve ~carol for a self-certifying profile, so she can claim and reset.
  const owner = new ProtocolClient(running.url, ownerToken);
  const account = await owner.account();
  const community = await owner.descriptor(account.account.community.id);
  const source = join(sandbox, "community");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "_index.md"), [
    "---", "type: group", "members:",
    "  -", `    profile: "arbor://${account.account.profileTree!}/"`, `    handle: "owner"`,
    "  -", `    profile: "arbor://${carol.profileTree}/"`, `    handle: "carol"`,
    "---", "", "# Garden", "",
  ].join("\n"));
  const next = await resolveSnapshot(await snapshotDirectory(source, new Map([[join(source, "~owner"), account.account.profileTree!]])));
  await owner.submitUpdate(community.tree.id, community.tree.update, next);
});

afterAll(async () => {
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("key devices (accounts §5.1, §5.2)", () => {
  let profileTree: string;
  let macID: string;
  const mac = ed25519Key();
  let macClient: ProtocolClient;

  test("a digest device moves to a key once, and its credential stops working", async () => {
    const owner = new ProtocolClient(running.url, ownerToken);
    profileTree = (await owner.account()).account.profileTree!;
    const { values } = await readTreeConfig(owner, profileTree, "person");
    macID = Object.keys(values.devices!)[0]!;
    // Before the move there is no key to open a session with.
    await expect(new ProtocolClient(running.url).createDeviceSessionChallenge({ profileTree, device: macID })).rejects.toThrow("not-found");

    await editTreeConfig(owner, profileTree, "person", (current) => ({
      ...current, devices: { ...current.devices, [macID]: { ...current.devices![macID]!, key: mac.key } },
    }));
    await expect(owner.account()).rejects.toThrow("unauthenticated");

    macClient = await openSession(profileTree, macID, mac);
    expect((await macClient.account()).account.profileTree).toBe(profileTree);
    expect((await readTreeConfig(macClient, profileTree, "person")).values.devices![macID]!.key).toBe(mac.key);

    // A key never changes, and nothing removes it.
    await expect(editTreeConfig(macClient, profileTree, "person", (current) => ({
      ...current, devices: { ...current.devices, [macID]: { ...current.devices![macID]!, key: ed25519Key().key } },
    }))).rejects.toThrow("never changes");
    await expect(editTreeConfig(macClient, profileTree, "person", (current) => {
      const { key: _key, ...digest } = current.devices![macID]!;
      return { ...current, devices: { ...current.devices, [macID]: digest } };
    })).rejects.toThrow("never changes");
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
    const forged = { ...challenge, id: generateArborID("ax") };
    await expect(anonymous.openDeviceSession(forged, mac.sign(deviceSessionChallengeBytes(forged)))).rejects.toThrow("already used");
  });

  test("a device paired with a P-256 key signs in, and deleting it ends its session", async () => {
    const phone = p256Key();
    const phoneID = generateArborID("dv");
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
    const lifetime = running.canopy.sessionLifetimeMs;
    running.canopy.sessionLifetimeMs = 50;
    try {
      const short = await openSession(profileTree, macID, mac);
      expect((await short.account()).account.profileTree).toBe(profileTree);
      // A watch opened with the session ends with it (access control §3.2).
      const ended = (async () => {
        for await (const event of short.watch(profileTree, null)) if (event.kind === "resync-required") return event;
        return null;
      })();
      await Bun.sleep(80);
      await expect(short.account()).rejects.toThrow("unauthenticated");
      expect(await ended).toMatchObject({ kind: "resync-required", reason: "Authorization was revoked" });
    } finally {
      running.canopy.sessionLifetimeMs = lifetime;
    }
  });
});

describe("profile-key reset (accounts §5.3)", () => {
  const laptop = ed25519Key();
  const laptopID = generateArborID("dv");
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
      configuration: snapshotTreeConfig(initialPersonConfig(carol.profileTree, { id: laptopID, label: "Carol's laptop", key: laptop.key })),
    });
    laptopClient = await openSession(carol.profileTree, laptopID, laptop);
    expect((await laptopClient.account()).account.profileTree).toBe(carol.profileTree);
  });

  async function requestReset(device: { id: string; label: string; key: string }) {
    const anonymous = new ProtocolClient(running.url);
    const challenge = await anonymous.createProfileResetChallenge({ profileTree: carol.profileTree, device });
    const request = { challenge, publicKey: carol.publicKey, signature: carol.sign(profileResetChallengeBytes(challenge)) };
    return { request, reset: await anonymous.requestProfileReset(request) };
  }

  test("a pending reset waits, gives the new device nothing, and an administrator device cancels it", async () => {
    const replacement = ed25519Key();
    const replacementID = generateArborID("dv");
    const { request, reset } = await requestReset({ id: replacementID, label: "Carol's new laptop", key: replacement.key });
    expect(reset.device).toEqual({ id: replacementID, label: "Carol's new laptop" });
    expect(reset.effectiveAt - reset.requestedAt).toBe(running.canopy.resetWaitMs);
    // An exact retry returns the same pending reset; another is refused.
    expect(await new ProtocolClient(running.url).requestProfileReset(request)).toEqual(reset);
    await expect(requestReset({ id: generateArborID("dv"), label: "Another", key: ed25519Key().key })).rejects.toThrow("already pending");
    // A reset signed by another key is refused.
    const anonymous = new ProtocolClient(running.url);
    await expect(anonymous.requestProfileReset({ ...request, signature: profileIdentity().sign(profileResetChallengeBytes(request.challenge)) })).rejects.toThrow();

    expect(await laptopClient.pendingProfileReset(carol.profileTree)).toEqual(reset);
    await expect(anonymous.createDeviceSessionChallenge({ profileTree: carol.profileTree, device: replacementID })).rejects.toThrow("not-found");
    await laptopClient.cancelProfileReset(carol.profileTree);
    expect(await laptopClient.pendingProfileReset(carol.profileTree)).toBeNull();
    expect((await laptopClient.account()).account.profileTree).toBe(carol.profileTree);
  });

  test("once the wait ends, only the new device is left", async () => {
    const wait = running.canopy.resetWaitMs;
    running.canopy.resetWaitMs = 0;
    const replacement = p256Key();
    const replacementID = generateArborID("dv");
    try {
      await requestReset({ id: replacementID, label: "Carol's phone", key: replacement.key });
    } finally {
      running.canopy.resetWaitMs = wait;
    }
    // The reset has taken effect: earlier devices authenticate nothing, even
    // before the host accepts its configuration update.
    await expect(laptopClient.account()).rejects.toThrow("unauthenticated");
    const phoneClient = await openSession(carol.profileTree, replacementID, replacement);
    const { values } = await readTreeConfig(phoneClient, carol.profileTree, "person");
    expect(values.devices).toEqual({ [replacementID]: { id: replacementID, label: "Carol's phone", administrator: true, key: replacement.key } });
    await expect(new ProtocolClient(running.url).createDeviceSessionChallenge({ profileTree: carol.profileTree, device: laptopID })).rejects.toThrow("not-found");
    expect(await phoneClient.pendingProfileReset(carol.profileTree)).toBeNull();
  });
});
