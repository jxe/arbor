import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon } from "@arbor/arborsync";
import { serveCanopy } from "@arbor/canopy";
import { generateArborID } from "@arbor/core";
import { CanopyAccountStore, loadCanopyAccountConfigurations, loadLocalPlacements } from "@arbor/stores";

let sandbox: string;
let state: string;
let profile: string;
let source: string;
let tree: string;
let sourceCanopy: Awaited<ReturnType<typeof serveCanopy>>;
let destinationCanopy: Awaited<ReturnType<typeof serveCanopy>>;

async function arbor(args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
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
  sourceCanopy = await serveCanopy({
    dataRoot: join(sandbox, "source-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "source", name: "Source", firstWriter: { handle: "joe" } },
  });
  destinationCanopy = await serveCanopy({
    dataRoot: join(sandbox, "destination-canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "destination", name: "Destination", firstWriter: { handle: "joe" } },
  });
  process.env.ARBOR_DATA_HOME = state;
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await daemon.claimCanopyAccount(`${sourceCanopy.url}/~joe`, profile, "Joe");
    await daemon.claimCanopyAccount(`${destinationCanopy.url}/~joe`, profile, "Joe");
    const accounts = await loadCanopyAccountConfigurations();
    const sourceAccount = accounts.find((account) => account.account?.canopy === sourceCanopy.url)!;
    tree = generateArborID("tr");
    await writeFile(join(sourceAccount.path, "trees.yaml"), [
      `${tree}:`,
      `  canonical: ${JSON.stringify(`${sourceCanopy.url}/~joe/todos`)}`,
      "  access:",
      "    - subject:",
      "        kind: profile",
      `        tree: ${sourceAccount.account!.profile}`,
      "      access: write",
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

describe("arbor rehome", () => {
  test("preflights, preserves identity and current bytes, and switches the local account placement", async () => {
    const destination = `${destinationCanopy.url}/~joe/todos-f`;
    const before = await readFile(join(state, "placements.yaml"), "utf8");
    const checked = await arbor(["rehome", "--check", source, destination]);
    expect(checked).toContain(`Would rehome ${tree}`);
    expect(await readFile(join(state, "placements.yaml"), "utf8")).toBe(before);
    expect(destinationCanopy.canopy.get(tree)).toBeNull();

    const moved = await arbor(["rehome", source, destination]);
    expect(moved).toContain(`Rehomed ${tree}`);
    const placements = await loadLocalPlacements();
    const destinationAccount = (await loadCanopyAccountConfigurations()).find((account) => account.account?.canopy === destinationCanopy.url)!;
    expect(placements.placements).toContainEqual({
      configurationTree: destinationAccount.configurationTree,
      path: source,
      tree,
    });
    expect(sourceCanopy.canopy.get(tree)).not.toBeNull();
    expect(destinationCanopy.canopy.get(tree)?.ref).toBe(sourceCanopy.canopy.get(tree)?.ref);
    expect(await readFile(join(source, "todo.md"), "utf8")).toBe("# Keep this\n");
    expect(destinationAccount.trees?.[tree]).toEqual({
      canonical: destination,
      access: [{ subject: { kind: "profile", tree: destinationAccount.account!.profile }, access: "write" }],
    });

    const resumed = await arbor(["rehome", source, destination]);
    expect(resumed).toContain(`Rehomed ${tree}`);
  });
});
