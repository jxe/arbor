import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@overstory/canopyd";
import { arborPrivateRoot, HostAccountStore, ProtocolClient, treeConfigurationID } from "@overstory/protocol";
import { editTreeConfig, readTreeConfig } from "../helpers/tree-config.ts";

const token = "device-key-store-owner";
let sandbox: string;
let host: Awaited<ReturnType<typeof serveHost>>;
let profileTree: string;
let deviceID: string;
const previous = { home: process.env.ARBOR_DATA_HOME, store: process.env.ARBOR_CREDENTIAL_STORE };

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-device-key-store-"));
  process.env.ARBOR_DATA_HOME = join(sandbox, "home");
  process.env.ARBOR_CREDENTIAL_STORE = "file";
  host = await serveHost({
    dataRoot: join(sandbox, "host"),
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  const owner = new ProtocolClient(host.url, token);
  const { account } = await owner.account();
  profileTree = account.profileTree!;
  deviceID = Object.keys((await readTreeConfig(owner, profileTree, "person")).values.devices!)[0]!;
});

afterAll(async () => {
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
  process.env.ARBOR_DATA_HOME = previous.home;
  process.env.ARBOR_CREDENTIAL_STORE = previous.store;
});

describe("an installation's device key", () => {
  test("a digest device keeps its credential until the host lists its key, then uses sessions", async () => {
    const store = new HostAccountStore(treeConfigurationID(profileTree));
    await store.set(token, { origin: host.url, account: `${host.url}/~owner`, accountID: profileTree, profileTree, deviceID });
    const key = await store.prepareDeviceKey();
    expect(await store.prepareDeviceKey()).toBe(key);
    expect((await store.get())!.accountToken).toBe(token);

    // The move itself, as any client submits it with its credential.
    await editTreeConfig(new ProtocolClient(host.url, token), profileTree, "person", (values) => ({
      ...values, devices: { ...values.devices, [deviceID]: { ...values.devices![deviceID]!, key } },
    }));

    // The old credential now fails; after that 401 the store sees the key
    // listed, adopts it and drops the credential.
    await expect(new ProtocolClient(host.url, token).account()).rejects.toThrow("unauthenticated");
    await store.forgetSession();
    const connected = (await new HostAccountStore(treeConfigurationID(profileTree)).get())!;
    expect(connected.record.deviceKey).toBe(key);
    expect(connected.accountToken).not.toBe(token);
    expect((await new ProtocolClient(host.url, connected.accountToken).account()).account.profileTree).toBe(profileTree);
    const account = join(arborPrivateRoot(), "accounts", treeConfigurationID(profileTree));
    expect(await readFile(join(account, "device-key"), "utf8")).toHaveLength(43);
    await expect(readFile(join(account, "credential"), "utf8")).rejects.toThrow("ENOENT");

    // The session is reused until close to expiry, and replaced once forgotten.
    expect((await store.get())!.accountToken).toBe(connected.accountToken);
    await store.forgetSession();
    const renewed = (await store.get())!.accountToken;
    expect(renewed).not.toBe(connected.accountToken);
    expect((await new ProtocolClient(host.url, renewed).account()).account.profileTree).toBe(profileTree);
  });
});
