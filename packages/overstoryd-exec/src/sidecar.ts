// overstoryd's execution sidecar (Apps 005 step 4): it runs named queries and
// mutations for overstoryd, which keeps the materializations and holds the
// clients' streams. A query reads a materialization and answers a value. A
// mutation runs in a transaction on one that always rolls back, and its row
// changes are committed as a guarded, row-only update through the standard
// API, with the receipt kept here. People's profile cards are read through the
// same API. Nothing here is overstoryd's: its files are only read, and its API
// is used like any client's.

import { AsyncLocalStorage } from "node:async_hooks";
import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  decodeProtocolDirectory,
  HANDLE_PATH,
  logicalRowKey,
  outputHash,
  ProtocolClient,
  ProtocolHTTPError,
  ProtocolUpdateConflict,
  readRootProfile,
  sha256,
  stableJSONString,
  stableKeyFromProperties,
  type DerivableUpdateRequest,
  type JSONValue,
  type LogicalRow,
  type MutationResultReceipt,
  type ObjectHash,
  type RowOperation,
} from "@ovst/protocol";
import {
  MutationCallError,
  SQLiteMutationBroker,
  SQLiteQueryEngine,
  SQLiteStoreBroker,
  type MutationHandle,
  type ProfileResolver,
  type QueryHandle,
  type ResolvedStorySource,
  type SQLiteRowChange,
} from "@ovst/apps-runtime";
import { rowOperationsBetween, sharedCollectionSchemaCache, sqliteRow, type CollectionSchema, type LogicalSchema } from "@ovst/collection-schema";
import { layoutOf, logicalFromRows, type LogicalTables, type RowsByTable, type Table } from "@ovst/usl";
import {
  EXEC_PROTOCOL_VERSION,
  type ExecAnswer,
  type ExecCollection,
  type ExecHandleRef,
  type ExecMutationAnswer,
  type ExecMutationQuestion,
  type ExecQueryAnswer,
  type ExecQueryQuestion,
  type ExecQuestion,
  type ExecReady,
} from "@ovst/exec-protocol";

type Row = Record<string, JSONValue>;

/** A handle the sidecar runs: its name, and the collection its code reads. */
export interface ExecEntry<Handle> {
  ref: ExecHandleRef;
  handle: Handle;
  /** The collection directory's path in the handle's tree. */
  collection: string;
  /** The `node()` path the handle's module names the collection by, such as `./data`. */
  authoredRoot: string;
}

export interface ExecSidecarOptions {
  /** overstoryd's materialization directory. */
  materialized: string;
  /** The sidecar's own durable directory: the mutation receipts. */
  state: string;
  /** The host's standard API. */
  origin: string;
  queries?: readonly ExecEntry<QueryHandle<unknown, unknown>>[];
  mutations?: readonly ExecEntry<MutationHandle<unknown, unknown>>[];
}

/** How many times the same changes are resubmitted on a newer head that left their collection as it was. */
const MUTATION_REBASES = 16;
/** The materialization's own record (overstoryd's), which names the update it reflects. */
const META = "__arbor_materialized";

const refKey = (ref: ExecHandleRef) => `${ref.module}\0${ref.export}\0${ref.version}`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** How many profile objects are kept: they are named by hash, so a kept one never goes stale. */
const PROFILE_OBJECTS = 2048;

/** The host's API failed while a query read a profile: the question can be asked again. */
class ProfileReadFailure extends Error {}

