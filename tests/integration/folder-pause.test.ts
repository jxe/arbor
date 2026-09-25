import { installAccountHome } from "../helpers/account-home.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveArborSyncControl } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import {
  HostAccountStore, ProtocolClient, decodeProtocolDirectory, decodeUpdateRequestJSON, generateArborID, hashObject,
  readAccountConfigGraph, snapshotAccountConfig, type UpdateRequest,
} from "@overstory/protocol";
import { ArborSyncRESTClient } from "../../packages/cli/src/daemon-client.ts";

const token = "folder-pause-owner";
let sandbox: string;
let state: string;
let folder: string;
let tree: string;
let host: Awaited<ReturnType<typeof serveHost>>;
const large = (line: string) => `# Large\n\n${Array.from({ length: 2_000 }, (_, index) => index === 1_000 ? line : `Paragraph ${index} of a long page.`).join("\n")}\n`;

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "arbor-folder-pause-")));
  state = join(sandbox, "home");
  folder = join(sandbox, "tree");
  await Promise.all([state, folder].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(folder, "large.md"), large("The original middle line."));
  host = await serveHost({
    dataRoot: join(sandbox, "host"),
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  const owner = new ProtocolClient(host.url, token);
  const account = await owner.account();
  const configuration = await owner.descriptor(account.account.configuration.id);
  const graph = readAccountConfigGraph(await owner.snapshot(configuration.tree.id, configuration.tree.root), configuration.tree.id);
  tree = generateArborID("tr");
  await owner.submitUpdate(configuration.tree.id, configuration.tree.update, snapshotAccountConfig({
    account: graph.account,
    resources: { ...graph.resources, [tree]: { canonical: `${host.url}/~owner/pause`, access: [] } },
    devices: graph.devices,
  }));
  await owner.submitUpdate(tree, null, await resolveSnapshot(await snapshotDirectory(folder)));
  const device = Object.values(graph.devices).find((candidate) => candidate.administrator)!.id;
  await installAccountHome(state, owner, device, token, { [folder]: tree });
});

afterAll(async () => {
  process.env.ARBOR_DATA_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

async function launch() {
  process.env.ARBOR_DATA_HOME = state;
  const running = await serveArborSyncControl({ port: 0 });
  const client = new ArborSyncRESTClient({ baseURL: running.url });
  await client.synchronizeNow();
  return {
    client, url: running.url,
    sync: async () => (await client.trees()).snapshot.find((candidate) => candidate.id === tree)?.sync,
    close: async () => { running.server.stop(true); await running.service[Symbol.asyncDispose](); },
  };
}

async function arbor(url: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...Bun.env, ARBOR_DATA_HOME: state, ARBOR_SYNC_URL: url },
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
  const owner = new ProtocolClient(host.url, token);
  const current = await owner.descriptor(tree);
  const entry = decodeProtocolDirectory(await owner.object(tree, current.tree.root)).entries.find((candidate) => candidate.name === "large.md")!;
  return new TextDecoder().decode(await owner.object(tree, entry.file!));
}

test("a paused folder publishes nothing across a restart, pending shows the exact body, and resume sends it", async () => {
  const systemFetch = globalThis.fetch;
  const requests: UpdateRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(`/.arbor/trees/${tree}/updates`) && typeof init?.body === "string") requests.push(decodeUpdateRequestJSON(JSON.parse(init.body)));
    return systemFetch(input, init);
  }) as typeof fetch;
  const original = await accepted(), edited = large("A paused middle line.");
  let daemon = await launch();
  try {
    await waitFor(async () => await daemon.sync() === "idle");
    expect(await daemon.client.pending(tree)).toEqual({ tree, paused: false, base: null, request: null });
    expect(await arbor(daemon.url, ["pending", folder])).toContain(`Nothing pending for ${folder}`);

    expect(await arbor(daemon.url, ["pause", folder])).toBe(`Paused ${folder} (${tree})\n`);
    expect(await daemon.sync()).toBe("paused");
    await writeFile(join(folder, "large.md"), edited);
    await daemon.client.synchronizeNow();
    await Bun.sleep(600);
    expect(requests).toHaveLength(0);
    expect(await daemon.sync()).toBe("paused");
    expect(await arbor(daemon.url, ["status"])).toMatch(new RegExp(`paused +${folder}`));

    await daemon.close();
    daemon = await launch();
    await Bun.sleep(600);
    expect(requests).toHaveLength(0);
    expect(await daemon.sync()).toBe("paused");
    expect(await accepted()).toBe(original);

    const view = await arbor(daemon.url, ["pending", folder]);
    expect(view).toContain(`Pending for ${folder} (${tree}, paused)`);
    expect(view).toContain("Update 1 of 1: folder-");
    expect(view).toMatch(/file \/large\.md \(delta from sha256:[0-9a-f]{12}…/);
    expect(view).toMatch(/ {2}- The original\n {2}\+ A paused\n/);
    expect((await daemon.client.pending(tree)).paused).toBe(true);
    // The last preview is the change resume publishes.
    const body = decodeUpdateRequestJSON(JSON.parse(await arbor(daemon.url, ["pending", folder, "--json"])));
    expect(body.updates).toHaveLength(1);
    expect(body.updates[0]!.deltas.map((delta) => delta.result)).toContain(hashObject(new TextEncoder().encode(edited)));

    expect(await arbor(daemon.url, ["resume", folder])).toBe(`Resumed ${folder} (${tree})\n`);
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
