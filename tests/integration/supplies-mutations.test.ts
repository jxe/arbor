import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { revisionOf, semanticRequestDigest, type MutationHandleRef, type MutationResultReceipt, type QueryStreamEvent } from "@arbor/core";
import { z } from "zod";
import {
  database,
  LiveQueryBroker,
  mutation,
  MutationCallError,
  query,
  RegisteredMutationRuntime,
  SQLiteMutationBroker,
  SQLiteQueryEngine,
  SQLiteStoreBroker,
  type MutationHandle,
  type ProfileResolver,
} from "arbor/data";

mock.module("arbor/react", () => ({
  Markdown: () => null,
  skipQuery: Symbol("skip-query"),
  useMutationAction: () => [{}, () => undefined, false],
  useNavigate: () => () => undefined,
  useQuery: () => [],
  useUser: () => null,
}));

const repository = join(import.meta.dir, "..", "..");
const supplies = join(repository, "sites", "supplies");
const fixture = join(supplies, "data");
const ada = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const bo = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const careList = "10000000-0000-4000-8000-000000000001";
const privateList = "10000000-0000-4000-8000-000000000002";
const listeningList = "10000000-0000-4000-8000-000000000003";
const mutualAid = "00000000-0000-4000-8000-000000000001";
const listening = "00000000-0000-4000-8000-000000000002";
const walking = "00000000-0000-4000-8000-000000000003";
const document = { tree: "tr_supplies_source", path: "/List", version: "doc-v1" };

let directory: string;
let databasePath: string;
let store: SQLiteStoreBroker;
let engine: SQLiteQueryEngine;
let live: LiveQueryBroker;
let broker: SQLiteMutationBroker;
let runtime: RegisteredMutationRuntime;
let handles: Record<string, MutationHandle<unknown, unknown>>;
let refs: Record<string, MutationHandleRef>;
let clock = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "arbor-supplies-mutations-"));
  await Promise.all(["_store.sqlite3", "schema.sql", "relationships.json"].map((name) => cp(join(fixture, name), join(directory, name))));
  databasePath = join(directory, "_store.sqlite3");
  const location = {
    directory,
    databasePath,
    schemaPath: join(directory, "schema.sql"),
    relationshipsPath: join(directory, "relationships.json"),
  };
  const profiles = JSON.parse(await readFile(join(repository, "tests", "fixtures", "supplies", "profiles.json"), "utf8")) as Array<Record<string, unknown>>;
  const resolver: ProfileResolver = {
    async resolve(ids, fields) {
      const rows = profiles.filter((profile) => ids.includes(String(profile.id)))
        .map((profile) => Object.fromEntries(fields.map((field) => [field, profile[field]])));
      return {
        rows,
        dependencies: rows.map((row) => ({ profile: String(row.id), tree: String(row.id), ref: revisionOf(JSON.stringify(row)) })),
      };
    },
  };
  engine = await SQLiteQueryEngine.open(location, resolver);
  store = new SQLiteStoreBroker(databasePath, engine.schema, { watchExternal: false });
  live = new LiveQueryBroker(engine, store);
  broker = new SQLiteMutationBroker(engine.schema, store, {
    now: () => new Date(Date.UTC(2026, 7, 27, 12, 0, clock++)),
  });

  const [list, myLists, practice, mutations] = await Promise.all([
    import(join(supplies, "List.tsx")),
    import(join(supplies, "MyLists.tsx")),
    import(join(supplies, "Practice.tsx")),
    import(join(supplies, "scripts", "mutations.ts")),
  ]);
  handles = {
    createList: myLists.createList,
    renameList: list.renameList,
    reorderList: list.reorderList,
    toggleListReaction: list.toggleListReaction,
    setListSharing: list.setListSharing,
    createPractice: list.createPractice,
    setListKind: list.setListKind,
    createListTag: list.createListTag,
    deleteListTag: list.deleteListTag,
    setPracticeTag: list.setPracticeTag,
    duplicateList: list.duplicateList,
    updatePractice: practice.updatePractice,
    setListPractice: mutations.setListPractice,
  };
  refs = Object.fromEntries(Object.keys(handles).map((name) => [name, {
    tree: "tr_supplies_source",
    module: name === "createList" ? "/MyLists.tsx" : name === "updatePractice" ? "/Practice.tsx" : name === "setListPractice" ? "/scripts/mutations.ts" : "/List.tsx",
    export: name,
    version: `sha256:${name}`,
  }]));
  runtime = new RegisteredMutationRuntime(document, broker, Object.entries(handles).map(([name, handle]) => ({ ref: refs[name]!, handle })));
});

