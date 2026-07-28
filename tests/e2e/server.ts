import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArbor } from "@arbor/arbord";
import { build } from "vite";

await build({ configFile: join(import.meta.dir, "../../packages/render/vite.config.ts"), logLevel: "error" });

// A fixed location so the test file can compute the same OS-shaped URLs.
const root = join(tmpdir(), "arbor-e2e-workspace");
const state = join(tmpdir(), "arbor-e2e-state");
await rm(root, { recursive: true, force: true });
await rm(state, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await mkdir(state, { recursive: true });
process.env.ARBOR_DATA_HOME = state;
await cp(join(import.meta.dir, "../fixtures/workspace"), root, { recursive: true });
await writeFile(join(root, "_index.md"), "# E2E Garden\n");
await mkdir(join(root, "title-first"), { recursive: true });
await writeFile(join(root, "title-first", "child.md"), "Projected child.\n");
await writeFile(join(root, "empty-title.md"), "");
await writeFile(join(root, "already-titled.md"), "# Existing title\n\nBody.\n");
const running = await serveArbor(root, { port: Number(process.env.ARBOR_E2E_PORT ?? 4321) });
console.log(running.url);

async function shutdown() {
  running.server.stop(true);
  await running.service[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
