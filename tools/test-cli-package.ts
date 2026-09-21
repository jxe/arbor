import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { persistPackageRuntime } from "../packages/cli/src/package-runtime.ts";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "arbor-package-check-"));
const environment = { ...process.env, ARBOR_CREDENTIAL_STORE: "file", ARBOR_DATA_HOME: join(scratch, "data") };
async function run(command: string[], cwd: string, env: Record<string, string | undefined> = environment) {
  const child = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Package verification failed: ${command.slice(0, 3).join(" ")}`);
}
try {
  const artifact = join(scratch, "artifact");
  await run([process.execPath, join(root, "tools/build-cli-package.ts"), artifact], root);
  await run(["npm", "pack", "--ignore-scripts", "--pack-destination", scratch], artifact);
  const manifest = await Bun.file(join(artifact, "package.json")).json();
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", join(scratch, `overstory-cli-${manifest.version}.tgz`)], scratch);
  const cli = join(scratch, "node_modules/@overstory/cli/bin/arbor.js");
  // Runs the existing real-host lifecycle and ordinary command tests against the installed artifact.
  let lifecycleError: unknown;
  try {
    await run([process.execPath, "test", "tests/integration/cli-sync.test.ts"], root, { ...environment, ARBOR_TEST_CLI_ENTRY: cli });
  } catch (error) { lifecycleError = error; }
  if (process.platform === "darwin") {
    const installed = await persistPackageRuntime(join(scratch, "node_modules/@overstory/cli/bin/arborsync.js"), scratch);
    await rm(join(scratch, "node_modules"), { recursive: true, force: true });
    await run([process.execPath, join(root, "tools/test-sync-helper.ts"), process.execPath, installed], scratch);
  }
  if (lifecycleError) throw lifecycleError;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