afterAll(async () => {
  await live?.[Symbol.asyncDispose]();
  await store?.[Symbol.asyncDispose]();
  await engine?.[Symbol.asyncDispose]();
  await rm(directory, { recursive: true, force: true });
  mock.restore();
});

function user(profile: string) { return { user: { profile } }; }

function call<Result = unknown>(name: string, input: unknown, mutationID = `mutation-${name}`, profile = ada): Promise<MutationResultReceipt<Result>> {
  return runtime.call({ document, handle: refs[name]!, mutationID, input }, user(profile)) as Promise<MutationResultReceipt<Result>>;
}

function all(sql: string, ...parameters: unknown[]): Record<string, unknown>[] {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try { return database.query(sql).all(...parameters as any[]) as Record<string, unknown>[]; }
  finally { database.close(); }
}

async function next(reader: ReadableStreamDefaultReader<QueryStreamEvent>, type: QueryStreamEvent["type"]): Promise<QueryStreamEvent> {
  const timeout = Bun.sleep(1_000).then(() => { throw new Error(`Timed out waiting for ${type}`); });
  while (true) {
    const result = await Promise.race([reader.read(), timeout]);
    if (result.done) throw new Error("Query stream closed");
    if (result.value.type === type) return result.value;
  }
}

describe.serial("Supplies mutation runner", () => {
  test("validates before data access and returns sanitized expected failures", async () => {
    const before = store.currentCursor();
    await expect(call("createList", { name: "", visibility: "public" }, "invalid-create"))
      .rejects.toMatchObject({ value: { code: "invalid-input", retryable: false } });
    expect(store.currentCursor()).toBe(before);
    expect(all("select * from __arbor_mutation_receipts where mutation_id = 'invalid-create'")).toHaveLength(0);

    await expect(call("renameList", { listId: careList, name: "No" }, "denied-rename", bo))
      .rejects.toMatchObject({ value: { code: "permission-denied", message: "Only the owner can rename this list" } });
    expect(all("select name from lists where id = ?", careList)[0]?.name).toBe("Community care");

    const diagnostics: unknown[] = [];
    const diagnosticBroker = new SQLiteMutationBroker(engine.schema, store, { diagnostic: (error) => diagnostics.push(error) });
    const authored = database("./data");
    const failing = mutation(authored, z.object({}), async ({ tx }: any) => {
      tx.insert(authored.relations.lists!, {
        id: "99999999-0000-4000-8000-000000000001",
        owner_profile: ada,
        name: "Must disappear",
        about: "",
        visibility: "private",
        kind: "standard",
        allow_arbor_user_edits: false,
        created_at: "secret path /tmp/store",
        updated_at: "secret path /tmp/store",
      });
      throw new Error("private SQL and /tmp/store details");
    });
    await expect(diagnosticBroker.execute(failing, {
      scope: document.tree,
      handle: { tree: document.tree, module: "/failure.ts", export: "failing", version: "sha256:failure" },
      mutationID: "unexpected-failure",
      input: {},
      user: { profile: ada },
    })).rejects.toMatchObject({ value: { code: "internal-error", message: "The mutation could not be completed" } });
    expect(String(diagnostics[0])).toContain("private SQL");
    expect(all("select * from lists where name = 'Must disappear'")).toHaveLength(0);
  });

  test("replays exact ambiguous submissions with stable IDs, time, cursor, result, and one effect", async () => {
    const changes: unknown[] = [];
    let receiptVisibleAtPublication = false;
    const stop = store.subscribe((change) => {
      changes.push(change);
      receiptVisibleAtPublication = all("select 1 from __arbor_mutation_receipts where mutation_id = 'stable-create'").length === 1;
    });
    const first = await call<{ id: string }>("createList", { name: "Retry stable", visibility: "private" }, "stable-create");
    const retry = await call<{ id: string }>("createList", { name: "Retry stable", visibility: "private" }, "stable-create");
    stop();
    expect(retry).toEqual(first);
    expect(first.requestDigest).toBe(semanticRequestDigest({
      version: "mutation-call-v1",
      handle: refs.createList,
      input: { name: "Retry stable", visibility: "private" },
    }));
    expect(first.result.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(all("select id, created_at from lists where name = 'Retry stable'")).toEqual([{ id: first.result.id, created_at: "2026-08-27T12:00:01.000Z" }]);
    expect(all("select observed_through, result_json from __arbor_mutation_receipts where mutation_id = 'stable-create'")).toEqual([{
      observed_through: first.observedThrough,
      result_json: JSON.stringify(first.result),
    }]);
    expect(changes).toHaveLength(1);
    expect(receiptVisibleAtPublication).toBe(true);
    await expect(call("createList", { name: "Different", visibility: "private" }, "stable-create"))
      .rejects.toMatchObject({ value: { code: "conflict" } });

    const otherSubject = await call<{ id: string }>("createList", { name: "Retry stable", visibility: "private" }, "stable-create", bo);
    expect(otherSubject.requestDigest).toBe(first.requestDigest);
    expect(otherSubject.result.id).not.toBe(first.result.id);
    expect(all("select subject from __arbor_mutation_receipts where mutation_id = 'stable-create' order by subject"))
      .toEqual([{ subject: ada }, { subject: bo }]);
  });

  test("runs every checked-in mutation and keeps multi-row policy checks atomic", async () => {
    const created = await call<{ id: string }>("createList", { name: "Working list", visibility: "private", owner_profile: bo }, "all-create");
    expect(all("select owner_profile from lists where id = ?", created.result.id)).toEqual([{ owner_profile: ada }]);
    await call("renameList", { listId: created.result.id, name: "Working together" }, "all-rename");
    await call("setListSharing", { listId: created.result.id, visibility: "public", allowArborUserEdits: "true" }, "all-sharing");

    const practice = await call<{ id: string }>("createPractice", {
      name: "Shared cooking",
      about: "Cook something together.",
      addToList: created.result.id,
    }, "all-practice", bo);
    expect(all("select profile from list_contributors where list_id = ?", created.result.id)).toEqual([{ profile: bo }]);

    const tag = await call<{ id: string }>("createListTag", { listId: created.result.id, name: "Food", color: "amber" }, "all-tag");
    await call("setPracticeTag", { listId: created.result.id, practiceId: practice.result.id, tagId: tag.result.id, included: "true" }, "all-practice-tag", bo);
    await call("setListKind", { listId: created.result.id, kind: "tagged" }, "all-kind");
    await call("setListPractice", { listId: created.result.id, practiceId: mutualAid, included: "true" }, "all-membership", bo);
    await call("reorderList", { listId: created.result.id, practiceIds: [mutualAid, practice.result.id] }, "all-reorder", bo);
    await call("toggleListReaction", { listId: created.result.id }, "all-reaction", bo);
    const duplicate = await call<{ id: string }>("duplicateList", { listId: created.result.id }, "all-duplicate", bo);
    await call("updatePractice", { practiceId: practice.result.id, name: "Shared cooking updated", about: "Cook and eat together." }, "all-update-practice", bo);
    await call("deleteListTag", { listId: created.result.id, tagId: tag.result.id }, "all-delete-tag");
    await call("setListPractice", { listId: created.result.id, practiceId: mutualAid, included: "false" }, "all-remove-membership", bo);

    expect(all("select practice_id, position from list_practices where list_id = ? order by position", created.result.id)).toEqual([{ practice_id: practice.result.id, position: 0 }]);
    expect(all("select * from practice_tags where list_id = ?", created.result.id)).toHaveLength(0);
    expect(all("select kind from lists where id = ?", created.result.id)).toEqual([{ kind: "tagged" }]);
    expect(all("select emoji from list_reactions where list_id = ? and profile = ?", created.result.id, bo)).toEqual([{ emoji: "👍" }]);
    expect(all("select name from practices where id = ?", practice.result.id)).toEqual([{ name: "Shared cooking updated" }]);
    expect(all("select practice_id, position from list_practices where list_id = ? order by position", duplicate.result.id)).toEqual([
      { practice_id: mutualAid, position: 0 },
      { practice_id: practice.result.id, position: 1 },
    ]);

    await expect(call("createPractice", {
      name: "Must roll back",
      about: "This insert precedes the policy check.",
      addToList: privateList,
    }, "atomic-denial", bo)).rejects.toMatchObject({ value: { code: "permission-denied" } });
    expect(all("select * from practices where name = 'Must roll back'")).toHaveLength(0);
    expect(all("select * from practice_authors where author_profile = ? and practice_id not in (?, ?, ?, ?)", bo, mutualAid, listening, walking, practice.result.id)).toHaveLength(0);
  });

  test("serializes concurrent append and reorder operations without duplicate or derived-count positions", async () => {
    const created = await call<{ id: string }>("createList", { name: "Concurrent", visibility: "private" }, "concurrent-list");
    await Promise.all([
      call("setListPractice", { listId: created.result.id, practiceId: mutualAid, included: true }, "append-a"),
      call("setListPractice", { listId: created.result.id, practiceId: listening, included: true }, "append-b"),
    ]);
    expect(all("select practice_id, position from list_practices where list_id = ? order by position", created.result.id)).toEqual([
      { practice_id: mutualAid, position: 0 },
      { practice_id: listening, position: 1 },
    ]);
    await Promise.all([
      call("reorderList", { listId: created.result.id, practiceIds: [listening, mutualAid] }, "reorder-a"),
      call("reorderList", { listId: created.result.id, practiceIds: [mutualAid, listening] }, "reorder-b"),
    ]);
    expect(all("select practice_id, position from list_practices where list_id = ? order by position", created.result.id)).toEqual([
      { practice_id: mutualAid, position: 0 },
      { practice_id: listening, position: 1 },
    ]);
  });

  test("rechecks row authorization in transaction and publishes downstream live results only after commit", async () => {
    await call("setListSharing", { listId: careList, visibility: "public", allowArborUserEdits: false }, "revoke-community-edits");
    await expect(call("renameList", { listId: careList, name: "Unauthorized race" }, "race-rename", bo))
      .rejects.toBeInstanceOf(MutationCallError);

    const authored = database("./data");
    const currentName = query.one(authored.relations.lists!, (list: any) => ({
      where: list.id.eq(listeningList),
      select: list.pick("id", "name"),
    }));
    const reader = live.stream([{ id: "list", handle: currentName }], { signal: new AbortController().signal, user: null }).getReader();
    await next(reader, "result");
    await next(reader, "ready");
    const receipt = await call("renameList", { listId: listeningList, name: "Live committed name" }, "live-rename", bo);
    const result = await next(reader, "result") as Extract<QueryStreamEvent, { value: unknown }>;
    expect(result.value).toEqual({ id: listeningList, name: "Live committed name" });
    expect(Number(result.observedThrough.slice("query:".length))).toBeGreaterThan(0);
    expect(receipt.observedThrough).toMatch(/^sqlite:\d+$/);
    await reader.cancel();
  });

  test("reserved runtime tables stay outside the authored schema after restart", async () => {
    const reopened = {
      directory,
      databasePath,
      schemaPath: join(directory, "schema.sql"),
      relationshipsPath: join(directory, "relationships.json"),
    };
    const nextEngine = await SQLiteQueryEngine.open(reopened, { async resolve() { return { rows: [], dependencies: [] }; } });
    expect(nextEngine.schema.relations.__arbor_mutation_receipts).toBeUndefined();
    await nextEngine[Symbol.asyncDispose]();
  });

  test("allocates durable cursors atomically across store brokers", async () => {
    const otherStore = new SQLiteStoreBroker(databasePath, engine.schema, { watchExternal: false });
    try {
      const first = await store.transactionAsync((_database, control) => control.reserveCursor());
      const second = await otherStore.transactionAsync((_database, control) => control.reserveCursor());
      expect(Number(second.result.slice("sqlite:".length))).toBe(Number(first.result.slice("sqlite:".length)) + 1);
      expect(second.observedThrough).toBe(second.result);
    } finally {
      await otherStore[Symbol.asyncDispose]();
    }
  });
});
