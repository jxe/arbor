import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeProtocolDirectory, ProtocolClient, treeConfigurationID, type TreeSnapshot } from "@ovst/protocol";
import { StorySyncDaemon } from "@ovst/story-sync";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { accountProtocolClient, loadLocalPlacements, ProfileIdentityStore } from "@ovst/client";
import { LocalAccountService } from "../../packages/story-sync/src/account-service.ts";
import { StorySyncRESTClient } from "../../packages/cli/src/daemon-client.ts";
import { makeProfilePublic } from "../helpers/community-reservations.ts";
import { deviceClient, testAccount } from "../helpers/devices.ts";
import { hostTree } from "../helpers/tree-config.ts";

/**
 * Read-only placements (placements.yaml `access: read`) and visitor sessions
 * (accounts §5.6): Joe's home is A. B's community has never reserved him, but
 * its owner shares a tree with his profile by its locator at A.
 * `story place --read-only` follows that tree into a folder through a visitor
 * session; the owner's edits arrive, and edits in the folder are never sent.
 * A public tree on B follows the same way.
 */

let sandbox: string;
let state: string;
let profileTree: string;
let configurationTree: string;
let a: Awaited<ReturnType<typeof serveHost>>;
let b: Awaited<ReturnType<typeof serveHost>>;
let bOrigin: string;
let owner: ProtocolClient;
let club: string;
let child: { kill(): void; exited: Promise<number> } | undefined;
let daemonURL: string;
let sync: StorySyncRESTClient;

const repository = join(import.meta.dir, "../..");
const environment = () => ({ ...Bun.env, STORY_HOME: state, STORY_CREDENTIAL_STORE: "file" });

async function story(args: string[]): Promise<string> {
  const process = Bun.spawn(["bun", "packages/cli/src/index.ts", ...args], {
    cwd: repository, env: { ...environment(), STORY_SYNC_URL: daemonURL }, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (exit !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

async function snapshotOf(files: Record<string, string>): Promise<TreeSnapshot> {
  const directory = await mkdtemp(join(sandbox, "snapshot-"));
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
  return resolveSnapshot(await snapshotDirectory(directory));
}

/** A tree's accepted `_index.md` at B, as its owner reads it. */
async function atB(tree: string): Promise<string> {
  const { tree: descriptor } = await owner.descriptor(tree);
  const snapshot = await owner.snapshot(tree, descriptor.root);
  const entry = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!).entries.find((candidate) => candidate.name === "_index.md");
  return new TextDecoder().decode(snapshot.objects.get(entry!.file!)!);
}

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "story-read-only-")));
  state = join(sandbox, "mac");
  const profile = join(sandbox, "profile");
  await Promise.all([state, profile].map((path) => mkdir(path, { recursive: true })));
  process.env.STORY_HOME = state;
  profileTree = (await new ProfileIdentityStore().create(profile)).profileTree;
  configurationTree = treeConfigurationID(profileTree);
  a = await serveHost({
    dataRoot: join(sandbox, "home"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "garden", name: "garden", firstWriter: { handle: "joe", profileTree } },
  });
  b = await serveHost({
    dataRoot: join(sandbox, "other"), publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    community: { handle: "orchard", name: "orchard" }, accounts: [testAccount("owner", "read-only-owner", { communityWriter: true })],
  });
  bOrigin = new URL(b.url).origin;
  const daemon = await StorySyncDaemon.open(profile);
  try {
    await new LocalAccountService({ trees: daemon.trees, events: daemon.events }).claimHostAccount(`${a.url}/~joe`, profile, "Joe");
  } finally {
    await daemon[Symbol.asyncDispose]();
  }
  process.env.STORY_HOME = state;
  // B pins Joe's locator by reading his profile at A.
  await makeProfilePublic((await accountProtocolClient({ configurationTree }, { required: true })).client, profileTree);
  owner = await deviceClient(b.url, "read-only-owner");
  const ownerProfile = (await owner.account()).account.profileTree!;
  club = await hostTree(owner, await snapshotOf({ "_index.md": "# Club\n" }), {
    parent: { tree: ownerProfile, name: "club", kind: "person" },
    access: [{ who: { profile: `${new URL(a.url).origin}/~joe` }, allow: ["read"] }],
  });

  const spawned = Bun.spawn(["bun", "packages/story-sync/src/cli.ts", "--control", "--port", "0"], {
    cwd: repository, env: environment(), stdout: "pipe", stderr: "inherit",
  });
  child = spawned;
  const reader = spawned.stdout.getReader();
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Story Sync exited before listening: ${output}`);
    output += new TextDecoder().decode(value);
    const match = /listening at (http:\/\/\S+)/.exec(output);
    if (match) { reader.releaseLock(); daemonURL = match[1]!; break; }
  }
  sync = new StorySyncRESTClient({ baseURL: daemonURL, dataHome: state });
}, 60_000);

afterAll(async () => {
  child?.kill();
  await child?.exited;
  for (const host of [b, a]) {
    host?.server.stop(true);
    await host?.overstoryd[Symbol.asyncDispose]();
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("read-only placements", () => {
  let folder: string;

  test("story place --read-only follows a tree shared with Joe at a host where he has no account", async () => {
    folder = join(sandbox, "club");
    const output = await story(["place", "--read-only", `${bOrigin}/~owner/club`, folder]);
    expect(output).toContain("read only, as a visitor");
    process.env.STORY_HOME = state;
    expect((await loadLocalPlacements()).placements).toContainEqual({ configurationTree, path: folder, tree: club, host: bOrigin, readOnly: true });
    await until(async () => (await readFile(join(folder, "_index.md"), "utf8")) === "# Club\n", 15_000, "the folder to fill");
    const descriptor = (await sync.trees()).snapshot.find((candidate) => candidate.id === club);
    expect(descriptor?.access).toBe("read");
  }, 60_000);

  test("the owner's edits arrive; edits in the folder are never sent", async () => {
    const current = await owner.descriptor(club);
    await owner.submitUpdate(club, current.tree.update, await snapshotOf({ "_index.md": "# Club\n\nFrom the owner.\n" }));
    await until(async () => (await readFile(join(folder, "_index.md"), "utf8")).includes("From the owner."), 15_000, "the owner's edit");
    await writeFile(join(folder, "_index.md"), "# Club\n\nFrom the owner.\n\nFrom Joe.\n");
    await sync.synchronizeNow(configurationTree).catch(() => {});
    await Bun.sleep(1_000);
    expect(await atB(club)).toBe("# Club\n\nFrom the owner.\n");
  }, 60_000);

  test("a public tree follows the same way, and a private one is refused", async () => {
    const ownerProfile = (await owner.account()).account.profileTree!;
    await hostTree(owner, await snapshotOf({ "_index.md": "# Notice board\n" }), {
      parent: { tree: ownerProfile, name: "board", kind: "person" },
      access: [{ who: "everyone", allow: ["read"] }],
    });
    await hostTree(owner, await snapshotOf({ "_index.md": "# Diary\n" }), {
      parent: { tree: ownerProfile, name: "diary", kind: "person" },
    });
    const board = join(sandbox, "board");
    expect(await story(["place", "--read-only", `${bOrigin}/~owner/board`, board])).toContain("read only");
    await until(async () => (await readFile(join(board, "_index.md"), "utf8")) === "# Notice board\n", 15_000, "the public tree");
    await expect(story(["place", "--read-only", `${bOrigin}/~owner/diary`, join(sandbox, "diary")])).rejects.toThrow();
  }, 60_000);
});
