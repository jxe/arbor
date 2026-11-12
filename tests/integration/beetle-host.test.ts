// Apps 015 steps 2 and 4: Beetle views and mutations run on the host, in process. Done
// when: a `.beetle` view streams its tree over the accepted rows and answers again when a
// mutation or a device's edit changes them; a data view streams its JSON and follows a
// profile edit; a schema's own view streams too; views read the host's SQLite copy of
// the collection; a mutation commits as one row-only update guarded on the head it read,
// with its receipt and retry; its public errors reach the caller with their codes; and a
// handle with another code version is refused.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { StorySyncDaemon } from "@ovst/story-sync";
import { CollectionProjections } from "@ovst/story-sync/state";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, HostAccountStore, type HandleRef, type MutationCallRequest, type ObjectHash, type ViewsRequest } from "@ovst/protocol";
import { loadDirectoryCollection } from "@ovst/collection-schema";
import { StoreSchema } from "@ovst/beetle";
import { rowsFromLogical } from "@ovst/usl";
import { Materialization } from "../../packages/overstoryd/src/beetle-materialized.ts";
import { installAccountHome } from "../helpers/account-home.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";
import { deviceClient, deviceSession, testAccount, testDevice } from "../helpers/devices.ts";

const token = "beetle-host-owner";
const EXAMPLES = join(import.meta.dir, "../../packages/beetle/examples/supplies");
const LIST = "10000000-0000-4000-8000-000000000001";
let sandbox: string, state: string, folder: string, dataRoot: string, tree: string, me: string;
let host: Awaited<ReturnType<typeof serveHost>>;
let minutes = 0;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-beetle-host-"));
  state = join(sandbox, "home");
  process.env.STORY_HOME = state;
  folder = join(sandbox, "tree");
  dataRoot = join(sandbox, "host");
  await mkdir(join(folder, "supplies", "data"), { recursive: true });
  for (const name of ["List.beetle", "Home.beetle", "Feeds.beetle", "mutations.beetle", "parts"]) {
    await cp(join(EXAMPLES, name), join(folder, "supplies", name), { recursive: true });
  }
  for (const name of ["schema.beetle", "_store.sqlite3"]) await cp(join(EXAMPLES, "data", name), join(folder, "supplies", "data", name));
  host = await serveHost({
    dataRoot, accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    // Each mutation a minute after the last, so an edit's time differs from its row's creation.
    beetle: { trees: "all", now: () => new Date(Date.UTC(2026, 10, 11, 12, minutes++, 0)) },
  });
  const owner = await deviceClient(host.url, token);
  me = (await owner.account()).account.profileTree!;
  const stores = new CollectionProjections();
  tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder, new Map(), [], (root, names) => stores.read(root, names))),
    { parent: { tree: me, name: "beetle", kind: "person" } });
  // The folder is this device's copy of the tree, so Story Sync can send its edits.
  const { values } = await readTreeConfig(owner, me, "person");
  const device = Object.values(values.devices!).find((candidate) => candidate.administrator)!.id;
  await installAccountHome(state, owner, device, testDevice(token).seed, { [folder]: tree });
});

