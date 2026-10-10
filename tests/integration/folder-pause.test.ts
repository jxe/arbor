import { installAccountHome } from "../helpers/account-home.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStorySyncControl } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import {
  HostAccountStore, decodeProtocolDirectory, decodeUpdateRequestJSON, hashObject,
  type UpdateRequest,
} from "@ovst/protocol";
import { StorySyncRESTClient } from "../../packages/cli/src/daemon-client.ts";
import { deviceClient, testAccount, testDevice } from "../helpers/devices.ts";
import { interceptedUpdateRequest } from "../support/wire-body.ts";

const token = "folder-pause-owner";
let sandbox: string;
let state: string;
let folder: string;
let tree: string;
let host: Awaited<ReturnType<typeof serveHost>>;
const large = (line: string) => `# Large\n\n${Array.from({ length: 2_000 }, (_, index) => index === 1_000 ? line : `Paragraph ${index} of a long page.`).join("\n")}\n`;

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-folder-pause-")));
  state = join(sandbox, "home");
  folder = join(sandbox, "tree");
  await Promise.all([state, folder].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(folder, "large.md"), large("The original middle line."));
  host = await serveHost({
    dataRoot: join(sandbox, "host"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  const owner = await deviceClient(host.url, token);
  const account = await owner.account();
  const profile = account.account.profileTree!;
  tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder)), { parent: { tree: profile, name: "pause", kind: "person" } });
  const { values } = await readTreeConfig(owner, profile, "person");
  const device = Object.values(values.devices!).find((candidate) => candidate.administrator)!.id;
  await installAccountHome(state, owner, device, testDevice(token).seed, { [folder]: tree });
});

afterAll(async () => {
  process.env.STORY_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

async function launch() {
  process.env.STORY_HOME = state;
  const running = await serveStorySyncControl({ port: 0 });
  const client = new StorySyncRESTClient({ baseURL: running.url });
  await client.synchronizeNow();
  return {
    client, url: running.url,
    sync: async () => (await client.trees()).snapshot.find((candidate) => candidate.id === tree)?.sync,
    close: async () => { running.server.stop(true); await running.service[Symbol.asyncDispose](); },
  };
}

async function story(url: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, STORY_HOME: state, STORY_SYNC_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(stderr);
  return stdout;
}

async function waitFor(read: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await read()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out");
}

async function accepted(): Promise<string> {
  const owner = await deviceClient(host.url, token);
  const current = await owner.descriptor(tree);
  const entry = decodeProtocolDirectory(await owner.object(tree, current.tree.root)).entries.find((candidate) => candidate.name === "large.md")!;
  return new TextDecoder().decode(await owner.object(tree, entry.file!));
}

test("a paused folder publishes nothing across a restart, pending shows the exact body, and resume sends it", async () => {
  const systemFetch = globalThis.fetch;
  const requests: UpdateRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = url.includes(`/.overstory/trees/${tree}/updates`) ? interceptedUpdateRequest(init) : undefined;
    if (request) requests.push(request);
    return systemFetch(input, init);
  }) as typeof fetch;
  const original = await accepted(), edited = large("A paused middle line.");
  let daemon = await launch();
  try {
    await waitFor(async () => await daemon.sync() === "idle");
    expect(await daemon.client.pending(tree)).toEqual({ tree, paused: false, base: null, request: null });
    expect(await story(daemon.url, ["pending", folder])).toContain(`Nothing pending for ${folder}`);

    expect(await story(daemon.url, ["pause", folder])).toBe(`Paused ${folder} (${tree})\n`);
    expect(await daemon.sync()).toBe("paused");
    await writeFile(join(folder, "large.md"), edited);
    await daemon.client.synchronizeNow();
    await Bun.sleep(600);
    expect(requests).toHaveLength(0);
    expect(await daemon.sync()).toBe("paused");
    expect(await story(daemon.url, ["status"])).toMatch(new RegExp(`paused +${folder}`));

    await daemon.close();
    daemon = await launch();
    await Bun.sleep(600);
    expect(requests).toHaveLength(0);
    expect(await daemon.sync()).toBe("paused");
    expect(await accepted()).toBe(original);

    const view = await story(daemon.url, ["pending", folder]);
    expect(view).toContain(`Pending for ${folder} (${tree}, paused)`);
    expect(view).toContain("Update 1 of 1: folder-");
    expect(view).toMatch(/file \/large\.md \(delta from sha256:[0-9a-f]{12}…/);
    expect(view).toMatch(/ {2}- The original\n {2}\+ A paused\n/);
    expect((await daemon.client.pending(tree)).paused).toBe(true);
    // The last preview is the change resume publishes.
    const body = decodeUpdateRequestJSON(JSON.parse(await story(daemon.url, ["pending", folder, "--json"])));
    expect(body.updates).toHaveLength(1);
    expect(body.updates[0]!.deltas.map((delta) => delta.result)).toContain(hashObject(new TextEncoder().encode(edited)));

    expect(await story(daemon.url, ["resume", folder])).toBe(`Resumed ${folder} (${tree})\n`);
    await daemon.client.synchronizeNow();
    await waitFor(async () => await accepted() === edited);
    // Resume sends exactly the pending body, once.
    expect(requests).toEqual([body]);
    await waitFor(async () => await daemon.sync() === "idle");
    expect((await daemon.client.pending(tree)).request).toBeNull();
  } finally {
    globalThis.fetch = systemFetch;
    await daemon.close();
  }
}, 30_000);
