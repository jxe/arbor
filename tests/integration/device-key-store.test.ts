import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { overstoryPrivateRoot, HostAccountStore, ProtocolClient, sha256, treeConfigurationID } from "@ovst/protocol";
import { testAccount, testDevice } from "../helpers/devices.ts";

const token = "device-key-store-owner";
let sandbox: string;
let host: Awaited<ReturnType<typeof serveHost>>;
const previous = { home: process.env.STORY_HOME, store: process.env.STORY_CREDENTIAL_STORE };

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-device-key-store-"));
  process.env.STORY_HOME = join(sandbox, "home");
  process.env.STORY_CREDENTIAL_STORE = "file";
  host = await serveHost({
    dataRoot: join(sandbox, "host"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
  process.env.STORY_HOME = previous.home;
  process.env.STORY_CREDENTIAL_STORE = previous.store;
});

describe("an installation's device key", () => {
  test("the store keeps only the key and hands out sessions it opens", async () => {
    const { profileTree, device: deviceID, seed, key } = testDevice(token);
    const store = new HostAccountStore(treeConfigurationID(profileTree));
    const record = await store.setDeviceKey(seed, { origin: host.url, account: `${host.url}/~owner`, accountID: profileTree, profileTree, deviceID });
    expect(record).toMatchObject({ credential: "file:device-key", deviceKey: key });
    const account = join(overstoryPrivateRoot(), "accounts", treeConfigurationID(profileTree));
    expect(await readFile(join(account, "device-key"), "utf8")).toBe(seed);
    await expect(readFile(join(account, "credential"), "utf8")).rejects.toThrow("ENOENT");

    const connected = (await store.get())!;
    expect(connected.accountToken).not.toBe(seed);
    expect(connected.accountToken).toStartWith("ars_");
    expect((await new ProtocolClient(host.url, connected.accountToken).account()).account.profileTree).toBe(profileTree);

    // The session is reused until close to expiry, and replaced once forgotten.
    expect((await store.get())!.accountToken).toBe(connected.accountToken);
    await store.forgetSession();
    const renewed = (await store.get())!.accountToken;
    expect(renewed).not.toBe(connected.accountToken);
    expect((await new ProtocolClient(host.url, renewed).account()).account.profileTree).toBe(profileTree);

    // Concurrent callers with no usable session share one open.
    await store.forgetSession();
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => new HostAccountStore(treeConfigurationID(profileTree)).get()));
    expect(new Set(concurrent.map((each) => each!.accountToken)).size).toBe(1);
  });

  test("a connection saved with a bearer credential and no key is never used", async () => {
    const { profileTree, device } = testDevice("device-key-store-credential");
    const configurationTree = treeConfigurationID(profileTree);
    const directory = join(overstoryPrivateRoot(), "accounts", configurationTree);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "credential"), "arb_before_device_keys");
    await writeFile(join(directory, "connection.json"), JSON.stringify({
      configurationTree, origin: host.url, account: `${host.url}/~owner`, accountID: profileTree, profileTree, deviceID: device,
      credential: "file:credential", tokenDigest: sha256("arb_before_device_keys"), connected: true,
    }));
    expect(await new HostAccountStore(configurationTree).get()).toBeNull();
  });
});
