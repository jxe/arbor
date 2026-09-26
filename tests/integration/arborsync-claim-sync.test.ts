import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborSyncControl } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { ProfileIdentityStore } from "@overstory/arborsync/state";
import { treeConfigurationID } from "@overstory/protocol";

let sandbox: string;
const previous = { home: process.env.ARBOR_DATA_HOME, store: process.env.ARBOR_CREDENTIAL_STORE };

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-claim-sync-")));
  process.env.ARBOR_DATA_HOME = join(sandbox, "home");
  process.env.ARBOR_CREDENTIAL_STORE = "file";
});

afterAll(async () => {
  if (previous.home === undefined) delete process.env.ARBOR_DATA_HOME; else process.env.ARBOR_DATA_HOME = previous.home;
  if (previous.store === undefined) delete process.env.ARBOR_CREDENTIAL_STORE; else process.env.ARBOR_CREDENTIAL_STORE = previous.store;
  await rm(sandbox, { recursive: true, force: true });
});

test("a running daemon syncs the configuration an account claim places, and resolves it by ;arbor-config", async () => {
  const profile = join(sandbox, "profile");
  await mkdir(profile, { recursive: true });
  const identity = await new ProfileIdentityStore().create(profile);
  const host = await serveHost({
    dataRoot: join(sandbox, "host"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "Garden", firstWriter: { handle: "tess", profileTree: identity.profileTree } },
  });
  const daemon = await serveArborSyncControl({ port: 0 });
  try {
    const claim = await fetch(`${daemon.url}/v1/bootstrap/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: `${host.url}/~tess`, path: profile, displayName: "Tess's Mac" }),
    });
    expect(claim.status).toBe(201);
    // Nothing else asks for a sync: the claim alone must start the placement's update machine.
    const configuration = treeConfigurationID(identity.profileTree);
    let sync: string | undefined;
    for (let attempt = 0; attempt < 50 && sync !== "idle"; attempt += 1) {
      const trees = (await (await fetch(`${daemon.url}/v1/trees`)).json()).snapshot as Array<{ id: string; sync: string }>;
      sync = trees.find((tree) => tree.id === configuration)?.sync;
      if (sync !== "idle") await Bun.sleep(100);
    }
    expect(sync).toBe("idle");

    // `;arbor-config` locators name the configuration: by TreeID from this
    // device's checkout, by canonical URL through the host.
    const resolve = async (locator: string) =>
      (await fetch(`${daemon.url}/v1/resolve?locator=${encodeURIComponent(locator)}`)).json() as Promise<{ ref: { tree: string; path: string } }>;
    expect((await resolve(`arbor://${identity.profileTree};arbor-config`)).ref).toMatchObject({ tree: configuration, path: "/" });
    expect((await resolve(`${host.url}/~tess;arbor-config`)).ref).toMatchObject({ tree: configuration, path: "/" });
    expect((await fetch(`${daemon.url}/v1/resolve?locator=${encodeURIComponent(`arbor://${identity.profileTree}/notes;arbor-config`)}`)).status).toBe(400);
  } finally {
    daemon.server.stop(true);
    await daemon.service[Symbol.asyncDispose]();
    host.server.stop(true);
    await host.canopy[Symbol.asyncDispose]();
  }
});
