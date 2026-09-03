import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborSync } from "@arbor/arborsync";
import { serveCanopy } from "@arbor/canopy";
import { WireClient } from "@arbor/wire";
import { canonicalArborLocator, generateArborID } from "@arbor/core";
import { CommunityConfigStore, saveCurrentDeviceID } from "@arbor/stores";
import { readAccountConfigGraph, snapshotAccountConfig } from "../../packages/canopy/src/account-policy.ts";
import { build } from "vite";
import { snapshotDirectory } from "@arbor/fs";

await build({ configFile: join(import.meta.dir, "../../packages/render/vite.config.ts"), logLevel: "error" });

// A fixed location so the test file can compute the same OS-shaped URLs.
const root = join(tmpdir(), "arbor-e2e-workspace");
const untrackedRoot = join(tmpdir(), "arbor-e2e-untracked");
const promotableRoot = join(untrackedRoot, "arbor-e2e-promotable");
const state = join(tmpdir(), "arbor-e2e-state");
const hostState = join(tmpdir(), "arbor-e2e-host-state");
const aliceProfile = join(tmpdir(), "arbor-e2e-alice-profile");
const editorsProfile = join(tmpdir(), "arbor-e2e-editors-profile");
const communityProfile = join(tmpdir(), "arbor-e2e-community-profile");
await rm(root, { recursive: true, force: true });
await rm(untrackedRoot, { recursive: true, force: true });
await rm(state, { recursive: true, force: true });
await rm(hostState, { recursive: true, force: true });
await rm(aliceProfile, { recursive: true, force: true });
await rm(editorsProfile, { recursive: true, force: true });
await rm(communityProfile, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await mkdir(promotableRoot, { recursive: true });
await mkdir(state, { recursive: true });
await mkdir(hostState, { recursive: true });
process.env.ARBOR_DATA_HOME = state;
await cp(join(import.meta.dir, "../fixtures/workspace"), root, { recursive: true });
await writeFile(join(root, "_index.md"), "# E2E Garden\n");
await mkdir(join(root, "title-first"), { recursive: true });
await writeFile(join(root, "title-first", "child.md"), "Projected child.\n");
await writeFile(join(root, "empty-title.md"), "");
await writeFile(join(root, "already-titled.md"), "# Existing title\n\nBody.\n");
await writeFile(join(promotableRoot, "_index.md"), "# URL Garden\n");
await writeFile(join(promotableRoot, "seed.md"), "Ready to sync.\n");
const port = Number(process.env.ARBOR_E2E_PORT ?? 4321);
const host = await serveCanopy({
  dataRoot: hostState,
  accounts: [{ handle: "owner", token: "e2e-owner-token", communityWriter: true }],
  community: { handle: "community", name: "Arbor Community", firstWriter: { handle: "alice" } },
  publicOrigin: `http://127.0.0.1:${port + 1}`,
  hostname: "127.0.0.1",
  port: port + 1,
});
await mkdir(editorsProfile, { recursive: true });
await writeFile(join(editorsProfile, "_index.md"), "---\ntype: group\n---\n\n# Editors\n");
await writeFile(join(editorsProfile, "guide.md"), "# Editorial guide\n\nA **remote** Markdown page.\n");
const authorityClient = new WireClient(host.url, "e2e-owner-token");
const account = await authorityClient.account();
let configuration = await authorityClient.currentSnapshot(account.account.configuration.id);
const graph = readAccountConfigGraph({
  root: configuration.tree.root,
  objects: configuration.snapshot.objects,
}, account.account.configuration.id);
const device = graph.account.admins[0]!;
const editorsTree = generateArborID("tr");
const fixtureTree = "tr_eeeeeeeeeeeeeeeeeeeeeeeeee";
const configured = snapshotAccountConfig({
  account: graph.account,
  trees: { version: 1, trees: {
    ...graph.trees.trees,
    [editorsTree]: {
      canonicalPath: "/~editors",
      access: [{ subject: { kind: "everyone" }, access: "read" }],
    },
    [fixtureTree]: {
      canonicalPath: "/~owner/fixture",
      access: [],
    },
  } },
  devices: { ...graph.devices, [device]: {
    ...graph.devices[device]!,
    placements: {
      ...graph.devices[device]!.placements,
      [editorsTree]: { server: new URL(host.url).origin, path: editorsProfile },
      [fixtureTree]: { server: new URL(host.url).origin, path: root },
    },
  } },
});
await authorityClient.submitUpdate(configuration.tree.id, configuration.tree.update, configured);
await authorityClient.submitUpdate(editorsTree, null, await snapshotDirectory(editorsProfile));
await authorityClient.submitUpdate(fixtureTree, null, await snapshotDirectory(root));
configuration = await authorityClient.currentSnapshot(account.account.configuration.id);
const acceptedGraph = readAccountConfigGraph({
  root: configuration.tree.root,
  objects: configuration.snapshot.objects,
}, account.account.configuration.id);
await mkdir(join(state, "devices"), { recursive: true });
for (const [path, source] of Object.entries(acceptedGraph.sources)) await writeFile(join(state, path), source);
await saveCurrentDeviceID(device);
const configurationRef = await authorityClient.descriptor(account.account.configuration.id);
await new CommunityConfigStore().set(host.url, "e2e-owner-token", {
  id: account.account.id,
  handle: account.account.handle!,
  profileTree: account.account.profileTree,
  profileURL: account.account.profileURL,
  communityTree: account.account.community.id,
  communityURL: canonicalArborLocator(account.account.community.canonical!),
  configurationTree: account.account.configuration.id,
  configurationRef: configurationRef.tree.root,
  configurationUpdate: configurationRef.tree.update,
});
const running = await serveArborSync(root, { port });
console.log(running.url);

async function shutdown() {
  running.server.stop(true);
  await running.service.communityConfig.remove();
  await running.service[Symbol.asyncDispose]();
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(untrackedRoot, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  await rm(hostState, { recursive: true, force: true });
  await rm(aliceProfile, { recursive: true, force: true });
  await rm(editorsProfile, { recursive: true, force: true });
  await rm(communityProfile, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
