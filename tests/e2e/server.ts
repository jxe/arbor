import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { serveWireHost, snapshotDirectory, WireClient } from "@arbor/wire";
import { build } from "vite";

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
const host = await serveWireHost({
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
await new WireClient(host.url, "e2e-owner-token").create(
  "/~editors",
  await snapshotDirectory(editorsProfile),
  { kind: "group-profile", publicAccess: "read" },
);
const running = await serveArbor(root, { port });
await running.service.executeMutation({
  mutationID: "e2e-configure-host",
  operations: [{
    op: "connectCommunity",
    origin: host.url,
    accountToken: "e2e-owner-token",
  }],
});
await running.service.executeMutation({
  mutationID: "e2e-promote-feature-fixture",
  operations: [{
    op: "promoteTree",
    path: root,
    canonicalPath: "/~owner/fixture",
    audience: { kind: "private" },
  }],
});
console.log(running.url);

async function shutdown() {
  running.server.stop(true);
  await running.service.communityConfig.remove();
  await running.service[Symbol.asyncDispose]();
  host.server.stop(true);
  await host.authority[Symbol.asyncDispose]();
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
