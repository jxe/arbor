// Schema language 005 milestone 6, rows on the host. Done when: a named query
// over Supplies runs on the host without loading table files, and a
// subscriber sees a device's edit; a named mutation commits as an accepted
// update that both devices' databases receive, and its retry returns the same
// receipt; dropping the host materialization and restarting rebuilds it to
// the same rows.

import { installAccountHome } from "../helpers/account-home.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorySyncDaemon } from "@ovst/story-sync";
import { CollectionProjections } from "@ovst/story-sync/state";
import { serveHost, type HostCollectionsOptions } from "@ovst/overstoryd";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, HostAccountStore, type MutationCallRequest, type ObjectHash, type QueryStreamRequest } from "@ovst/protocol";
import { node, query, type MutationHandle, type QueryHandle } from "overstory/data";
import { deviceClient, deviceSession, testAccount, testDevice } from "../helpers/devices.ts";

mock.module("overstory/react", () => ({
  Markdown: () => null,
  skipQuery: Symbol("skip-query"),
  useMutationAction: () => [{}, () => undefined, false],
  useNavigate: () => () => undefined,
  useQuery: () => [],
  useUser: () => null,
}));

const token = "host-collections-owner";
const SUPPLIES = join(import.meta.dir, "../../examples/supplies");
const LIST = "10000000-0000-4000-8000-000000000001";
let sandbox: string, state: string, folder: string, dataRoot: string, tree: string;
let host: Awaited<ReturnType<typeof serveHost>>;
let apps: HostCollectionsOptions;
const document = (id: string) => ({ tree: id, path: "/List", version: "doc-v1" });
const listName = { module: "/queries.ts", export: "listName", version: "sha256:listName" };
const createList = { module: "/MyLists.tsx", export: "createList", version: "sha256:createList" };

const serve = () => serveHost({ dataRoot, accounts: [testAccount("owner", token, { communityWriter: true })],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0, collections: apps });

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-host-collections-"));
  state = join(sandbox, "home");
  folder = join(sandbox, "tree");
  dataRoot = join(sandbox, "host");
  await Promise.all([state, join(folder, "supplies")].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(folder, "supplies", "schema.usl"), await readFile(join(SUPPLIES, "data", "schema.usl")));
  await copyFile(join(SUPPLIES, "data", "_store.sqlite3"), join(folder, "supplies", "_store.sqlite3"));
  const named = query.one(node("./data/List").children, (list: any) => ({
    where: list.id.eq(LIST),
    select: list.pick("id", "name", "openToEdits"),
  })) as QueryHandle<unknown, unknown>;
  const myLists = await import(join(SUPPLIES, "MyLists.tsx"));
  apps = {
    queries: [{ ref: listName, handle: named, collection: "/supplies", authoredRoot: "./data" }],
    mutations: [{ ref: createList, handle: myLists.createList as MutationHandle<unknown, unknown>, collection: "/supplies", authoredRoot: "./data" }],
    now: () => new Date(Date.UTC(2026, 9, 24, 12, 0, 0)),
  };
  host = await serve();
  const owner = await deviceClient(host.url, token);
  const profile = (await owner.account()).account.profileTree!;
  const stores = new CollectionProjections();
  tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder, new Map(), [], (root, names) => stores.read(root, names))),
    { parent: { tree: profile, name: "rows", kind: "person" } });
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
  mock.restore();
});

const materialized = () => join(dataRoot, "materialized", tree, encodeURIComponent("/supplies"), "_store.sqlite3");

function rows(path: string, sql = "select * from List order by id"): unknown[] {
  const database = new Database(path, { readonly: true });
  try { return database.query(sql).all(); } finally { database.close(); }
}