afterAll(async () => {
  for (const account of await HostAccountStore.list()) await new HostAccountStore(account.configurationTree).remove();
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

/** A handle at the tree's head, with the code version the host checks it at. */
async function handle(path: string, name = ""): Promise<HandleRef> {
  const head = host.overstoryd.currentUpdate(tree)!;
  const { version } = await host.beetle!.check(head.root as ObjectHash, path);
  return { tree, path, name, version };
}

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
  const timeout = Bun.sleep(10_000).then(() => { throw new Error("Timed out waiting for a view result"); });
  while (true) {
    const next = await Promise.race([stream.next(), timeout]);
    if (next.done) throw new Error("The view stream closed");
    if (next.value.event === "result") return next.value.data;
  }
}

async function requestViews(controller: AbortController, views: ViewsRequest["views"]) {
  const session = await deviceSession(host.url, token);
  return fetch(`${host.url}/.overstory/trees/${tree}/views`, {
    method: "QUERY",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({ views } satisfies ViewsRequest),
    signal: controller.signal,
  });
}

async function mutate(name: string, input: unknown, mutationID: string) {
  const session = await deviceSession(host.url, token);
  const request: MutationCallRequest = { handle: await handle("/supplies/mutations.beetle", name), mutationID, input };
  const response = await fetch(`${host.url}/.overstory/trees/${tree}/mutate`, {
    method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return { status: response.status, body: await response.json() as any };
}

/** Two practices' ids, from the copy's rows. */
async function practices(): Promise<string[]> {
  const file = join(dataRoot, "beetle", "materialized", tree, encodeURIComponent("/supplies/data"), "_store.sqlite3");
  const db = new Database(file, { readonly: true });
  try {
    return (db.query(`select id from "Practice" order by id limit 2`).all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
}

/** Every node of a view tree, depth first. */
function nodes(tree: any[]): any[] {
  return tree.flatMap((n) => (typeof n === "string" ? [] : [n, ...nodes(n.children)]));
}

describe.serial("Beetle on the host", () => {
  test("a device's edit to the rows reaches an open view, and a schema's own view answers with it", async () => {
    process.env.STORY_HOME = state;
    const controller = new AbortController();
    const daemon = await StorySyncDaemon.openControl({ autoSync: false });
    try {
      await daemon.synchronizeNow();
      const response = await requestViews(controller, [
        { id: "list", handle: await handle("/supplies/List.beetle"), input: { id: LIST } },
        { id: "byOwner", handle: await handle("/supplies/data/schema.beetle", "ByOwner") },
      ]);
      expect(response.status).toBe(200);
      const stream = events(response);
      const latest = new Map<string, any>();
      const until = async (done: () => boolean) => { while (!done()) { const result = await nextResult(stream); latest.set(result.id, result); } };
      const title = () => latest.get("list")?.value?.[0]?.props?.title;
      const rows = () => JSON.stringify(latest.get("byOwner")?.value ?? null);
      await until(() => latest.has("list") && latest.has("byOwner"));
      expect(latest.get("byOwner").error).toBeUndefined();
      expect(title()).toBe("Community care");
      expect(rows()).toContain("Community care");

      // A device edits the row with sqlite3; the host accepts it as row operations.
      const mine = new Database(join(folder, "supplies", "data", "_store.sqlite3"));
      mine.query("update List set name = 'Neighbors' where id = ?").run(LIST);
      mine.close();
      await daemon.synchronizeNow();
      await until(() => title() === "Neighbors" && rows().includes("Neighbors") && !rows().includes("Community care"));
      // And back, as the later tests expect it.
      const again = new Database(join(folder, "supplies", "data", "_store.sqlite3"));
      again.query("update List set name = 'Community care' where id = ?").run(LIST);
      again.close();
      await daemon.synchronizeNow();
      await until(() => title() === "Community care" && !rows().includes("Neighbors"));
    } finally {
      controller.abort();
      await daemon[Symbol.asyncDispose]();
    }
  }, 30_000);

  test("a mutation commits as one row-only update guarded on the head it read, and its retry returns the same receipt", async () => {
    const submitted: any[] = [];
    const submit = host.overstoryd.submitUpdate.bind(host.overstoryd);
    host.overstoryd.submitUpdate = (id, request, caller) => { submitted.push(request); return submit(id, request, caller); };
    try {
      const before = host.overstoryd.acceptedUpdates(tree).length;
      const first = await mutate("createList", { name: "Made in Beetle", visibility: "Public" }, "beetle-create");
      expect(first.status).toBe(200);
      expect(submitted).toHaveLength(1);
      expect(submitted[0].updates[0].ifCurrent).toBe(submitted[0].base);
      expect(submitted[0].updates[0].trace[0].operations).toEqual([
        expect.objectContaining({ kind: "rowCreate", model: "List", at: "2026-11-11T12:00:00.000Z", values: expect.objectContaining({ name: "Made in Beetle", owner: me, visibility: "Public" }) }),
      ]);
      const accepted = host.overstoryd.acceptedUpdates(tree);
      expect(accepted.length).toBe(before + 1);
      expect(first.body.affected).toEqual({ tree, update: accepted.at(-1)!.id });
      expect(first.body.rows).toEqual([{ table: "List", key: expect.stringMatching(/^"[0-9a-f-]{36}"$/) }]);
      // An exact retry is answered from the receipt; the same identity with other input is a conflict.
      expect((await mutate("createList", { name: "Made in Beetle", visibility: "Public" }, "beetle-create")).body).toEqual(first.body);
      expect(submitted).toHaveLength(1);
      expect((await mutate("createList", { name: "Something else", visibility: "Public" }, "beetle-create")).status).toBe(409);
    } finally {
      host.overstoryd.submitUpdate = submit;
    }
  }, 30_000);

  test("public errors reach the caller with their codes and write nothing", async () => {
    const before = host.overstoryd.acceptedUpdates(tree).length;
    const forbidden = await mutate("renameList", { l: LIST, name: "Mine now" }, "beetle-rename-theirs");
    expect(forbidden).toEqual({ status: 403, body: expect.objectContaining({ error: "forbidden", message: "Only the owner can rename this list" }) });
    const missing = await mutate("renameList", { l: "no-such-list", name: "x" }, "beetle-rename-missing");
    expect(missing.status).toBe(404);
    const invalid = await mutate("createList", { name: "x", visibility: "Everyone" }, "beetle-invalid");
    expect(invalid.status).toBe(422);
    expect(host.overstoryd.acceptedUpdates(tree).length).toBe(before);
  }, 30_000);

  test("a view streams its tree over the accepted rows and answers again when a mutation changes them", async () => {
    const made = await mutate("createList", { name: "Drawn in Beetle", visibility: "Public" }, "beetle-drawn");
    const id = JSON.parse(made.body.rows[0].key) as string;
    const controller = new AbortController();
    try {
      const response = await requestViews(controller, [{ id: "list", handle: await handle("/supplies/List.beetle"), input: { id } }]);
      expect(response.status).toBe(200);
      const stream = events(response);
      const first = await nextResult(stream);
      expect(first.error).toBeUndefined();
      expect(first.value[0]).toMatchObject({ type: "Shell", props: { title: "Drawn in Beetle" } });
      // Its owner's avatar shows their profile card's name.
      expect(nodes(first.value).some((n) => n.type === "Portrait")).toBe(true);
      // The like button holds the mutation it runs, with the file that declares it.
      expect(nodes(first.value).find((n) => n.type === "Button").props.action).toEqual({ action: "toggleListReaction", from: "/supplies/mutations.beetle", args: { l: { row: "List", key: id } } });

      const renamed = await mutate("renameList", { l: id, name: "Renamed in Beetle" }, "beetle-rename");
      expect(renamed.status).toBe(200);
      expect((await nextResult(stream)).value[0].props.title).toBe("Renamed in Beetle");

      const liked = await mutate("toggleListReaction", { l: id }, "beetle-like");
      expect(liked.body.rows).toEqual([{ table: "Reaction", key: JSON.stringify({ list: id, person: me }) }]);
      const after = await nextResult(stream);
      expect(nodes(after.value).find((n) => n.type === "Button").children.join("").trim()).toBe("👍 1");
      const unliked = await mutate("toggleListReaction", { l: id }, "beetle-unlike");
      expect(unliked.body.rows).toEqual([{ table: "Reaction", key: JSON.stringify({ list: id, person: me }), deleted: true }]);
    } finally { controller.abort(); }
  }, 30_000);

  test("a mutation's SQL transaction commits on its copy as the accepted rows, at the accepted directory", async () => {
    const made = await mutate("createList", { name: "Written in SQL", visibility: "Public" }, "sql-create");
    const id = JSON.parse(made.body.rows[0].key) as string;
    for (const [name, input, mutationID] of [
      ["renameList", { l: id, name: "Renamed in SQL" }, "sql-rename"],
      ["toggleListReaction", { l: id }, "sql-like"],
      ["setListPractice", { l: id, p: (await practices())[0], included: true }, "sql-practice-1"],
      ["setListPractice", { l: id, p: (await practices())[1], included: true }, "sql-practice-2"],
      ["reorderList", { l: id, practices: [(await practices())[1], (await practices())[0]] }, "sql-reorder"],
      ["setListPractice", { l: id, p: (await practices())[0], included: false }, "sql-practice-3"],
    ] as const) expect((await mutate(name, input, mutationID)).status).toBe(200);
    const head = host.overstoryd.currentUpdate(tree)!;
    const objects = new Map<string, Uint8Array>((await (await deviceClient(host.url, token)).snapshot(tree, head.root)).objects);
    const load = async (hash: string) => objects.get(hash)!;
    let at = decodeProtocolDirectory(objects.get(head.root)!);
    for (const name of ["supplies", "data"]) at = decodeProtocolDirectory(objects.get(at.entries.find((e) => e.name === name)!.directory!)!);
    const dataHash = hashObject(encodeProtocolDirectory(at));
    const collection = (await loadDirectoryCollection(at, load))!;
    const schema = new StoreSchema(collection.schema.result);
    const file = join(dataRoot, "beetle", "materialized", tree, encodeURIComponent("/supplies/data"), "_store.sqlite3");
    const copy = new Database(file, { readonly: true });
    const fresh = Materialization.build(join(sandbox, "fresh"), schema.layout, rowsFromLogical(schema.result, schema.layout, collection.tables), dataHash, "s");
    try {
      // The copy holds the accepted directory: its transaction committed, no catch-up ran.
      expect((copy.query("select value from __beetle_materialized where key = 'directory'").get() as { value: string }).value).toBe(dataHash);
      const dump = (db: Database) => Object.fromEntries(schema.layout.map((t) => [t.name, db.query(`select * from "${t.name}" order by ${t.primaryKey.map((k) => `"${k}"`).join(", ")}`).all()]));
      expect(dump(copy)).toEqual(dump(fresh.database));
    } finally {
      copy.close();
      fresh.close();
    }
  }, 30_000);

  test("a data view streams its JSON", async () => {
    const controller = new AbortController();
    try {
      const response = await requestViews(controller, [{ id: "feed", handle: await handle("/supplies/Feeds.beetle", "ListsByOwner"), input: { owner: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa" } }]);
      expect(response.status).toBe(200);
      const result = await nextResult(events(response));
      expect(result.error).toBeUndefined();
      expect(result.value.lists.map((l: any) => l.name).sort()).toEqual(["Community care", "Quiet experiments"]);
      expect(result.value.lists.find((l: any) => l.name === "Community care").size).toBeGreaterThan(0);
      // It read the host's SQLite copy of the collection, built from the accepted rows.
      expect(existsSync(join(dataRoot, "beetle", "materialized", tree, encodeURIComponent("/supplies/data"), "_store.sqlite3"))).toBe(true);
    } finally { controller.abort(); }
  }, 30_000);

  test("a handle with another code version, or a view the file doesn't declare, is refused", async () => {
    const controller = new AbortController();
    try {
      const stale = await requestViews(controller, [{ id: "list", handle: { ...await handle("/supplies/List.beetle"), version: `sha256:${"0".repeat(64)}` }, input: { id: LIST } }]);
      expect(stale.status).toBe(404);
      expect((await stale.json() as any).message).toContain("not active");
      const missing = await requestViews(controller, [{ id: "list", handle: await handle("/supplies/Feeds.beetle", "Nowhere") }]);
      expect(missing.status).toBe(200);
      expect((await nextResult(events(missing))).error).toMatchObject({ code: "not-found" });
    } finally { controller.abort(); }
  }, 30_000);
  test("a view reads its people's profile cards as its caller may, and follows a profile edit", async () => {
    const controller = new AbortController();
    try {
      const response = await requestViews(controller, [{ id: "feed", handle: await handle("/supplies/Feeds.beetle", "ListsByOwner"), input: { owner: me } }]);
      const stream = events(response);
      const owners = (result: any) => result.value.lists.map((l: any) => l.owner);
      expect(owners(await nextResult(stream))).toContainEqual({ name: "owner", handle: "owner" });

      // The owner names themselves; the stream's result follows.
      const owner = await deviceClient(host.url, token);
      const current = await owner.descriptor(me);
      const snapshot = await owner.snapshot(me, current.tree.root);
      const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
      const index = root.entries.find((entry) => entry.name === "_index.md")!;
      const text = new TextDecoder().decode(snapshot.objects.get(index.file!)!);
      const named = new TextEncoder().encode(text.replace(/^displayName: .*$/m, "displayName: Olive Owner"));
      const file = hashObject(named);
      const directory = encodeProtocolDirectory({ ...root, entries: root.entries.map((entry) => entry.name === "_index.md" ? { name: entry.name, file, created: 0, modified: 0 } : entry) });
      await owner.submitUpdate(me, current.tree.update, { root: hashObject(directory), objects: new Map([...snapshot.objects, [file, named], [hashObject(directory), directory]]) } as never);
      expect(owners(await nextResult(stream))).toContainEqual({ name: "Olive Owner", handle: "owner" });
    } finally { controller.abort(); }
  }, 30_000);
});
