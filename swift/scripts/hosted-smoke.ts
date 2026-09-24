#!/usr/bin/env bun
/**
 * Hosted smoke harness for the Mac app's working-tree client.
 *
 * Starts a local Canopy, claims an account through a throwaway Arbor Sync
 * control daemon's `/v1/bootstrap/accounts` into the test data home the Arbor
 * scheme uses (`ARBOR_DATA_HOME=/tmp/ArborNativeAppTests`), places a
 * disposable folder as a tree, then runs `CanopyAppTests` with
 * `ARBOR_TEST_TREE` naming that tree. The signed test app supervises its own
 * bundled control-mode helper on the test port (45190) against that data
 * home, opens the tree through `/v1/bootstrap`, edits its own working tree,
 * and the harness's test waits for the edit to reach the folder through
 * Canopy and the daemon.
 *
 *   bun swift/scripts/hosted-smoke.ts [extra xcodebuild arguments]
 *
 * The Xcode project must already be generated (`cd swift && xcodegen
 * generate`). When the ignored `swift/Canopy.local.xcworkspace` exists, the
 * build uses it so an editable Quagmire checkout overrides the pinned
 * release. Nothing here touches the user's real `~/.arbor` or Application
 * Support: the data home is the scheme's disposable one and the app's support
 * state for the test tree lives under the test host's own container.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborSyncControl } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { arborPrivateRoot, sha256 } from "@overstory/protocol";
import { ProfileIdentityStore, loadLocalPlacements } from "@overstory/arborsync/state";

const repository = join(import.meta.dir, "../..");
const dataHome = "/tmp/ArborNativeAppTests";
// The test app supervises its bundled helper on this port and reuses any
// daemon already listening there, which would put the test on a foreign data
// home. The helper also outlives the test, so the harness stops it afterwards.
const helperPort = 45190;

async function run(command: string[], environment: Record<string, string> = {}, cwd = repository): Promise<void> {
  const child = Bun.spawn(command, { cwd, env: { ...Bun.env, ...environment }, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${command.join(" ")} exited with ${status}`);
}

async function listeners(port: number): Promise<number[]> {
  const lsof = Bun.spawn(["lsof", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(lsof.stdout).text();
  await lsof.exited;
  return output.split("\n").filter(Boolean).map(Number);
}

const occupants = await listeners(helperPort);
if (occupants.length) {
  throw new Error(`Port ${helperPort} is in use by pid ${occupants.join(", ")}; stop it before running the hosted smoke test`);
}

// Placements record real paths; on macOS the temp dir is a symlink under /var.
const sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-hosted-smoke-")));
const previousDataHome = process.env.ARBOR_DATA_HOME;
await rm(dataHome, { recursive: true, force: true });
await mkdir(dataHome, { recursive: true });
process.env.ARBOR_DATA_HOME = dataHome;
// An isolated data home keeps its identity in the Keychain under a slot named
// for the data home path (`ProfileIdentityStore`), so wiping the folder leaves
// a previous run's identity bound to that run's deleted sandbox.
await Bun.secrets.delete({ service: "org.arbor.person-profile", name: `home-v2-${sha256(arborPrivateRoot()).slice(0, 24)}` });
const profile = join(sandbox, "profile");
const folder = join(sandbox, "smoke-tree");
await mkdir(profile, { recursive: true });
await mkdir(folder, { recursive: true });
await writeFile(join(folder, "note.md"), "---\nid: pg_smoke\n---\n\n# Smoke\n\nPlaced by the hosted smoke harness.\n");

const identity = await new ProfileIdentityStore().create(profile);
const canopy = await serveHost({
  dataRoot: join(sandbox, "canopy"),
  publicOrigin: "http://127.0.0.1:0",
  hostname: "127.0.0.1",
  port: 0,
  community: { handle: "smoke", name: "Smoke", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
});
try {
  // Claiming and `arbor place` both go through a throwaway control daemon;
  // the app under test launches the bundled helper afterwards against the
  // same data home and finds the account and placement there.
  const control = await serveArborSyncControl({ port: 0 });
  try {
    // The Mac's data-home claim route; the CLI's daemon client has no claim method.
    const claim = await fetch(`${control.url}/v1/bootstrap/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: `${canopy.url}/~joe`, path: profile, displayName: "Hosted smoke Mac" }),
    });
    if (!claim.ok) throw new Error(`Account claim failed: ${claim.status} ${await claim.text()}`);
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

  // Build against a local Quagmire checkout when the ignored editable-mode
  // workspace exists (DEVELOPMENT.md, "Developing Overstory with Quagmire").
  const container = existsSync(join(repository, "swift/Canopy.local.xcworkspace"))
    ? ["-workspace", "Canopy.local.xcworkspace"]
    : ["-project", "Canopy.xcodeproj"];
  await run(
    [
      "xcodebuild", ...container, "-scheme", "Canopy",
      "-destination", "platform=macOS", "test",
      "-only-testing:CanopyAppTests",
      ...process.argv.slice(2),
    ],
    {
      // `TEST_RUNNER_` variables reach the hosted test bundle with the prefix stripped.
      TEST_RUNNER_ARBOR_TEST_TREE: placement.tree,
      TEST_RUNNER_ARBOR_DATA_HOME: dataHome,
      TEST_RUNNER_ARBOR_TEST_BUNDLED_HELPER: "1",
    },
    join(repository, "swift"),
  );
} finally {
  // The port was free at start, so whatever listens now is the test app's helper.
  for (const pid of await listeners(helperPort)) process.kill(pid);
  canopy.server.stop(true);
  await canopy.canopy[Symbol.asyncDispose]();
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await rm(sandbox, { recursive: true, force: true });
}