/** Every authored table's rows, as the materialization holds them. */
function dump(path: string): Record<string, unknown[]> {
  const database = new Database(path, { readonly: true });
  try {
    const tables = (database.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_\\_arbor%' escape '\\' order by name").all() as Array<{ name: string }>).map((row) => row.name);
    return Object.fromEntries(tables.map((name) => [name, database.query(`select * from "${name}" order by rowid`).all()]));
  } finally { database.close(); }
}

/** {@link dump}, with each table's rows in key order rather than insertion order. */
function sortedDump(path: string): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(dump(path)).map(([name, rows]) => [name, rows.map((row) => JSON.stringify(row)).sort()]));
}

/** The events of an open query stream, as they arrive. */
async function* events(response: Response): AsyncGenerator<{ event: string; data: any }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event && data) yield { event, data: JSON.parse(data) };
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function nextResult(stream: AsyncGenerator<{ event: string; data: any }>): Promise<any> {
  const timeout = Bun.sleep(10_000).then(() => { throw new Error("Timed out waiting for a query result"); });
  while (true) {
    const next = await Promise.race([stream.next(), timeout]);
    if (next.done) throw new Error("The query stream closed");
    if (next.value.event === "result") return next.value.data;
  }
}

async function openQuery(origin: string, controller: AbortController) {
  const session = await deviceSession(origin, token);
  const request: QueryStreamRequest = { document: document(tree), queries: [{ id: "list", handle: { tree, ...listName } }] };
  const response = await fetch(`${origin}/.overstory/trees/${tree}/queries`, {
    method: "QUERY",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  return events(response);
}

async function mutate(input: unknown, mutationID: string) {
  const session = await deviceSession(host.url, token);
  const request: MutationCallRequest = { document: document(tree), handle: { tree, ...createList }, mutationID, input };
  const response = await fetch(`${host.url}/.overstory/trees/${tree}/mutate`, {
    method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return { status: response.status, body: await response.json() as any };
}

describe.serial("rows on the host", () => {
  test("a named query runs on the host's materialization, and a subscriber sees a device's edit", async () => {
    process.env.STORY_HOME = state;
    const controller = new AbortController();
    const daemon = await StorySyncDaemon.openControl({ autoSync: false });
    try {
      await daemon.synchronizeNow();
      const stream = await openQuery(host.url, controller);
      expect((await nextResult(stream)).value).toEqual({ id: LIST, name: "Community care", openToEdits: true });
      // The query read the host's own database, built from the accepted rows.
      expect(existsSync(materialized())).toBe(true);

      // A device edits the row with sqlite3; the host accepts it as row operations.
      const mine = new Database(join(folder, "supplies", "_store.sqlite3"));
      mine.query("update List set name = 'Neighbors' where id = ?").run(LIST);
      mine.close();
      await daemon.synchronizeNow();
      expect((await nextResult(stream)).value).toEqual({ id: LIST, name: "Neighbors", openToEdits: true });
    } finally {
      controller.abort();
      await daemon[Symbol.asyncDispose]();
    }
  }, 30_000);

  test("a named mutation commits as one accepted update that both devices receive, and its retry returns the same receipt", async () => {
    process.env.STORY_HOME = state;
    const before = host.overstoryd.acceptedUpdates(tree).length;
    const submitted: any[] = [];
    const submit = host.overstoryd.submitUpdate.bind(host.overstoryd);
    host.overstoryd.submitUpdate = (id, request, caller) => { submitted.push(request); return submit(id, request, caller); };
    const first = await mutate({ name: "Made on the host", visibility: "Private" }, "host-create");
    expect(first.status).toBe(200);
    // One update, as row operations guarded on the head the handler saw.
    expect(submitted).toHaveLength(1);
    expect(submitted[0].updates[0].ifCurrent).toBe(submitted[0].base);
    expect(submitted[0].updates[0].trace[0].operations).toEqual([expect.objectContaining({ kind: "rowCreate", model: "List", at: "2026-10-24T12:00:00.000Z" })]);
    const retry = await mutate({ name: "Made on the host", visibility: "Private" }, "host-create");
    expect(retry.body).toEqual(first.body);
    expect(host.overstoryd.acceptedUpdates(tree).length).toBe(before + 1);
    expect(submitted).toHaveLength(1);
    expect((await mutate({ name: "Something else", visibility: "Private" }, "host-create")).status).toBe(400);
    const id = first.body.result.id as string;
    const created = { id, name: "Made on the host", visibility: "Private", created: "2026-10-24T12:00:00.000Z", modified: "2026-10-24T12:00:00.000Z" };
    const sql = `select id, name, visibility, created, modified from List where id = '${id}'`;
    expect(rows(materialized(), sql)).toEqual([created]);

    // Device A takes it into its database through Story Sync.
    const daemon = await StorySyncDaemon.openControl({ autoSync: false });
    try {
      await daemon.synchronizeNow();
      expect(rows(join(folder, "supplies", "_store.sqlite3"), sql)).toEqual([created]);
    } finally { await daemon[Symbol.asyncDispose](); }

    // Device B places the accepted tree into a fresh folder.
    const other = join(sandbox, "device-b");
    const owner = await deviceClient(host.url, token);
    const current = await owner.descriptor(tree), snapshot = await owner.snapshot(tree, current.tree.root);
    const objects = new Map(snapshot.objects);
    const projections = new CollectionProjections({ form: () => ({ kind: "sqlite" }) });
    await materializeTree(other, snapshot.root as ObjectHash, (async (hash: string) => objects.get(hash as ObjectHash)!) as never, undefined, [], undefined,
      (directory, object, read) => projections.write(directory, object, read));
    expect(rows(join(other, "supplies", "_store.sqlite3"), sql)).toEqual([created]);
    expect(rows(join(other, "supplies", "_store.sqlite3"))).toEqual(rows(join(folder, "supplies", "_store.sqlite3")));
  }, 30_000);

  test("a retry after the host stopped between accepting a mutation and writing its receipt is answered from the accepted update", async () => {
    process.env.STORY_HOME = state;
    const before = host.overstoryd.acceptedUpdates(tree).length;
    // The receipt is lost: reading the cursor for it fails once, after the update was accepted.
    const submit = host.overstoryd.submitUpdate.bind(host.overstoryd), observed = host.overstoryd.observedThrough.bind(host.overstoryd);
    let accepted = false, lost = false;
    host.overstoryd.submitUpdate = async (id, request, caller) => { const response = await submit(id, request, caller); accepted = true; return response; };
    host.overstoryd.observedThrough = (id) => {
      if (accepted && !lost) { lost = true; throw new Error("Stopped before the receipt"); }
      return observed(id);
    };
    try {
      expect((await mutate({ name: "Made before a stop", visibility: "Private" }, "lost-receipt")).status).not.toBe(200);
      expect(lost).toBe(true);
      expect(host.overstoryd.acceptedUpdates(tree).length).toBe(before + 1);
      accepted = false;
      const retry = await mutate({ name: "Made before a stop", visibility: "Private" }, "lost-receipt");
      expect(retry.status).toBe(200);
      expect(accepted).toBe(false);
      expect(host.overstoryd.acceptedUpdates(tree).length).toBe(before + 1);
      const id = retry.body.result.id as string;
      expect(rows(materialized(), `select name from List where id = '${id}'`)).toEqual([{ name: "Made before a stop" }]);
      expect((await mutate({ name: "Made before a stop", visibility: "Private" }, "lost-receipt")).body).toEqual(retry.body);
    } finally {
      host.overstoryd.submitUpdate = submit;
      host.overstoryd.observedThrough = observed;
    }
  }, 30_000);

  test("a mutation whose tree moves under it with its collection unchanged is resubmitted without running again", async () => {
    process.env.STORY_HOME = state;
    const before = host.overstoryd.acceptedUpdates(tree).length;
    const submitted: any[] = [];
    const submit = host.overstoryd.submitUpdate.bind(host.overstoryd);
    let raced = false;
    host.overstoryd.submitUpdate = async (id, request, caller) => {
      submitted.push(request);
      if (!raced && request.updates[0]?.change.startsWith("mutation-")) {
        // Another device's edit outside the collection lands first.
        raced = true;
        const owner = await deviceClient(host.url, token);
        const head = await owner.descriptor(tree);
        const snapshot = await owner.snapshot(tree, head.tree.root);
        const objects = new Map(snapshot.objects);
        const rootBytes = objects.get(snapshot.root as ObjectHash)!;
        const root = decodeProtocolDirectory(rootBytes);
        const note = new TextEncoder().encode("elsewhere\n");
        const noteHash = hashObject(note);
        const next = encodeProtocolDirectory({ ...root, entries: [...root.entries.filter((entry) => entry.name !== "note.md"), { name: "note.md", file: noteHash }].sort((x, y) => x.name < y.name ? -1 : 1) });
        const nextHash = hashObject(next);
        const other = await submit(id, { base: head.tree.update, updates: [{ change: `note-${Date.now()}`, candidate: nextHash, trace: null, resolves: [], deltas: [],
          objects: [{ hash: noteHash, bytes: note }, { hash: nextHash, bytes: next }] }] } as any, caller);
        expect(other.status).toBe(201);
      }
      return submit(id, request, caller);
    };
    // Count the handler's runs.
    const open = [...((host.collections as any).open as Map<string, any>).values()][0];
    const trial = open.mutations.trial.bind(open.mutations);
    let runs = 0;
    open.mutations.trial = (...args: unknown[]) => { runs++; return trial(...args); };
    try {
      const made = await mutate({ name: "Made beside a note", visibility: "Private" }, "beside-a-note");
      expect(made.body).toEqual(expect.objectContaining({ mutationID: "beside-a-note" }));
    } finally {
      host.overstoryd.submitUpdate = submit;
      open.mutations.trial = trial;
    }
    expect(runs).toBe(1);
    const mutations = submitted.filter((request) => request.updates[0]?.change.startsWith("mutation-"));
    // The first was refused on its guard; the second carries the same change on the note's head.
    expect(mutations).toHaveLength(2);
    expect(mutations[1].updates[0].change).toBe(mutations[0].updates[0].change);
    expect(mutations[1].base).not.toBe(mutations[0].base);
    expect(mutations[1].updates[0].trace[0].operations).toEqual(mutations[0].updates[0].trace[0].operations);
    expect(host.overstoryd.acceptedUpdates(tree).length).toBe(before + 2);
  }, 30_000);

  test("an idle materialization over the disk budget is evicted and rebuilt on its next use", async () => {
    const collections = host.collections!;
    const held = sortedDump(materialized());
    const options = (collections as any).options as HostCollectionsOptions;
    options.materializedBytes = 0;
    options.materializedIdleMs = 0;
    try {
      // An open stream keeps it.
      const controller = new AbortController();
      const stream = await openQuery(host.url, controller);
      await nextResult(stream);
      await collections.evictIdle();
      expect(existsSync(materialized())).toBe(true);
      controller.abort();
      await Bun.sleep(50);
      await collections.evictIdle();
      expect(existsSync(materialized())).toBe(false);
    } finally {
      delete options.materializedBytes;
      delete options.materializedIdleMs;
    }
    const controller = new AbortController();
    try {
      const stream = await openQuery(host.url, controller);
      expect((await nextResult(stream)).value).toEqual({ id: LIST, name: "Neighbors", openToEdits: true });
    } finally { controller.abort(); }
    expect(sortedDump(materialized())).toEqual(held);
  }, 30_000);

  test("dropping the host's materialization and restarting rebuilds it to the same rows", async () => {
    const held = dump(materialized());
    host.server.stop(true);
    await host.overstoryd[Symbol.asyncDispose]();
    await rm(join(dataRoot, "materialized"), { recursive: true, force: true });
    host = await serve();
    const controller = new AbortController();
    try {
      const stream = await openQuery(host.url, controller);
      expect((await nextResult(stream)).value).toEqual({ id: LIST, name: "Neighbors", openToEdits: true });
    } finally { controller.abort(); }
    expect(dump(materialized())).toEqual(held);
  }, 30_000);
});
