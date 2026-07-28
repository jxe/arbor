import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { serveWireHost } from "@arbor/wire";
import { build } from "vite";

await build({ configFile: join(import.meta.dir, "../../packages/render/vite.config.ts"), logLevel: "error" });

// A fixed location so the test file can compute the same OS-shaped URLs.
const root = join(tmpdir(), "arbor-e2e-workspace");
const promotableRoot = join(tmpdir(), "arbor-e2e-promotable");
const state = join(tmpdir(), "arbor-e2e-state");
const hostState = join(tmpdir(), "arbor-e2e-host-state");
await rm(root, { recursive: true, force: true });
await rm(promotableRoot, { recursive: true, force: true });
await rm(state, { recursive: true, force: true });
await rm(hostState, { recursive: true, force: true });
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
  ownerToken: "e2e-owner-token",
  publicOrigin: `http://127.0.0.1:${port + 1}`,
  hostname: "127.0.0.1",
  port: port + 1,
});
const running = await serveArbor(root, { port });
await running.service.executeMutation({
  mutationID: "e2e-configure-host",
  operations: [{
    op: "configureServer",
    origin: host.url,
    ownerToken: "e2e-owner-token",
  }],
});
await running.service.executeMutation({
  mutationID: "e2e-promote-feature-fixture",
  operations: [{
    op: "promoteTree",
    path: root,
    slug: "fixture",
  }],
});
console.log(running.url);

async function shutdown() {
  running.server.stop(true);
  await running.service.serverConfig.remove();
  await running.service[Symbol.asyncDispose]();
  host.server.stop(true);
  await host.authority[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(promotableRoot, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  await rm(hostState, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
