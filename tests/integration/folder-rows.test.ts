import { installAccountHome } from "../helpers/account-home.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { interceptedUpdateRequest } from "../support/wire-body.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorySyncDaemon } from "@ovst/story-sync";
import { ProjectionProviderHost } from "@ovst/story-sync/state";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { replayCollectionRows } from "@ovst/collection-schema";
import { HostAccountStore, decodeProtocolDirectory, executeRowOperations, type SourceOperation, type UpdateRequest } from "@ovst/protocol";
import { deviceClient, testAccount, testDevice } from "../helpers/devices.ts";

const token = "folder-rows-owner";
const SCHEMA = "model Item {\n  title Text\n  done  Bool?\n}\n";
const GAMES = "model Game {\n  name  Text\n  lists List[]\n}\n\nmodel List {\n  name  Text\n  games Game[]\n}\n\nList.games[] @ordered <-> Game.lists[]\n";
let sandbox: string, state: string, folder: string, tree: string;
let host: Awaited<ReturnType<typeof serveHost>>;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-folder-rows-"));
  state = join(sandbox, "home");
  folder = join(sandbox, "tree");
  await Promise.all([state, join(folder, "items")].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(folder, "items", "schema.usl"), SCHEMA);
  await writeFile(join(folder, "items", "_store.jsonl"), '{"id":"a","title":"A"}\n{"id":"b","title":"B"}\n');
  await mkdir(join(folder, "games"));
  await writeFile(join(folder, "games", "schema.usl"), GAMES);
  await writeFile(join(folder, "games", "Game.jsonl"), '{"id":"g1","name":"Chess"}\n');
  await writeFile(join(folder, "games", "List.jsonl"), '{"id":"l1","name":"Favorites"}\n');
  await writeFile(join(folder, "games", "List_games.jsonl"), "");
  host = await serveHost({ dataRoot: join(sandbox, "host"), accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  const owner = await deviceClient(host.url, token);
  const profile = (await owner.account()).account.profileTree!;
  const stores = new ProjectionProviderHost();
  try {
    tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder, new Map(), [], (root, name) => stores.collectionDescriptor(root, name))),
      { parent: { tree: profile, name: "rows", kind: "person" } });
  } finally { await stores[Symbol.asyncDispose](); }
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

async function recording<T>(body: (requests: UpdateRequest[]) => Promise<T>): Promise<T> {
  const systemFetch = globalThis.fetch, requests: UpdateRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = url.includes(`/.overstory/trees/${tree}/updates`) ? interceptedUpdateRequest(init) : undefined;
    if (request) requests.push(request);
    return systemFetch(input, init);
  }) as typeof fetch;
  try { return await body(requests); } finally { globalThis.fetch = systemFetch; }
}

/** Another device sets a field through the host, as row operations on the accepted head. */
async function remoteSet(row: string, field: string, before: unknown, value: unknown, path = "items", table = "Item") {
  const owner = await deviceClient(host.url, token);
  const current = await owner.descriptor(tree), snapshot = await owner.snapshot(tree, current.tree.root);
  const objects = new Map(snapshot.objects);
  const items = decodeProtocolDirectory(objects.get(snapshot.root)!).entries.find((e) => e.name === path)!.directory!;
  const operations = [{ key: "set", kind: "rowSet", collection: { material: { kind: "basis", path: `/${path}`, object: items } },
    table, row: JSON.stringify([["id", row]]), field, before, value } as SourceOperation];
  const result = await executeRowOperations(snapshot.root, operations, async (hash) => objects.get(hash)!, replayCollectionRows);
  await owner.submitUpdates(tree, { base: current.tree.update, updates: [{ change: crypto.randomUUID(), candidate: result.root,
    trace: [{ before: snapshot.root, after: result.root, operations }], resolves: [], deltas: [],
    objects: [...result.generated].map(([hash, bytes]) => ({ hash, bytes })) }] });
}

test("a folder's row edit publishes row operations, and merges with a concurrent edit to another field", async () => {
  process.env.STORY_HOME = state;
  const daemon = await StorySyncDaemon.openControl({ autoSync: false });
  try {
    await daemon.synchronizeNow();
    await recording(async (requests) => {
      await writeFile(join(folder, "items", "_store.jsonl"), '{"id":"a","title":"Alpha"}\n{"id":"b","title":"B"}\n');
      await daemon.synchronizeNow();
      const trace = requests.flatMap((request) => request.updates).at(-1)!.trace;
      expect(trace?.[0]?.operations).toEqual([expect.objectContaining({ kind: "rowSet", field: "title", before: "A", value: "Alpha" })]);
    });
    await remoteSet("a", "done", null, true);
    await recording(async (requests) => {
      await writeFile(join(folder, "items", "_store.jsonl"), '{"id":"a","title":"Alpha!"}\n{"id":"b","title":"B"}\n');
      await daemon.synchronizeNow();
      await daemon.synchronizeNow();
      expect(requests.flatMap((request) => request.updates).some((update) => update.trace?.[0]?.operations.some((op) => op.kind === "rowSet" && op.value === "Alpha!"))).toBe(true);
    });
    expect(await readFile(join(folder, "items", "_store.jsonl"), "utf8")).toBe('{"id":"a","title":"Alpha!","done":true}\n{"id":"b","title":"B"}\n');
    expect(await daemon.syncPresentation(tree)).toMatchObject({ state: "current", pending: 0 });
  } finally { await daemon[Symbol.asyncDispose](); }
}, 30_000);

test("a folder with a file per table syncs its rows as operations on each table", async () => {
  process.env.STORY_HOME = state;
  const daemon = await StorySyncDaemon.openControl({ autoSync: false });
  try {
    await daemon.synchronizeNow();
    await recording(async (requests) => {
      await writeFile(join(folder, "games", "Game.jsonl"), '{"id":"g1","name":"Chess"}\n{"id":"g2","name":"Go"}\n');
      await writeFile(join(folder, "games", "List_games.jsonl"), '{"list":"l1","game":"g2","games_position":1}\n');
      await daemon.synchronizeNow();
      const trace = requests.flatMap((request) => request.updates).at(-1)!.trace;
      expect(trace?.[0]?.operations).toEqual([
        expect.objectContaining({ kind: "rowCreate", table: "Game", row: JSON.stringify([["id", "g2"]]) }),
        expect.objectContaining({ kind: "rowCreate", table: "List_games" }),
      ]);
    });
    await remoteSet("l1", "name", "Favorites", "Best", "games", "List");
    await writeFile(join(folder, "games", "Game.jsonl"), '{"id":"g1","name":"Chess!"}\n{"id":"g2","name":"Go"}\n');
    await daemon.synchronizeNow();
    await daemon.synchronizeNow();
    expect(await readFile(join(folder, "games", "List.jsonl"), "utf8")).toBe('{"id":"l1","name":"Best"}\n');
    expect(await readFile(join(folder, "games", "Game.jsonl"), "utf8")).toBe('{"id":"g1","name":"Chess!"}\n{"id":"g2","name":"Go"}\n');
    expect(await daemon.syncPresentation(tree)).toMatchObject({ state: "current", pending: 0 });
  } finally { await daemon[Symbol.asyncDispose](); }
}, 30_000);
