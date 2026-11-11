// Apps 015 step 2: Beetle views and mutations run on the host, in process. Done when: a
// `.beetle` view streams its tree over the accepted rows and answers again when a
// mutation changes them; a data view streams its JSON; a mutation commits as one row-only
// update guarded on the head it read, with its receipt and retry; its public errors reach
// the caller with their codes; and a handle with another code version is refused.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollectionProjections } from "@ovst/story-sync/state";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { HostAccountStore, type HandleRef, type MutationCallRequest, type ObjectHash, type ViewsRequest } from "@ovst/protocol";
import { hostTree } from "../helpers/tree-config.ts";
import { deviceClient, deviceSession, testAccount } from "../helpers/devices.ts";

const token = "beetle-host-owner";
const EXAMPLES = join(import.meta.dir, "../../packages/beetle/examples/supplies");
const SUPPLIES = join(import.meta.dir, "../../examples/supplies");
const LIST = "10000000-0000-4000-8000-000000000001";
let sandbox: string, folder: string, dataRoot: string, tree: string, me: string;
let host: Awaited<ReturnType<typeof serveHost>>;
let minutes = 0;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-beetle-host-"));
  process.env.STORY_HOME = join(sandbox, "home");
  folder = join(sandbox, "tree");
  dataRoot = join(sandbox, "host");
  await mkdir(join(folder, "supplies", "data"), { recursive: true });
  for (const name of ["List.beetle", "Home.beetle", "Feeds.beetle", "mutations.beetle", "parts"]) {
    await cp(join(EXAMPLES, name), join(folder, "supplies", name), { recursive: true });
  }
  await cp(join(EXAMPLES, "data", "schema.beetle"), join(folder, "supplies", "data", "schema.beetle"));
  await cp(join(SUPPLIES, "data", "_store.sqlite3"), join(folder, "supplies", "data", "_store.sqlite3"));
  host = await serveHost({
    dataRoot, accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    // Each mutation a minute after the last, so an edit's time differs from its row's creation.
    collections: { beetle: "all", now: () => new Date(Date.UTC(2026, 10, 11, 12, minutes++, 0)) },
  });
  const owner = await deviceClient(host.url, token);
  me = (await owner.account()).account.profileTree!;
  const stores = new CollectionProjections();
  tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(folder, new Map(), [], (root, names) => stores.read(root, names))),
    { parent: { tree: me, name: "beetle", kind: "person" } });
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
  const { version } = await host.collections!.beetle!.check(head.root as ObjectHash, path);
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

/** Every node of a view tree, depth first. */
function nodes(tree: any[]): any[] {
  return tree.flatMap((n) => (typeof n === "string" ? [] : [n, ...nodes(n.children)]));
}

describe.serial("Beetle on the host", () => {
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

  test("a data view streams its JSON", async () => {
    const controller = new AbortController();
    try {
      const response = await requestViews(controller, [{ id: "feed", handle: await handle("/supplies/Feeds.beetle", "ListsByOwner"), input: { owner: "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa" } }]);
      expect(response.status).toBe(200);
      const result = await nextResult(events(response));
      expect(result.error).toBeUndefined();
      expect(result.value.lists.map((l: any) => l.name).sort()).toEqual(["Community care", "Quiet experiments"]);
      expect(result.value.lists.find((l: any) => l.name === "Community care").size).toBeGreaterThan(0);
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
});