/** The update a materialization reflects, or null when it has no record. */
function reflected(path: string): string | null {
  try {
    const database = new Database(path, { readonly: true });
    try {
      return (database.query(`select value from ${META} where key = 'update'`).get() as { value: string } | null)?.value ?? null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/** Times for rows a mutation produced: unchanged rows keep theirs, changed ones are modified at `now`, new ones created then (spec 10 §4.1). */
function stamp(after: LogicalTables, before: LogicalTables, now: string): LogicalTables {
  const out: LogicalTables = {};
  for (const [model, rows] of Object.entries(after)) {
    const prior = new Map((before[model] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow]));
    out[model] = rows.map((row) => {
      const was = prior.get(logicalRowKey(row));
      if (!was) return { ...row, created: now, modified: now };
      if (stableJSONString(was.fields) === stableJSONString(row.fields)) return { ...row, created: was.created, modified: was.modified };
      return { ...row, created: was.created, modified: now };
    });
  }
  return out;
}

/** One materialization as the sidecar uses it: its query engine and compiled schema, for one file and schema. */
interface Opened {
  file: string;
  identity: string;
  engine: SQLiteQueryEngine;
  logical: LogicalSchema;
  layout: Table[];
  schemas: readonly CollectionSchema[];
}

export class ExecSidecar implements AsyncDisposable {
  private readonly queries = new Map<string, ExecEntry<QueryHandle<unknown, unknown>>>();
  private readonly mutationEntries = new Map<string, ExecEntry<MutationHandle<unknown, unknown>>>();
  private readonly opened = new Map<string, Opened>();
  private readonly turns = new Map<string, Promise<unknown>>();
  private readonly receipts: Database;
  /** The current question's API client, for the engines' shared profile resolver. */
  private readonly asked = new AsyncLocalStorage<ProtocolClient>();
  /** Profile roots' directory and `_index.md` objects, by hash. */
  private readonly profileObjects = new Map<string, Uint8Array>();

  constructor(private readonly options: ExecSidecarOptions) {
    for (const entry of options.queries ?? []) this.queries.set(refKey(entry.ref), entry);
    for (const entry of options.mutations ?? []) this.mutationEntries.set(refKey(entry.ref), entry);
    this.receipts = new Database(join(options.state, "mutation-receipts.sqlite3"), { create: true, strict: true });
    this.receipts.exec("pragma journal_mode = wal");
    this.receipts.exec("create table if not exists receipts (tree text not null, subject text not null, mutation_id text not null, request_digest text not null, observed_through text not null, result_json text not null, primary key (tree, subject, mutation_id))");
    // Written before the update is submitted, so a retry after a stop between acceptance and receipt resubmits the same request.
    this.receipts.exec("create table if not exists pending_receipts (tree text not null, subject text not null, mutation_id text not null, request_digest text not null, request_json text not null, result_json text not null, primary key (tree, subject, mutation_id))");
  }

  /** The handshake: what this sidecar can run. */
  ready(): ExecReady {
    const list = (entries: Iterable<ExecEntry<unknown>>) => [...entries].map((entry) => ({ ...entry.ref, collection: entry.collection, authored: entry.authoredRoot }));
    return { ready: { version: EXEC_PROTOCOL_VERSION, queries: list(this.queries.values()), mutations: list(this.mutationEntries.values()) } };
  }

  async answer(question: ExecQuestion): Promise<ExecAnswer> {
    try {
      return question.kind === "query" ? await this.query(question) : await this.mutate(question);
    } catch (error) {
      console.error("overstoryd-exec question failed", error);
      return { id: question.id, error: { message: "The question could not be answered" } };
    }
  }

  /**
   * People's card fields, read through the standard API with the question's
   * token: each profile tree's descriptor names its root, and the root's
   * `_index.md` declares the card. A tree the token cannot read, or one that
   * declares no profile type, is no person here.
   */
  private readonly profiles: ProfileResolver = {
    resolve: async (ids, fields) => {
      const client = this.asked.getStore();
      if (!client) throw new Error("Profiles were read outside a question");
      const rows: Record<string, unknown>[] = [], dependencies: Array<{ profile: string; tree: string; ref: string }> = [];
      for (const id of ids) {
        const card = await this.profileCard(client, id);
        if (!card) continue;
        rows.push(Object.fromEntries(fields.map((field) => [field, card.person[field] ?? null])));
        dependencies.push({ profile: id, tree: id, ref: card.root });
      }
      return { rows, dependencies };
    },
  };

  private async profileCard(client: ProtocolClient, id: string): Promise<{ person: Record<string, unknown>; root: string } | null> {
    let current;
    try {
      current = await client.descriptor(id);
    } catch (error) {
      if (error instanceof ProtocolHTTPError && (error.status === 404 || error.status === 403 || error.status === 400)) return null;
      throw new ProfileReadFailure(error instanceof Error ? error.message : String(error));
    }
    const { root } = current.tree;
    const load = async (hash: ObjectHash): Promise<Uint8Array> => {
      const kept = this.profileObjects.get(hash);
      if (kept) return kept;
      let bytes;
      try {
        bytes = await client.object(id as never, hash);
      } catch (error) {
        throw new ProfileReadFailure(error instanceof Error ? error.message : String(error));
      }
      if (this.profileObjects.size >= PROFILE_OBJECTS) this.profileObjects.delete(this.profileObjects.keys().next().value!);
      this.profileObjects.set(hash, bytes);
      return bytes;
    };
    const { facts } = await readRootProfile(root, load, { avatar: false });
    if (!facts.type) return null;
    const handle = (current.tree.canonical && HANDLE_PATH.exec(current.tree.canonical.path)?.[1]) ?? id;
    return { person: { id, name: facts.displayName ?? handle, handle, portrait: null, bio: facts.description ?? null }, root };
  }

  /** The materialization a question names, opened for its current file and schema. */
  private async open(collection: ExecCollection): Promise<Opened> {
    const file = join(this.options.materialized, collection.file);
    const directory = dirname(file);
    const [database, schema] = await Promise.all([stat(file), stat(join(directory, "schema.usl"))]);
    // A rebuilt file is a new file: its engine and schema are opened again.
    const identity = `${database.ino}\0${schema.ino}\0${schema.mtimeMs}`;
    const existing = this.opened.get(file);
    if (existing?.identity === identity) return existing;
    if (existing) await existing.engine[Symbol.asyncDispose]();
    const schemaBytes = await Bun.file(join(directory, "schema.usl")).bytes();
    const logical = sharedCollectionSchemaCache.compileLogical(schemaBytes);
    const opened: Opened = {
      file,
      identity,
      engine: await SQLiteQueryEngine.open({ directory, databasePath: file, schemaPath: join(directory, "schema.usl"), tree: collection.tree, path: collection.path }, this.profiles),
      logical,
      layout: layoutOf(logical.result, { store: "database" }),
      schemas: sharedCollectionSchemaCache.compileTables(schemaBytes, "database").tables,
    };
    this.opened.set(file, opened);
    return opened;
  }

  /** The bindings of a `node()` root authored as `authoredRoot` to the collection and each of its tables. */
  private sources(opened: Opened, collection: ExecCollection, authoredRoot: string): ResolvedStorySource[] {
    const schemaFingerprint = opened.engine.schema.fingerprint;
    const prefix = collection.path === "/" ? "" : collection.path;
    return [
      { authoredPath: authoredRoot, tree: collection.tree, path: collection.path, schemaFingerprint },
      ...Object.values(opened.engine.schema.relations).filter((relation) => relation.source === "sqlite").map((relation) => ({
        authoredPath: `${authoredRoot}/${relation.name}`, tree: collection.tree, path: `${prefix}/${relation.name}`, schemaFingerprint,
      })),
    ];
  }

  private async query(question: ExecQueryQuestion): Promise<ExecQueryAnswer> {
    const { id } = question;
    const entry = this.queries.get(refKey(question.query));
    if (!entry) return { id, refusal: { code: "not-found", message: "A mounted query handle or version is not active", retryable: false } };
    const collection = question.collections.find((candidate) => candidate.authored === entry.authoredRoot);
    if (!collection) return { id, refusal: { code: "invalid-request", message: "The query's collection was not given", retryable: false } };
    const opened = await this.open(collection);
    if (reflected(opened.file) !== collection.update) return { id, stale: true };
    const source = this.sources(opened, collection, entry.authoredRoot).find((candidate) => candidate.authoredPath === entry.handle.source.path);
    if (!source) return { id, refusal: { code: "invalid-request", message: "The query's node() source is not in its collection", retryable: false } };
    opened.engine.bind(entry.handle, source);
    const client = new ProtocolClient(this.options.origin, question.token, { timeoutMs: 30_000 });
    let execution;
    try {
      execution = await this.asked.run(client, () => opened.engine.execute(entry.handle, { input: question.input, user: question.viewer }));
    } catch (error) {
      if (error instanceof ProfileReadFailure) return { id, error: { message: "A profile could not be read", code: "unavailable" } };
      return { id, refusal: safeQueryError(error) };
    }
    // Caught up while the query ran: what it read may not be the update named.
    if (reflected(opened.file) !== collection.update) return { id, stale: true };
    const reads = {
      collections: [{ tree: collection.tree, path: collection.path }],
      profiles: execution.dependencies.profiles.map(({ profile, tree, ref }) => ({ profile, tree, ref })),
    };
    const hash = outputHash(execution.result);
    if (hash === question.knownOutputHash) return { id, unchanged: true, reads };
    return { id, outputHash: hash, value: execution.result, reads };
  }

  /** Run `work` as the only mutation on one materialization. */
  private turn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.turns.set(key, next);
    return next.finally(() => { if (this.turns.get(key) === next) this.turns.delete(key); });
  }

  /**
   * Run a named mutation (07 §5): an exact retry is answered from its receipt;
   * otherwise the handler runs in a rolled-back transaction on the
   * materialization at the update named, and its row changes are submitted as
   * one derived, row-only update guarded on that update, whose change identity
   * comes from the request digest. The receipt is kept once the host accepts.
   */
  private async mutate(question: ExecMutationQuestion): Promise<ExecMutationAnswer> {
    const { id, tree } = question;
    const entry = this.mutationEntries.get(refKey(question.mutation));
    if (!entry) return { id, refusal: { code: "not-found", message: "The mutation handle or version is not active", retryable: false } };
    const collection = question.collections.find((candidate) => candidate.authored === entry.authoredRoot);
    if (!collection || collection.tree !== tree) return { id, refusal: { code: "invalid-request", message: "The mutation's collection was not given", retryable: false } };
    const opened = await this.open(collection);
    return this.turn(opened.file, async () => {
      const store = new SQLiteStoreBroker(opened.file, opened.engine.schema, { watchExternal: false, trialOnly: true });
      try {
        const broker = new SQLiteMutationBroker(opened.engine.schema, store, { tree, path: collection.path }, { now: () => new Date(question.now) });
        const call = {
          scope: tree,
          handle: { tree, ...question.mutation },
          mutationID: question.mutationID,
          input: question.input,
          user: question.viewer,
          sources: this.sources(opened, collection, entry.authoredRoot),
        };
        const subject = question.viewer?.profile ?? "anonymous";
        const client = new ProtocolClient(this.options.origin, question.token, { timeoutMs: 30_000 });
        let prepared;
        try {
          prepared = await broker.prepare(entry.handle, call);
        } catch (error) {
          return { id, refusal: publicMutationError(error) };
        }
        const conflict = { id, refusal: { code: "conflict", message: "The mutation identity was already used for different intent", retryable: false } };
        const stored = this.receipts.query("select request_digest, observed_through, result_json from receipts where tree = ? and subject = ? and mutation_id = ?")
          .get(tree, subject, question.mutationID) as { request_digest: string; observed_through: string; result_json: string } | null;
        if (stored) {
          if (stored.request_digest !== prepared.requestDigest) return conflict;
          return { id, receipt: { mutationID: question.mutationID, requestDigest: prepared.requestDigest, observedThrough: stored.observed_through, result: JSON.parse(stored.result_json) } };
        }
        const pending = this.receipts.query("select request_digest, request_json, result_json from pending_receipts where tree = ? and subject = ? and mutation_id = ?")
          .get(tree, subject, question.mutationID) as { request_digest: string; request_json: string; result_json: string } | null;
        if (pending) {
          if (pending.request_digest !== prepared.requestDigest) return conflict;
          // Stopped after submitting: the same request again is answered from the host's receipt, or was never accepted.
          const resubmitted = await this.submit(client, tree, collection, JSON.parse(pending.request_json) as DerivableUpdateRequest, subject, question.mutationID);
          if (resubmitted) return { id, receipt: this.settle(tree, subject, question.mutationID, prepared.requestDigest, resubmitted, JSON.parse(pending.result_json)) };
          this.forget(tree, subject, question.mutationID);
        }
        if (reflected(opened.file) !== collection.update) return { id, stale: true };
        let trial;
        try {
          trial = await broker.trial(entry.handle, call, prepared);
        } catch (error) {
          return { id, refusal: publicMutationError(error) };
        }
        // Caught up during the trial: what the handler read may not be the update named.
        if (reflected(opened.file) !== collection.update) return { id, stale: true };
        const operations = trial.changes.length ? this.operations(opened, collection, trial.changes, trial.mutationNow) : [];
        if (operations?.length === 0) {
          const current = await client.descriptor(tree);
          return { id, receipt: this.settle(tree, subject, question.mutationID, prepared.requestDigest, current.observedThrough, trial.result) };
        }
        if (!operations) return { id, refusal: { code: "internal-error", message: "The mutation's changes can't be stated as row operations", retryable: false } };
        const change = `mutation-${sha256(`${tree}\0${subject}\0${question.mutationID}\0${prepared.requestDigest}`).slice(0, 32)}`;
        const request: DerivableUpdateRequest = {
          base: collection.update,
          updates: [{ change, candidate: null, ifCurrent: collection.update, trace: [{ operations }], resolves: [], deltas: [], objects: [] }],
        };
        this.receipts.query("insert or replace into pending_receipts (tree, subject, mutation_id, request_digest, request_json, result_json) values (?, ?, ?, ?, ?, ?)")
          .run(tree, subject, question.mutationID, prepared.requestDigest, JSON.stringify(request), JSON.stringify(trial.result ?? null));
        const observedThrough = await this.submit(client, tree, collection, request, subject, question.mutationID);
        if (!observedThrough) {
          this.forget(tree, subject, question.mutationID);
          return { id, stale: true };
        }
        return { id, receipt: this.settle(tree, subject, question.mutationID, prepared.requestDigest, observedThrough, trial.result) };
      } finally {
        await store[Symbol.asyncDispose]();
      }
    });
  }

  /**
   * The row operations a mutation's changes make to the collection: its rows
   * at the update named, with the changes applied and timed at `now`, compared
   * with the rows as they were.
   */
  private operations(opened: Opened, collection: ExecCollection, changes: readonly SQLiteRowChange[], now: string): RowOperation[] | null {
    const database = new Database(opened.file, { readonly: true, strict: true });
    let rows: Map<string, Map<string, Row>>;
    try {
      rows = new Map(opened.schemas.map((schema) => [schema.model, new Map((database.query(`select ${schema.columns.map(quote).join(", ")} from ${quote(schema.model)}`).all() as Record<string, unknown>[])
        .map((raw) => sqliteRow(schema, raw))
        .map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== null)) as Row)
        .map((row) => [stableKeyFromProperties(schema.primaryKey, row)!, row]))]));
    } finally {
      database.close();
    }
    const tables = (byModel: Map<string, Map<string, Row>>): RowsByTable => Object.fromEntries([...byModel].map(([model, byKey]) => [model, [...byKey.values()]]));
    const before = logicalFromRows(opened.logical.result, opened.layout, tables(rows), { now });
    for (const change of changes) {
      const schema = opened.schemas.find((candidate) => candidate.model === change.collection);
      if (!schema) continue;
      const byKey = rows.get(schema.model)!;
      const was = change.before && sqliteRow(schema, change.before);
      const is = change.after && sqliteRow(schema, change.after);
      if (was) byKey.delete(stableKeyFromProperties(schema.primaryKey, was)!);
      if (is) byKey.set(stableKeyFromProperties(schema.primaryKey, is)!, is);
    }
    const after = stamp(logicalFromRows(opened.logical.result, opened.layout, tables(rows), { now }), before, now);
    const operations = rowOperationsBetween(opened.logical.models, before, after, { material: { kind: "basis", path: collection.path, object: collection.directory as ObjectHash } });
    operations?.forEach((operation, index) => { operation.key = `row-${index + 1}`; });
    return operations;
  }

  /**
   * Submit a mutation's update. A head that moved on without changing the
   * collection takes the same changes again on the new head; any other move
   * is null, and the mutation runs again. The host's receipt answers an exact
   * resubmission. The answer is the response's observation cursor.
   */
  private async submit(client: ProtocolClient, tree: string, collection: ExecCollection, request: DerivableUpdateRequest, subject: string, mutationID: string): Promise<string | null> {
    for (let rebases = 0; rebases <= MUTATION_REBASES; rebases++) {
      try {
        return (await client.submitUpdates(tree, request)).head.observedThrough;
      } catch (error) {
        // A guard the head moved past: refused as a conflict, or as a stale execution guard.
        const stale = error instanceof ProtocolUpdateConflict || (error instanceof ProtocolHTTPError && error.status === 409);
        if (!stale) throw error;
      }
      const head = (await client.descriptor(tree)).tree;
      if (head.update === request.base || await this.directoryAt(client, tree, head.root, collection.path) !== collection.directory) return null;
      request = { base: head.update, updates: request.updates.map((update) => ({ ...update, ifCurrent: head.update })) };
      this.receipts.query("update pending_receipts set request_json = ? where tree = ? and subject = ? and mutation_id = ?").run(JSON.stringify(request), tree, subject, mutationID);
    }
    return null;
  }

  /** The directory object at `path` in `root`, read through the standard API. */
  private async directoryAt(client: ProtocolClient, tree: string, root: string, path: string): Promise<string | null> {
    let hash = root;
    for (const name of path.split("/").filter(Boolean)) {
      const entry = decodeProtocolDirectory(await client.object(tree as never, hash)).entries.find((candidate) => candidate.name === name);
      if (!entry?.directory) return null;
      hash = entry.directory;
    }
    return hash;
  }

  /** Record a mutation's receipt in place of its pending request, and return it. */
  private settle(tree: string, subject: string, mutationID: string, requestDigest: MutationResultReceipt["requestDigest"], observedThrough: string, result: unknown): MutationResultReceipt {
    this.receipts.transaction(() => {
      this.receipts.query("insert into receipts (tree, subject, mutation_id, request_digest, observed_through, result_json) values (?, ?, ?, ?, ?, ?)")
        .run(tree, subject, mutationID, requestDigest, observedThrough, JSON.stringify(result ?? null));
      this.forget(tree, subject, mutationID);
    })();
    return { mutationID, requestDigest, observedThrough, result };
  }

  private forget(tree: string, subject: string, mutationID: string): void {
    this.receipts.query("delete from pending_receipts where tree = ? and subject = ? and mutation_id = ?").run(tree, subject, mutationID);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.allSettled([...this.turns.values()]);
    for (const opened of this.opened.values()) await opened.engine[Symbol.asyncDispose]();
    this.opened.clear();
    this.receipts.close();
  }
}

/** A query's failure as the caller may see it. */
function safeQueryError(error: unknown) {
  const message = error instanceof Error && /input|required|not found|missing/i.test(error.message)
    ? error.message
    : "The query could not be evaluated";
  return { code: "invalid-request", message, retryable: false };
}

/** A mutation's failure as the caller may see it. */
function publicMutationError(error: unknown) {
  if (error instanceof MutationCallError) return { code: error.value.code, message: error.value.message, retryable: error.value.retryable };
  console.error("overstoryd-exec mutation failed", error);
  return { code: "internal-error", message: "The mutation could not be completed", retryable: true };
}
