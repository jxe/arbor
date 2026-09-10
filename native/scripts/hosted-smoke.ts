#!/usr/bin/env bun
/**
 * Hosted smoke harness for the Mac app's working-tree client.
 *
 * Starts a local Canopy, claims an account into the test data home the Arbor
 * scheme uses (`ARBOR_DATA_HOME=/tmp/ArborNativeAppTests`), places a
 * disposable folder as a tree, then runs `ArborAppTests` with
 * `ARBOR_TEST_TREE` naming that tree. The signed test app supervises its own
 * bundled control-mode helper on the test port (45190) against that data
 * home, opens the tree through `/v1/bootstrap`, edits its own working tree,
 * and the harness's test waits for the edit to reach the folder through
 * Canopy and the daemon.
 *
 *   bun native/scripts/hosted-smoke.ts [extra xcodebuild arguments]
 *
 * The Xcode project must already be generated (`cd native && xcodegen
 * generate`). Nothing here touches the user's real `~/.arbor` or Application
 * Support: the data home is the scheme's disposable one and the app's support
 * state for the test tree lives under the test host's own container.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon } from "@arbor/arborsync";
import { serveCanopy } from "@arbor/canopy";
import { ProfileIdentityStore, loadLocalPlacements } from "@arbor/stores";

const repository = join(import.meta.dir, "../..");
const dataHome = "/tmp/ArborNativeAppTests";

async function run(command: string[], environment: Record<string, string> = {}, cwd = repository): Promise<void> {
  const child = Bun.spawn(command, { cwd, env: { ...Bun.env, ...environment }, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${command.join(" ")} exited with ${status}`);
}

const sandbox = await mkdtemp(join(tmpdir(), "arbor-hosted-smoke-"));
const previousDataHome = process.env.ARBOR_DATA_HOME;
await rm(dataHome, { recursive: true, force: true });
await mkdir(dataHome, { recursive: true });
process.env.ARBOR_DATA_HOME = dataHome;
const profile = join(sandbox, "profile");
const folder = join(sandbox, "smoke-tree");
await mkdir(profile, { recursive: true });
await mkdir(folder, { recursive: true });
await writeFile(join(folder, "note.md"), "---\nid: pg_smoke\n---\n\n# Smoke\n\nPlaced by the hosted smoke harness.\n");

const identity = await new ProfileIdentityStore().create(profile);
const canopy = await serveCanopy({
  dataRoot: join(sandbox, "canopy"),
  publicOrigin: "http://127.0.0.1:0",
  hostname: "127.0.0.1",
  port: 0,
  community: { handle: "smoke", name: "Smoke", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
});
try {
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await daemon.claimCanopyAccount(`${canopy.url}/~joe`, profile, "Hosted smoke Mac");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
  // `arbor place` runs against a throwaway control daemon of its own; the app
  // under test launches the bundled helper afterwards against the same data
  // home and finds the placement there.
  const { serveArborSyncControl } = await import("@arbor/arborsync");
  const control = await serveArborSyncControl({ port: 0 });
  try {
    await run(
      ["bun", "packages/cli/src/index.ts", "place", folder, `${canopy.url}/~joe/smoke-tree`],
      { ARBOR_DATA_HOME: dataHome, ARBOR_SYNC_URL: control.url },
    );
  } finally {
    control.server.stop(true);
    await control.service[Symbol.asyncDispose]();
  }
  const placements = await loadLocalPlacements();
  const placement = placements.placements.find((candidate) => candidate.path === folder);
  if (!placement) throw new Error(`arbor place did not record ${folder}`);
  console.log(`Placed ${folder} as ${placement.tree} at ${canopy.url}`);

  await run(
    [
      "xcodebuild", "-project", "Arbor.xcodeproj", "-scheme", "Arbor",
      "-destination", "platform=macOS", "test",
      "-only-testing:ArborAppTests",
      ...process.argv.slice(2),
    ],
    {
      // `TEST_RUNNER_` variables reach the hosted test bundle with the prefix stripped.
      TEST_RUNNER_ARBOR_TEST_TREE: placement.tree,
      TEST_RUNNER_ARBOR_DATA_HOME: dataHome,
      TEST_RUNNER_ARBOR_TEST_BUNDLED_HELPER: "1",
    },
    join(repository, "native"),
  );
} finally {
  canopy.server.stop(true);
  await canopy.canopy[Symbol.asyncDispose]();
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await rm(sandbox, { recursive: true, force: true });
}
