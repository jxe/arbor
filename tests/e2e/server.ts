import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWorkspace } from "@arbor/arbord";
import { build } from "vite";

await build({ configFile: join(import.meta.dir, "../../packages/render/vite.config.ts"), logLevel: "error" });

const root = await mkdtemp(join(tmpdir(), "arbor-e2e-workspace-"));
const state = await mkdtemp(join(tmpdir(), "arbor-e2e-state-"));
process.env.ARBOR_DATA_HOME = state;
await cp(join(import.meta.dir, "../fixtures/workspace"), root, { recursive: true });
const running = await serveWorkspace(root, { port: 4321 });
console.log(running.url);

async function shutdown() {
  running.server.stop(true);
  await running.workspace[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
