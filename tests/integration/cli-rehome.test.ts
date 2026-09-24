import { generateArborID, HostAccountStore, loadAccountConfigurations } from "@overstory/protocol";
import { LocalAccountService } from "../../packages/arborsync/src/account-service.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon } from "@overstory/arborsync";
import { serveArborSyncControl } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { ProfileIdentityStore } from "@overstory/arborsync/state";

let sandbox: string;
let state: string;
let profile: string;
let source: string;
let tree: string;
let sourceHost: Awaited<ReturnType<typeof serveHost>>;
let destinationHost: Awaited<ReturnType<typeof serveHost>>;

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
  sourceHost = await serveHost({
    dataRoot: join(sandbox, "source-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "source", name: "Source", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
  });
  destinationHost = await serveHost({
    dataRoot: join(sandbox, "destination-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "destination", name: "Destination", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
  });
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${sourceHost.url}/~joe`, profile, "Joe");
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${destinationHost.url}/~joe`, profile, "Joe");
    const accounts = await loadAccountConfigurations();
    const sourceAccount = accounts.find((account) => account.account?.canopy === sourceHost.url)!;
    tree = generateArborID("tr");
    await writeFile(join(sourceAccount.path, "trees.yaml"), [
      `${tree}:`,
      `  canonical: ${JSON.stringify(`${sourceHost.url}/~joe/todos`)}`,
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
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  sourceHost.server.stop(true);
  destinationHost.server.stop(true);
  await sourceHost.canopy[Symbol.asyncDispose]();
  await destinationHost.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("arbor mv between Canopies", () => {
  test("refuses before changing anything: resource policy has no reviewed transfer", async () => {
    const sourceCanonical = `${sourceHost.url}/~joe/todos`;
    const destination = `${destinationHost.url}/~joe/todos-f`;
    const before = await readFile(join(state, "placements.yaml"), "utf8");
    for (const args of [["mv", "--dry-run", sourceCanonical, destination], ["mv", sourceCanonical, destination]])
      await expect(arbor(args)).rejects.toThrow("requires a reviewed policy transfer");
    expect(await readFile(join(state, "placements.yaml"), "utf8")).toBe(before);
    expect(destinationHost.canopy.get(tree)).toBeNull();
    const sourceAccount = (await loadAccountConfigurations()).find((account) => account.account?.canopy === sourceHost.url)!;
    expect(sourceAccount.trees?.[tree]?.canonical).toBe(sourceCanonical);
    expect(sourceHost.canopy.get(tree)).toMatchObject({ status: "active" });
  });
});
