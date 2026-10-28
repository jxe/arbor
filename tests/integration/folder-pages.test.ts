import { installAccountHome } from "../helpers/account-home.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStorySyncControl } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { HostAccountStore, decodeProtocolDirectory, decodeProtocolPage, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { StorySyncRESTClient } from "../../packages/cli/src/daemon-client.ts";
import { deviceClient, testAccount, testDevice } from "../helpers/devices.ts";

const token = "folder-pages-owner";
const source = "---\nid: p1\ntitle: 'A'   # kept as written\nstatus: draft\n---\nBody\n";
let sandbox: string, state: string, folder: string, tree: string;
let host: Awaited<ReturnType<typeof serveHost>>;

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-folder-pages-")));
  state = join(sandbox, "home");
  folder = join(sandbox, "tree");
  await Promise.all([state, folder].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(folder, "a.md"), source);
  await writeFile(join(folder, "b.md"), "No front matter.\n");
  await writeFile(join(folder, "notes.txt"), "plain\n");
  host = await serveHost({
    dataRoot: join(sandbox, "host"),
    accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0, pages: true,
  });
  const owner = await deviceClient(host.url, token);
  const profile = (await owner.account()).account.profileTree!;
  tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder)), { parent: { tree: profile, name: "pages", kind: "person" } });
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

async function entries(): Promise<Map<string, ProtocolDirectoryEntry>> {
  const owner = await deviceClient(host.url, token);
  const root = (await owner.descriptor(tree)).tree.root;
  return new Map(decodeProtocolDirectory(await owner.object(tree, root)).entries.map((entry) => [entry.name, entry]));
}

async function waitFor(read: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await read()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out");
}

test("a writer's Story Sync converts a tree to pages once the host has pages-v1, and then sends front-matter edits as pages", async () => {
  process.env.STORY_HOME = state;
  const running = await serveStorySyncControl({ port: 0 });
  const client = new StorySyncRESTClient({ baseURL: running.url });
  try {
    const before = await entries();
    expect([...before.values()].every((entry) => entry.file)).toBe(true);
    await client.synchronizeNow();
    await client.synchronizeNow();
    await waitFor(async () => !!(await entries()).get("a.md")?.page);
    const converted = await entries();
    expect(converted.get("b.md")?.page).toBeDefined();
    expect(converted.get("notes.txt")?.file).toBeDefined();
    const owner = await deviceClient(host.url, token);
    expect(decodeProtocolPage(await owner.object(tree, converted.get("a.md")!.page!)).properties).toEqual([["title", "A"], ["status", "draft"]]);
    // Converting changed nothing on disk.
    expect(await readFile(join(folder, "a.md"), "utf8")).toBe(source);

    await writeFile(join(folder, "a.md"), source.replace("status: draft", "status: done"));
    await client.synchronizeNow();
    await waitFor(async () => {
      const page = decodeProtocolPage(await owner.object(tree, (await entries()).get("a.md")!.page!));
      return page.properties.some(([name, value]) => name === "status" && value === "done");
    });
  } finally {
    running.server.stop(true);
    await running.service[Symbol.asyncDispose]();
  }
}, 30_000);
