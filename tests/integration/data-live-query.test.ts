import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { revisionOf, type HandleRef, type ViewEvent } from "@ovst/protocol";
import {
  node,
  introspectStoreSchema,
  LiveViewBroker,
  RegisteredViewRuntime,
  SQLiteQueryEngine,
  SQLiteStoreBroker,
  view,
  type MountedView,
  type NodeHandle,
  type ProfileResolver,
  type StoreSchema,
  type View,
} from "overstory/data";

const repository = join(import.meta.dir, "..", "..");
const fixture = join(repository, "examples", "supplies", "data");
const careList = "10000000-0000-4000-8000-000000000001";
const listeningList = "10000000-0000-4000-8000-000000000003";
const ada = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";

const List = node("./data/List").children as any;
const topPublicList = view(() => List.all((l: any) => [l.visibility.is("Public")])
  .orderBy((l: any) => l.modified.desc())
  .take(1)
  .map((l: any) => ({ id: l.id, name: l.name, about: l.about, modified: l.modified }))) as View<unknown, unknown>;
const listOwner = view(() => {
  const l = List.one((l: any) => [l.id.is(careList)]);
  return { id: l.id, owner: { id: l.owner.id, name: l.owner.name, handle: l.owner.handle, portrait: l.owner.portrait } };
}) as View<unknown, unknown>;

let directory: string;
let schema: StoreSchema;
let profiles: Array<Record<string, unknown>>;
let profileListeners: Set<(change: { profile: string; tree: string; ref: string }) => void>;
let resolver: ProfileResolver;
let engine: SQLiteQueryEngine;
let store: SQLiteStoreBroker;
let broker: LiveViewBroker;

/** The sources the views name, bound as an activation binds them. */
async function resolve(source: NodeHandle) {
  return {
    authoredPath: source.path,
    tree: "tr_supplies_data",
    path: `/${source.path.slice(source.path.lastIndexOf("/") + 1)}`,
    schemaFingerprint: engine.schema.fingerprint,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "story-live-query-"));
  await Promise.all(["_store.sqlite3", "schema.usl"].map((name) => cp(join(fixture, name), join(directory, name))));
  const location = {
    directory,
    databasePath: join(directory, "_store.sqlite3"),
    schemaPath: join(directory, "schema.usl"),
    tree: "tr_supplies_data",
    path: "/",
  };
  schema = await introspectStoreSchema(location);
  profiles = JSON.parse(await readFile(join(repository, "tests", "fixtures", "supplies", "profiles.json"), "utf8"));
  profileListeners = new Set();
  resolver = {
    async resolve(ids, fields) {
      const rows = profiles.filter((profile) => ids.includes(String(profile.id)))
        .map((profile) => Object.fromEntries(fields.map((field) => [field, profile[field]])));
      return {
        rows,
        dependencies: rows.map((row) => ({
          profile: String(row.id),
          tree: String(row.id),
          ref: revisionOf(JSON.stringify(profiles.find((profile) => profile.id === row.id))),
        })),
      };
    },
    subscribe(listener) {
      profileListeners.add(listener);
      return () => profileListeners.delete(listener);
    },
  };
  engine = await SQLiteQueryEngine.open(location, resolver);
  store = new SQLiteStoreBroker(location.databasePath, schema, { watchExternal: false });
  broker = new LiveViewBroker(engine, store);
});

afterEach(async () => {
  await broker?.[Symbol.asyncDispose]();
  await store?.[Symbol.asyncDispose]();
  await engine?.[Symbol.asyncDispose]();
  await rm(directory, { recursive: true, force: true });
});

async function next(reader: ReadableStreamDefaultReader<ViewEvent>, type?: ViewEvent["type"]): Promise<ViewEvent> {
  const expires = Bun.sleep(1_000).then(() => { throw new Error(`Timed out waiting for ${type ?? "query event"}`); });
  while (true) {
    const result = await Promise.race([reader.read(), expires]);
    if (result.done) throw new Error("Query stream closed");
    if (!type || result.value.type === type) return result.value;
  }
}

async function ready(reader: ReadableStreamDefaultReader<ViewEvent>) {
  const first = await next(reader, "result");
  const boundary = await next(reader, "ready");
  return { first, boundary };
}

