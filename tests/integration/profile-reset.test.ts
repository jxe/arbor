import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborSyncControl } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { ProfileIdentityStore } from "@overstory/arborsync/state";
import { HostAccountStore, ProtocolClient, treeConfigurationID } from "@overstory/protocol";
import { cancelAccountProfileReset, discardLocalProfileReset, pendingAccountProfileReset, pendingLocalProfileReset, requestProfileReset } from "@overstory/client";
import { readTreeConfig } from "./../helpers/tree-config.ts";

let sandbox: string;
const previous = { home: process.env.ARBOR_DATA_HOME, store: process.env.ARBOR_CREDENTIAL_STORE };
const passphrase = "a passphrase for this test";

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-profile-reset-")));
  process.env.ARBOR_CREDENTIAL_STORE = "file";
});

afterAll(async () => {
  if (previous.home === undefined) delete process.env.ARBOR_DATA_HOME; else process.env.ARBOR_DATA_HOME = previous.home;
  if (previous.store === undefined) delete process.env.ARBOR_CREDENTIAL_STORE; else process.env.ARBOR_CREDENTIAL_STORE = previous.store;
  await rm(sandbox, { recursive: true, force: true });
});

async function json(response: Response) {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

test("a restored profile key resets the devices to a new installation, after a wait an administrator device can cancel", async () => {
  // The first installation claims the account with its key device.
  const firstHome = join(sandbox, "first"), secondHome = join(sandbox, "second");
  process.env.ARBOR_DATA_HOME = firstHome;
  const profile = join(sandbox, "profile");
  await mkdir(profile, { recursive: true });
  const identity = await new ProfileIdentityStore().create(profile);
  const backup = join(sandbox, "identity.backup");
  await new ProfileIdentityStore().backup(backup, passphrase);
  const host = await serveHost({
    dataRoot: join(sandbox, "host"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "Garden", firstWriter: { handle: "tess", profileTree: identity.profileTree } },
  });
  const configuration = treeConfigurationID(identity.profileTree);
  try {
    const first = await serveArborSyncControl({ port: 0 });
    try {
      await json(await fetch(`${first.url}/v1/bootstrap/accounts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: `${host.url}/~tess`, path: profile }),
      }));
    } finally {
      first.server.stop(true);
      await first.service[Symbol.asyncDispose]();
    }

    // Every device is lost; the backup restores the profile key elsewhere and requests a reset.
    process.env.ARBOR_DATA_HOME = secondHome;
    await new ProfileIdentityStore().restore(backup, join(sandbox, "restored-profile"), passphrase);
    const requested = await requestProfileReset(host.url);
    await expect(requestProfileReset(host.url)).rejects.toThrow("already waiting");
    expect((await pendingLocalProfileReset())!.device.id).toBe(requested.device.id);

    // The existing device sees it and cancels it.
    process.env.ARBOR_DATA_HOME = firstHome;
    expect((await pendingAccountProfileReset(configuration))!.device).toEqual(requested.device);
    await cancelAccountProfileReset(configuration);
    expect(await pendingAccountProfileReset(configuration)).toBeNull();

    // Requested again with no wait, it takes effect, and the new installation connects as the only device.
    process.env.ARBOR_DATA_HOME = secondHome;
    expect(await discardLocalProfileReset()).toBe(true);
    const wait = host.canopy.resetWaitMs;
    host.canopy.resetWaitMs = 0;
    let reset;
    try { reset = await requestProfileReset(host.url); } finally { host.canopy.resetWaitMs = wait; }
    const second = await serveArborSyncControl({ port: 0 });
    try {
      await json(await fetch(`${second.url}/v1/me/reset/finish`, { method: "POST" }));
      const connected = (await new HostAccountStore(configuration).get())!;
      expect(connected.record.deviceID).toBe(reset.device.id);
      const { values } = await readTreeConfig(new ProtocolClient(host.url, connected.accountToken), identity.profileTree, "person");
      expect(Object.keys(values.devices!)).toEqual([reset.device.id]);
      expect(await pendingLocalProfileReset()).toBeNull();
    } finally {
      second.server.stop(true);
      await second.service[Symbol.asyncDispose]();
    }

    // The first installation's key no longer opens sessions.
    process.env.ARBOR_DATA_HOME = firstHome;
    const store = new HostAccountStore(configuration);
    await store.forgetSession();
    await expect(store.get()).rejects.toThrow();
  } finally {
    host.server.stop(true);
    await host.canopy[Symbol.asyncDispose]();
  }
});
