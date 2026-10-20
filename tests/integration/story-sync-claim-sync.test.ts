import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStorySyncControl } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { ProfileIdentityStore } from "@ovst/client";
import { decodeProtocolDirectory, ProtocolClient, treeConfigurationID } from "@ovst/protocol";
import { storySyncFetch as fetch } from "../helpers/story-sync-fetch.ts";

let sandbox: string;
const previous = { home: process.env.STORY_HOME, store: process.env.STORY_CREDENTIAL_STORE };

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-claim-sync-")));
  process.env.STORY_HOME = join(sandbox, "home");
  process.env.STORY_CREDENTIAL_STORE = "file";
});

afterAll(async () => {
  if (previous.home === undefined) delete process.env.STORY_HOME; else process.env.STORY_HOME = previous.home;
  if (previous.store === undefined) delete process.env.STORY_CREDENTIAL_STORE; else process.env.STORY_CREDENTIAL_STORE = previous.store;
  await rm(sandbox, { recursive: true, force: true });
});

test("a running daemon syncs the configuration an account claim places, and resolves it by ;overstory-config", async () => {
  const profile = join(sandbox, "profile");
  await mkdir(profile, { recursive: true });
  const identity = await new ProfileIdentityStore().create(profile);
  const host = await serveHost({
    dataRoot: join(sandbox, "host"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "Garden", firstWriter: { handle: "tess", profileTree: identity.profileTree } },
  });
  const daemon = await serveStorySyncControl({ port: 0 });
  try {
    const claim = await fetch(`${daemon.url}/v1/bootstrap/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: `${host.url}/~tess`, path: profile, displayName: "Tess's Mac" }),
    });
    expect(claim.status).toBe(201);
    expect(await readFile(join(profile, "_index.md"), "utf8")).toContain("displayName: Tess's Mac\n");
    expect(await readFile(join(profile, "_index.md"), "utf8")).toContain("\n# Tess's Mac\n");
    // Nothing else asks for a sync: the claim alone must start the placement's update machine.
    const configuration = treeConfigurationID(identity.profileTree);
    let sync: string | undefined;
    for (let attempt = 0; attempt < 50 && sync !== "idle"; attempt += 1) {
      const trees = (await (await fetch(`${daemon.url}/v1/trees`)).json()).snapshot as Array<{ id: string; sync: string }>;
      sync = trees.find((tree) => tree.id === configuration)?.sync;
      if (sync !== "idle") await Bun.sleep(100);
    }
    expect(sync).toBe("idle");

    // `;overstory-config` locators name the configuration: by TreeID from this
    // device's checkout, by canonical URL through the host.
    const resolve = async (locator: string) =>
      (await fetch(`${daemon.url}/v1/resolve?locator=${encodeURIComponent(locator)}`)).json() as Promise<{ ref: { tree: string; path: string } }>;
    expect((await resolve(`overstory://${identity.profileTree};overstory-config`)).ref).toMatchObject({ tree: configuration, path: "/" });
    expect((await resolve(`${host.url}/~tess;overstory-config`)).ref).toMatchObject({ tree: configuration, path: "/" });
    expect((await fetch(`${daemon.url}/v1/resolve?locator=${encodeURIComponent(`overstory://${identity.profileTree}/notes;overstory-config`)}`)).status).toBe(400);

    // The claim places the profile folder too, so edits made after joining reach the host.
    const placements = await readFile(join(process.env.STORY_HOME!, "placements.yaml"), "utf8");
    expect(placements).toContain(identity.profileTree);
    await writeFile(join(profile, "note.md"), "Written after joining\n");
    const hosted = new ProtocolClient(host.url);
    let note: string | undefined;
    for (let attempt = 0; attempt < 100 && note === undefined; attempt += 1) {
      note = await hostedFile(hosted, identity.profileTree, "note.md");
      if (note === undefined) await Bun.sleep(100);
    }
    expect(note).toBe("Written after joining\n");
  } finally {
    daemon.server.stop(true);
    await daemon.service[Symbol.asyncDispose]();
    host.server.stop(true);
    await host.overstoryd[Symbol.asyncDispose]();
  }
}, 30_000);

test("a data home that joined before claims placed the profile folder places it at the next start, keeping later edits", async () => {
  process.env.STORY_HOME = join(sandbox, "earlier-home");
  const profile = join(sandbox, "earlier-profile");
  await mkdir(profile, { recursive: true });
  const identity = await new ProfileIdentityStore().create(profile);
  const host = await serveHost({
    dataRoot: join(sandbox, "earlier-host"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "Garden", firstWriter: { handle: "oliver", profileTree: identity.profileTree } },
  });
  const configuration = treeConfigurationID(identity.profileTree);
  let daemon = await serveStorySyncControl({ port: 0 });
  try {
    const claim = await fetch(`${daemon.url}/v1/bootstrap/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: `${host.url}/~oliver`, path: profile }),
    });
    expect(claim.status).toBe(201);
    daemon.server.stop(true);
    await daemon.service[Symbol.asyncDispose]();

    // What an earlier claim left: the profile activated at the host, but no placement and no sync state for it.
    await writeFile(join(process.env.STORY_HOME!, "placements.yaml"), "{}\n");
    await rm(join(process.env.STORY_HOME!, ".state", "accounts", configuration, "refs", `${identity.profileTree}.json`), { force: true });
    await rm(join(process.env.STORY_HOME!, ".state", "trees", Buffer.from(identity.profileTree).toString("base64url")), { recursive: true, force: true });
    await writeFile(join(profile, "photo.txt"), "Added while unplaced\n");

    daemon = await serveStorySyncControl({ port: 0 });
    expect(await readFile(join(process.env.STORY_HOME!, "placements.yaml"), "utf8")).toContain(identity.profileTree);
    const hosted = new ProtocolClient(host.url);
    let photo: string | undefined;
    for (let attempt = 0; attempt < 100 && photo === undefined; attempt += 1) {
      photo = await hostedFile(hosted, identity.profileTree, "photo.txt");
      if (photo === undefined) await Bun.sleep(100);
    }
    expect(photo).toBe("Added while unplaced\n");
  } finally {
    daemon.server.stop(true);
    await daemon.service[Symbol.asyncDispose]();
    host.server.stop(true);
    await host.overstoryd[Symbol.asyncDispose]();
  }
}, 30_000);

async function hostedFile(client: ProtocolClient, tree: string, name: string): Promise<string | undefined> {
  try {
    const { tree: descriptor } = await client.descriptor(tree);
    const snapshot = await client.snapshot(tree, descriptor.root);
    const entry = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!).entries.find((candidate) => candidate.name === name);
    return entry?.file ? new TextDecoder().decode(snapshot.objects.get(entry.file)!) : undefined;
  } catch { return undefined; }
}
