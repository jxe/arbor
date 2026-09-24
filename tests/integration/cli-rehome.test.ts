import { generateArborID, CanopyAccountStore, loadCanopyAccountConfigurations } from "@overstory/protocol";
import { LocalAccountService } from "../../packages/arborsync/src/account-service.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon } from "@overstory/arborsync";
import { serveArborSyncControl } from "@overstory/arborsync";
import { serveCanopy } from "@overstory/canopyd";
import { ProfileIdentityStore } from "@overstory/arborsync/state";

let sandbox: string;
let state: string;
let profile: string;
let source: string;
let tree: string;
let sourceCanopy: Awaited<ReturnType<typeof serveCanopy>>;
let destinationCanopy: Awaited<ReturnType<typeof serveCanopy>>;

async function arbor(args: string[]): Promise<string> {
  const daemon = await serveArborSyncControl({ port: 0 });
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_SYNC_URL: daemon.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  daemon.server.stop(true);
  await daemon.service[Symbol.asyncDispose]();
  if (exit !== 0) throw new Error(stderr);
  return stdout.trim();
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-cli-rehome-"));
  state = join(sandbox, "state");
  profile = join(sandbox, "profile");
  source = join(sandbox, "todos");
  await Promise.all([state, profile, source].map((path) => mkdir(path, { recursive: true })));
  source = await realpath(source);
  await writeFile(join(source, "todo.md"), "# Keep this\n");
  process.env.ARBOR_DATA_HOME = state;
  const identity = await new ProfileIdentityStore().create(profile);
  sourceCanopy = await serveCanopy({
    dataRoot: join(sandbox, "source-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "source", name: "Source", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
  });
  destinationCanopy = await serveCanopy({
    dataRoot: join(sandbox, "destination-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "destination", name: "Destination", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
  });
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimCanopyAccount(`${sourceCanopy.url}/~joe`, profile, "Joe");
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimCanopyAccount(`${destinationCanopy.url}/~joe`, profile, "Joe");
    const accounts = await loadCanopyAccountConfigurations();
    const sourceAccount = accounts.find((account) => account.account?.canopy === sourceCanopy.url)!;
    tree = generateArborID("tr");
    await writeFile(join(sourceAccount.path, "trees.yaml"), [
      `${tree}:`,
      `  canonical: ${JSON.stringify(`${sourceCanopy.url}/~joe/todos`)}`,
      "  access:",
      `    - who: { profile: ${sourceAccount.account!.profile} }`,
      "      allow: [write]",
      "",
    ].join("\n"));
    await writeFile(join(state, "placements.yaml"), [
      `${sourceAccount.configurationTree}:`,
      `  ${JSON.stringify(source)}: ${tree}`,
      "",
    ].join("\n"));
    await daemon.synchronizeNow();
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
});

afterAll(async () => {
  process.env.ARBOR_DATA_HOME = state;
  for (const account of await CanopyAccountStore.list()) await new CanopyAccountStore(account.configurationTree).remove();
  sourceCanopy.server.stop(true);
  destinationCanopy.server.stop(true);
  await sourceCanopy.canopy[Symbol.asyncDispose]();
  await destinationCanopy.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("arbor mv between Canopies", () => {
  test("refuses before changing anything: resource policy has no reviewed transfer", async () => {
    const sourceCanonical = `${sourceCanopy.url}/~joe/todos`;
    const destination = `${destinationCanopy.url}/~joe/todos-f`;
    const before = await readFile(join(state, "placements.yaml"), "utf8");
    for (const args of [["mv", "--dry-run", sourceCanonical, destination], ["mv", sourceCanonical, destination]])
      await expect(arbor(args)).rejects.toThrow("requires a reviewed policy transfer");
    expect(await readFile(join(state, "placements.yaml"), "utf8")).toBe(before);
    expect(destinationCanopy.canopy.get(tree)).toBeNull();
    const sourceAccount = (await loadCanopyAccountConfigurations()).find((account) => account.account?.canopy === sourceCanopy.url)!;
    expect(sourceAccount.trees?.[tree]?.canonical).toBe(sourceCanonical);
    expect(sourceCanopy.canopy.get(tree)).toMatchObject({ status: "active" });
  });
});
