import { HostAccountStore, loadProfileConfigurations } from "@ovst/protocol";
import { LocalAccountService } from "../../packages/story-sync/src/account-service.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorySyncDaemon } from "@ovst/story-sync";
import { serveStorySyncControl } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { ProfileIdentityStore, loadLocalPlacements } from "@ovst/client";

let sandbox: string;
let state: string;
let profile: string;
let source: string;
let destination: string;
let tree: string;
let running: Awaited<ReturnType<typeof serveHost>>;

async function story(args: string[]): Promise<string> {
  const daemon = await serveStorySyncControl({ port: 0 });
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, STORY_HOME: state, STORY_SYNC_URL: daemon.url },
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
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-cli-mv-")));
  state = join(sandbox, "state");
  profile = join(sandbox, "profile");
  source = join(sandbox, "todos-f");
  destination = join(sandbox, "moved", "todos");
  await Promise.all([state, profile, source, join(sandbox, "moved")].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(source, "todo.md"), "# Keep this\n");
  process.env.STORY_HOME = state;
  const identity = await new ProfileIdentityStore().create(profile);
  running = await serveHost({
    dataRoot: join(sandbox, "overstoryd"),
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
    community: { handle: "garden", name: "Garden", firstWriter: { handle: "joe", profileTree: identity.profileTree } },
  });
  const daemon = await StorySyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${running.url}/~joe`, profile, "Joe");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
  await story(["place", source, `${running.url}/~joe/todos`]);
  tree = running.overstoryd.boundary("/~joe/todos")!.id;
});

afterAll(async () => {
  process.env.STORY_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  running.server.stop(true);
  await running.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("story mv", () => {
  test("preflights and moves one idle placed root without changing tree identity or content", async () => {
    const beforeRoot = running.overstoryd.get(tree)!.ref;
    const checked = await story(["mv", "--dry-run", source, destination]);
    expect(checked).toContain(`Would move ${tree}`);
    expect(await readFile(join(source, "todo.md"), "utf8")).toBe("# Keep this\n");
    expect(await stat(destination).then(() => true).catch(() => false)).toBe(false);

    const moved = await story(["mv", source, destination]);
    expect(moved).toContain(`Moved ${tree}`);
    expect(await stat(source).then(() => true).catch(() => false)).toBe(false);
    expect(await readFile(join(destination, "todo.md"), "utf8")).toBe("# Keep this\n");
    expect((await loadLocalPlacements()).placements).toContainEqual({
      configurationTree: (await loadProfileConfigurations())[0]!.configurationTree,
      path: destination,
      tree,
    });
    expect(running.overstoryd.get(tree)!.ref).toBe(beforeRoot);

    const sourceCanonical = `${running.url}/~joe/todos`;
    const destinationCanonical = `${running.url}/~joe/tasks`;
    const account = (await loadProfileConfigurations())[0]!;
    const beforeConfiguration = await readFile(join(account.path, "mounts.yaml"), "utf8");
    const canonicalDryRun = await story(["mv", "--dry-run", sourceCanonical, destinationCanonical]);
    expect(canonicalDryRun).toContain(`Would move ${tree}`);
    expect(await readFile(join(account.path, "mounts.yaml"), "utf8")).toBe(beforeConfiguration);
    expect(running.overstoryd.get(tree)!.canonicalPath).toBe("/~joe/todos");

    const canonicalMove = await story(["mv", sourceCanonical, destinationCanonical]);
    expect(canonicalMove).toContain(`Moved ${tree}`);
    expect(running.overstoryd.get(tree)!.canonicalPath).toBe("/~joe/tasks");
    expect(await readFile(join(account.path, "mounts.yaml"), "utf8")).toContain(`tasks: ${tree}`);
    // Another Canopy is not a destination: a profile has one home host.
    await expect(story(["mv", destinationCanonical, "https://elsewhere.example/~joe/tasks"])).rejects.toThrow("stays on the host that holds it");
    expect(running.overstoryd.get(tree)!.ref).toBe(beforeRoot);
    expect((await loadLocalPlacements()).placements).toContainEqual({
      configurationTree: account.configurationTree,
      path: destination,
      tree,
    });
  });
});
