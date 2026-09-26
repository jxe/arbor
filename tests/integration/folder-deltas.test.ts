import { installAccountHome } from "../helpers/account-home.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArborSyncDaemon } from "@overstory/arborsync";
import { serveHost } from "@overstory/canopyd";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import {
  HostAccountStore, ProtocolClient, decodeProtocolDirectory, decodeUpdateRequestJSON, hashObject,
  type UpdateRequest,
} from "@overstory/protocol";

const token = "folder-deltas-owner";
let sandbox: string;
let state: string;
let folder: string;
let tree: string;
let host: Awaited<ReturnType<typeof serveHost>>;
const large = (line: string) => `# Large\n\n${Array.from({ length: 4_000 }, (_, index) => index === 2_000 ? line : `Paragraph ${index} of a long Markdown page.`).join("\n")}\n`;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-folder-deltas-"));
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
  const profile = account.account.profileTree!;
  tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder)), { parent: { tree: profile, name: "deltas", kind: "person" } });
  const { values } = await readTreeConfig(owner, profile, "person");
  const device = Object.values(values.devices!).find((candidate) => candidate.administrator)!.id;
  await installAccountHome(state, owner, device, token, { [folder]: tree });
});

afterAll(async () => {
  process.env.ARBOR_DATA_HOME = state;
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  host.server.stop(true);
  await host.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

/** Run `body` with every update request the daemon sends recorded, and failed while `offline()` holds. */
async function recording<T>(body: (requests: UpdateRequest[], offline: (value: boolean) => void) => Promise<T>): Promise<T> {
  const systemFetch = globalThis.fetch;
  const requests: UpdateRequest[] = [];
  let failing = false;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(`/.arbor/trees/${tree}/updates`) && typeof init?.body === "string") {
      if (failing) throw new TypeError("connection lost");
      requests.push(decodeUpdateRequestJSON(JSON.parse(init.body)));
    }
    return systemFetch(input, init);
  }) as typeof fetch;
  try { return await body(requests, (value) => { failing = value; }); } finally { globalThis.fetch = systemFetch; }
}

async function accepted(path: string): Promise<string> {
  const owner = new ProtocolClient(host.url, token);
  const current = await owner.descriptor(tree);
  const root = decodeProtocolDirectory(await owner.object(tree, current.tree.root));
  const entry = root.entries.find((candidate) => candidate.name === path)!;
  return new TextDecoder().decode(await owner.object(tree, entry.file!));
}

test("a folder edit to a large Markdown file submits a delta against the accepted file, and canopyd accepts it", async () => {
  process.env.ARBOR_DATA_HOME = state;
  const daemon = await ArborSyncDaemon.openControl({ autoSync: false });
  try {
    await daemon.synchronizeNow();
    const source = large("An edited middle line.");
    const bytes = new TextEncoder().encode(source), file = hashObject(bytes);
    await recording(async (requests) => {
      await writeFile(join(folder, "large.md"), source);
      await daemon.synchronizeNow();
      // One publication is one request, even when the watch reports it before the response.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.updates).toHaveLength(1);
      const [update] = requests[0]!.updates;
      expect(update!.deltas.map((delta) => delta.result)).toEqual([file]);
      expect(update!.objects.map((object) => object.hash)).not.toContain(file);
    });
    expect(await accepted("large.md")).toBe(source);
    expect(await daemon.syncPresentation(tree)).toMatchObject({ state: "current", pending: 0 });
  } finally { await daemon[Symbol.asyncDispose](); }
}, 20_000);

test("a change chained on an unsettled change sends its objects whole", async () => {
  process.env.ARBOR_DATA_HOME = state;
  const daemon = await ArborSyncDaemon.openControl({ autoSync: false });
  try {
    await daemon.synchronizeNow();
    const first = large("First offline line."), second = large("Second chained line.");
    await recording(async (requests, offline) => {
      offline(true);
      await writeFile(join(folder, "large.md"), first);
      await daemon.synchronizeNow().catch(() => {});
      await writeFile(join(folder, "large.md"), second);
      offline(false);
      await daemon.synchronizeNow();
      expect(requests).toHaveLength(1);
      const chain = requests[0]!;
      expect(chain.updates).toHaveLength(2);
      const [head, chained] = chain.updates;
      expect(head!.deltas.map((delta) => delta.result)).toContain(hashObject(new TextEncoder().encode(first)));
      expect(chained!.deltas).toEqual([]);
      expect(chained!.objects.map((object) => object.hash)).toContain(hashObject(new TextEncoder().encode(second)));
    });
    expect(await accepted("large.md")).toBe(second);
    expect(await readFile(join(folder, "large.md"), "utf8")).toBe(second);
  } finally { await daemon[Symbol.asyncDispose](); }
}, 20_000);