function mount(handle = topPublicList, knownOutputHash?: `sha256:${string}`): MountedView[] {
  return [{ id: "primary", handle, resolve, ...(knownOutputHash ? { knownOutputHash } : {}) }];
}

describe.serial("Supplies Phase 2 live data", () => {
describe("SQLite committed observation", () => {
  test("publishes ordered row details after commit and nothing after rollback", () => {
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    store.transaction((database) => {
      database.query("update List set about = ? where id = ?").run("Changed", careList);
      expect(events).toHaveLength(0);
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cursor: "sqlite:1",
      precision: "rows",
      changes: [{
        collection: "List",
        operation: "update",
        primaryKey: { id: careList },
        changedFields: ["about"],
        before: { about: "Practices for showing up for one another." },
        after: { about: "Changed" },
      }],
    });
    expect(() => store.transaction((database) => {
      database.query("update List set name = ? where id = ?").run("Rolled back", careList);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(events).toHaveLength(1);
  });
});

describe("live view state machine", () => {
  test("updates two clients while precise unrelated writes cause no rerun", async () => {
    const original = engine.execute.bind(engine);
    let executions = 0;
    engine.execute = (async (...args: Parameters<typeof original>) => {
      executions += 1;
      return original(...args);
    }) as typeof engine.execute;
    const first = broker.stream(mount(topPublicList), { signal: new AbortController().signal, user: null }).getReader();
    const second = broker.stream(mount(topPublicList), { signal: new AbortController().signal, user: null }).getReader();
    await Promise.all([ready(first), ready(second)]);
    expect(executions).toBe(2);

    store.transaction((database) => database.query("update List set about = ? where id = ?").run("Still private", "10000000-0000-4000-8000-000000000002"));
    await Bun.sleep(25);
    expect(executions).toBe(2);

    store.transaction((database) => database.query("update List set name = ? where id = ?").run("Listening together", listeningList));
    const [left, right] = await Promise.all([next(first, "result"), next(second, "result")]);
    expect((left as Extract<ViewEvent, { value: unknown }>).value).toMatchObject([{ name: "Listening together" }]);
    expect((right as Extract<ViewEvent, { value: unknown }>).value).toEqual((left as Extract<ViewEvent, { value: unknown }>).value);
    expect(executions).toBe(4);
    await first.cancel();
    await second.cancel();
  });

  test("tracks entering rows and top-N reorder boundaries", async () => {
    const reader = broker.stream(mount(), { signal: new AbortController().signal, user: null }).getReader();
    await ready(reader);
    store.transaction((database) => database.query(
      "insert into List(id, owner, name, visibility, kind, openToEdits, created, modified) values (?, ?, ?, 'Public', 'Standard', 0, ?, ?)",
    ).run("10000000-0000-4000-8000-000000000004", ada, "Newest", "2026-08-25T12:00:00.000Z", "2026-08-26T12:00:00.000Z"));
    const inserted = await next(reader, "result") as Extract<ViewEvent, { value: unknown }>;
    expect(inserted.value).toMatchObject([{ name: "Newest" }]);

    store.transaction((database) => database.query("update List set modified = ? where id = ?").run("2026-08-27T12:00:00.000Z", careList));
    const reordered = await next(reader, "result") as Extract<ViewEvent, { value: unknown }>;
    expect(reordered.value).toMatchObject([{ id: careList }]);
    await reader.cancel();
  });

  test("invalidates exact profile dependencies", async () => {
    const reader = broker.stream(mount(listOwner), { signal: new AbortController().signal, user: null }).getReader();
    await ready(reader);
    profiles = profiles.map((profile) => profile.id === ada ? { ...profile, name: "Ada Updated" } : profile);
    for (const listener of profileListeners) listener({ profile: ada, tree: ada, ref: revisionOf("updated") });
    const event = await next(reader, "result") as Extract<ViewEvent, { value: unknown }>;
    expect(event.value).toMatchObject({ owner: { name: "Ada Updated" } });
    await reader.cancel();
  });

  test("reruns when a mutation lands during execution and never publishes stale state", async () => {
    const reader = broker.stream(mount(), { signal: new AbortController().signal, user: null }).getReader();
    await ready(reader);
    const original = engine.execute.bind(engine);
    let pause = true;
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    engine.execute = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (pause) {
        pause = false;
        entered();
        await gate;
      }
      return result;
    }) as typeof engine.execute;
    store.transaction((database) => database.query("update List set name = ? where id = ?").run("Intermediate", listeningList));
    await didEnter;
    store.transaction((database) => database.query("update List set name = ? where id = ?").run("Current", listeningList));
    release();
    const event = await next(reader, "result") as Extract<ViewEvent, { value: unknown }>;
    expect(event.value).toMatchObject([{ name: "Current" }]);
    await reader.cancel();
  });

  test("conservatively invalidates an external commit", async () => {
    const reader = broker.stream(mount(), { signal: new AbortController().signal, user: null }).getReader();
    await ready(reader);
    const external = new Database(join(directory, "_store.sqlite3"));
    external.query("update List set name = ? where id = ?").run("External", listeningList);
    external.close();
    expect(store.checkExternalChanges()).toBe(true);
    const event = await next(reader, "result") as Extract<ViewEvent, { value: unknown }>;
    expect(event.value).toMatchObject([{ name: "External" }]);
    await reader.cancel();
  });

  test("fresh reconnect confirms a known hash and listener restart takes a new snapshot", async () => {
    const first = broker.stream(mount(), { signal: new AbortController().signal, user: null }).getReader();
    const initial = await ready(first);
    const hash = (initial.first as Extract<ViewEvent, { value: unknown }>).outputHash;
    await first.cancel();
    const reconnect = broker.stream(mount(topPublicList, hash), { signal: new AbortController().signal, user: null }).getReader();
    const confirmation = await next(reconnect);
    expect(confirmation.type).toBe("ready");
    await reconnect.cancel();

    await broker[Symbol.asyncDispose]();
    broker = new LiveViewBroker(engine, store);
    store.transaction((database) => database.query("update List set name = ? where id = ?").run("After restart", listeningList));
    const restarted = broker.stream(mount(), { signal: new AbortController().signal, user: null }).getReader();
    const snapshot = await ready(restarted);
    expect((snapshot.first as Extract<ViewEvent, { value: unknown }>).value).toMatchObject([{ name: "After restart" }]);
    await restarted.cancel();
  });

  test("replaces the complete mounted graph without retaining an execution resource", async () => {
    const document = { tree: "tr_supplies_source", path: "/index", version: "doc-v1" };
    const topRef: HandleRef = { tree: "tr_supplies_source", path: "/components/PopularLists.tsx", name: "popularLists", version: "sha256:code" };
    const ownerRef: HandleRef = { tree: "tr_supplies_source", path: "/List.tsx", name: "listOwner", version: "sha256:code" };
    const runtime = new RegisteredViewRuntime(document, broker, [
      { ref: topRef, handle: topPublicList, resolve },
      { ref: ownerRef, handle: listOwner, resolve },
    ]);
    const first = runtime.stream({ document, views: [{ id: "top", handle: topRef }] }, { signal: new AbortController().signal, user: null }).getReader();
    await ready(first);
    await first.cancel();

    const replacement = runtime.stream({ document, views: [
      { id: "top", handle: topRef },
      { id: "owner", handle: ownerRef },
    ] }, { signal: new AbortController().signal, user: null }).getReader();
    const results = [await next(replacement, "result"), await next(replacement, "result")];
    expect(results.map((event) => (event as Extract<ViewEvent, { value: unknown }>).id).sort()).toEqual(["owner", "top"]);
    const boundary = await next(replacement, "ready") as Extract<ViewEvent, { type: "ready" }>;
    expect(boundary.views.map((mounted) => mounted.id)).toEqual(["top", "owner"]);
    await replacement.cancel();
  });

  test("uses the shared result event name for sanitized view failures", async () => {
    const reader = broker.stream([{ id: "invalid", handle: topPublicList, resolve, input: { unexpected: true } }], {
      signal: new AbortController().signal,
      user: null,
    }).getReader();
    const failure = await next(reader, "result") as Extract<ViewEvent, { error: unknown }>;
    expect(failure).toMatchObject({
      type: "result",
      id: "invalid",
      error: { code: "invalid-request", retryable: false },
    });
    expect("value" in failure).toBe(false);
    await next(reader, "ready");
    await reader.cancel();
  });
});
});
