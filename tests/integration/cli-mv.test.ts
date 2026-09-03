import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
let destination: string;
let tree: string;
let running: Awaited<ReturnType<typeof serveCanopy>>;

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
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-cli-mv-")));
  state = join(sandbox, "state");
  profile = join(sandbox, "profile");
  source = join(sandbox, "todos-f");
  destination = join(sandbox, "moved", "todos");
  await Promise.all([state, profile, source, join(sandbox, "moved")].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(source, "todo.md"), "# Keep this\n");
  running = await serveCanopy({
    dataRoot: join(sandbox, "canopy"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden", firstWriter: { handle: "joe" } },
  });
  process.env.ARBOR_DATA_HOME = state;
  const daemon = await ArborSyncDaemon.open(profile);
  try {
    await daemon.claimCanopyAccount(`${running.url}/~joe`, profile, "Joe");
    const account = (await loadCanopyAccountConfigurations())[0]!;
    tree = generateArborID("tr");
    await writeFile(join(account.path, "trees.yaml"), [
      `${tree}:`,
      `  canonical: ${JSON.stringify(`${running.url}/~joe/todos`)}`,
      "  access:",
      "    - subject:",
      "        kind: profile",
      `        tree: ${account.account!.profile}`,
      "      access: write",
      "",
    ].join("\n"));
    await writeFile(join(state, "placements.yaml"), [
      `${account.configurationTree}:`,
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
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("arbor mv", () => {
  test("preflights and moves one idle placed root without changing tree identity or content", async () => {
    const beforeRoot = running.canopy.get(tree)!.ref;
    const checked = await arbor(["mv", "--check", source, destination]);
    expect(checked).toContain(`Would move ${tree}`);
    expect(await readFile(join(source, "todo.md"), "utf8")).toBe("# Keep this\n");
    expect(await stat(destination).then(() => true).catch(() => false)).toBe(false);

    const moved = await arbor(["mv", source, destination]);
    expect(moved).toContain(`Moved ${tree}`);
    expect(await stat(source).then(() => true).catch(() => false)).toBe(false);
    expect(await readFile(join(destination, "todo.md"), "utf8")).toBe("# Keep this\n");
    expect((await loadLocalPlacements()).placements).toContainEqual({
      configurationTree: (await loadCanopyAccountConfigurations())[0]!.configurationTree,
      path: destination,
      tree,
    });
    expect(running.canopy.get(tree)!.ref).toBe(beforeRoot);
  });
});
