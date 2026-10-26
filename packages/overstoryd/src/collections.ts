// The host's own projection of its trees' collections (Schema language 005
// milestone 6): one SQLite file per collection, in its schema's database
// layout, derived from accepted state. Named queries read it; named mutations
// compute against it and submit what they change as an ordinary update. The
// files are a cache: never backed up, retained or audited. Deleting one only
// means the next use rebuilds it, and nothing in it changes what a root means.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  logicalRowKey,
  sha256,
  stableJSONString,
  stableKeyFromProperties,
  type AcceptedUpdate,
  type JSONValue,
  type LogicalRow,
  type MutationCallRequest,
  type MutationCallRuntime,
  type MutationHandleRef,
  type MutationResultReceipt,
  type ObjectHash,
  type ProtocolDirectory,
  type QueryHandleRef,
  type QueryStreamEvent,
  type QueryStreamRequest,
  type QueryStreamRuntime,
} from "@ovst/protocol";
import {
  deriveRowOperations,
  encodeCollection,
  loadDirectoryCollection,
  sharedCollectionSchemaCache,
  sqliteRow,
  toSQLite,
  type CollectionSchema,
  type LogicalSchema,
} from "@ovst/collection-schema";
import { layoutOf, logicalFromRows, rowsFromLogical, setupSql, type LogicalTables, type RowsByTable, type Table } from "@ovst/usl";
import {
  LiveQueryBroker,
  MutationCallError,
  SQLiteMutationBroker,
  SQLiteQueryEngine,
  SQLiteStoreBroker,
  type MountedQuery,
  type MutationHandle,
  type OverstoryUser,
  type ProfileResolver,
  type QueryHandle,
  type ResolvedStorySource,
  type SQLiteRowChange,
} from "@ovst/apps-runtime";
import type { HostDaemon, UpdateCaller } from "./overstoryd.ts";

type Row = Record<string, JSONValue>;
type Read = (hash: ObjectHash) => Promise<Uint8Array>;

const DATABASE = "_store.sqlite3";
/** The materialization's own record, which the query engine's introspection ignores (`__arbor_*`). */
const META = "__arbor_materialized";
/** How many times a mutation recomputes when the tree moves under it. */
const MUTATION_ATTEMPTS = 3;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The directories from `root` to the one at `path`, each with the entry name that leads on. */
async function locate(read: Read, root: ObjectHash, path: string): Promise<Array<{ directory: ProtocolDirectory; name?: string }> | null> {
  const names = path.split("/").filter(Boolean);
  const spine: Array<{ directory: ProtocolDirectory; name?: string }> = [{ directory: decodeProtocolDirectory(await read(root)) }];
  for (const name of names) {
    const entry = spine.at(-1)!.directory.entries.find((candidate) => candidate.name === name);
    if (!entry?.directory) return null;
    spine.at(-1)!.name = name;
    spine.push({ directory: decodeProtocolDirectory(await read(entry.directory)) });
  }
  return spine;
}

/** A root whose directory at the end of `spine` is `directory`, with every object it adds. */
function replaceAt(spine: ReadonlyArray<{ directory: ProtocolDirectory; name?: string }>, directory: ProtocolDirectory): { root: ObjectHash; objects: Map<ObjectHash, Uint8Array> } {
  const objects = new Map<ObjectHash, Uint8Array>();
  const put = (value: ProtocolDirectory) => {
    const bytes = encodeProtocolDirectory(value);
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  let hash = put(directory);
  for (let index = spine.length - 2; index >= 0; index--) {
    const { directory: parent, name } = spine[index]!;
    hash = put({ ...parent, entries: parent.entries.map((entry) => entry.name === name ? { name: entry.name, directory: hash } : entry) });
  }
  return { root: hash, objects };
}

const schemaEntry = (directory: ProtocolDirectory) => directory.entries.find((entry) => entry.name === "schema.usl")?.file;

/**
 * Times for rows a mutation produced: an unchanged row keeps its times, a
 * changed one keeps `created` and is modified at the mutation's time, and a
 * new one is created then. Row times come from operations (spec 10 §4.1),
 * never from what a handler wrote.
 */
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

/** The rows of the database layout by table and stable key. */
function keyed(schemas: readonly CollectionSchema[], rows: RowsByTable): Map<string, Map<string, Row>> {
  return new Map(schemas.map((schema) => [schema.model, new Map((rows[schema.model] ?? [])
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== null)) as Row)
    .map((row) => [stableKeyFromProperties(schema.primaryKey, row)!, row]))]));
}

/** Where a materialization stands: the accepted update it reflects, its schema file and its collection reference. */
interface Applied {
  update: AcceptedUpdate;
  schema: ObjectHash;
  collection: string;
}

/** One collection's materialization: its file, the query engine and live broker over it, and its mutation runner. */
export class MaterializedCollection implements AsyncDisposable {
  private constructor(
    readonly tree: string,
    readonly path: string,
    readonly databasePath: string,
    readonly logical: LogicalSchema,
    readonly layout: Table[],
    readonly schemas: readonly CollectionSchema[],
    readonly engine: SQLiteQueryEngine,
    readonly store: SQLiteStoreBroker,
    readonly live: LiveQueryBroker,
    readonly mutations: SQLiteMutationBroker,
    private current: Applied,
  ) {}

  static async open(tree: string, path: string, directory: string, applied: Applied, profiles: ProfileResolver, now?: () => Date): Promise<MaterializedCollection> {
    const schemaBytes = await Bun.file(join(directory, "schema.usl")).bytes();
    const logical = sharedCollectionSchemaCache.compileLogical(schemaBytes);
    const layout = layoutOf(logical.result, { store: "database" });
    const schemas = sharedCollectionSchemaCache.compileTables(schemaBytes, "database").tables;
    const databasePath = join(directory, DATABASE);
    const engine = await SQLiteQueryEngine.open({ directory, databasePath, schemaPath: join(directory, "schema.usl"), tree, path }, profiles);
    const store = new SQLiteStoreBroker(databasePath, engine.schema, { watchExternal: false });
    const live = new LiveQueryBroker(engine, store);
    const mutations = new SQLiteMutationBroker(engine.schema, store, { tree, path }, now ? { now } : {});
    return new MaterializedCollection(tree, path, databasePath, logical, layout, schemas, engine, store, live, mutations, applied);
  }

  /** The accepted update the file reflects. */
  get applied(): AcceptedUpdate { return this.current.update; }

  /** The bindings of a `node()` root authored as `authoredRoot` to this collection and each of its tables. */
  sources(authoredRoot: string): ResolvedStorySource[] {
    const schemaFingerprint = this.engine.schema.fingerprint;
    const prefix = this.path === "/" ? "" : this.path;
    return [
      { authoredPath: authoredRoot, tree: this.tree, path: this.path, schemaFingerprint },
      ...Object.values(this.engine.schema.relations).filter((relation) => relation.source === "sqlite").map((relation) => ({
        authoredPath: `${authoredRoot}/${relation.name}`, tree: this.tree, path: `${prefix}/${relation.name}`, schemaFingerprint,
      })),
    ];
  }

  /**
   * Bring the file to `head`: unchanged collections only advance the record;
   * changed ones are diffed row by row and applied with it in one
   * transaction, so live queries see the changed rows. False when the file
   * can't follow (a new schema, or the collection gone) and must be rebuilt.
   */
  async catchUp(head: AcceptedUpdate, read: Read, retained: (id: string) => AcceptedUpdate | null): Promise<boolean> {
    if (head.id === this.current.update.id) return true;
    const spine = await locate(read, head.root, this.path);
    const directory = spine?.at(-1)?.directory;
    if (!directory?.collection || schemaEntry(directory) !== this.current.schema) return false;
    const collection = stableJSONString(directory.collection);
    const writes: Array<{ schema: CollectionSchema; remove: Row[]; insert: Row[]; update: Row[] }> = [];
    if (collection !== this.current.collection) {
      const was = retained(this.current.update.id);
      const before = was && await locate(read, was.root, this.path);
      if (!before) return false;
      const rows = async (at: ProtocolDirectory) => keyed(this.schemas, rowsFromLogical(this.logical.result, this.layout, (await loadDirectoryCollection(at, read))!.tables));
      const [from, to] = [await rows(before.at(-1)!.directory), await rows(directory)];
      for (const schema of this.schemas) {
        const left = from.get(schema.model)!, right = to.get(schema.model)!;
        const write = { schema, remove: [] as Row[], insert: [] as Row[], update: [] as Row[] };
        for (const [key, row] of left) if (!right.has(key)) write.remove.push(row);
        for (const [key, row] of right) {
          const prior = left.get(key);
          if (!prior) write.insert.push(row);
          else if (stableJSONString(prior) !== stableJSONString(row)) write.update.push(row);
        }
        if (write.remove.length || write.insert.length || write.update.length) writes.push(write);
      }
    }
    const next: Applied = { update: head, schema: this.current.schema, collection };
    await this.store.transactionAsync((database) => {
      database.exec("pragma defer_foreign_keys = on");
      for (const { schema, remove, insert, update } of writes) {
        const where = schema.primaryKey.map((column) => `${quote(column)} = ?`).join(" and ");
        const key = (row: Row) => schema.primaryKey.map((column) => toSQLite(row[column]));
        const values = (row: Row) => schema.columns.map((column) => toSQLite(row[column]));
        const removing = database.prepare(`delete from ${quote(schema.model)} where ${where}`);
        const inserting = database.prepare(`insert into ${quote(schema.model)} (${schema.columns.map(quote).join(", ")}) values (${schema.columns.map(() => "?").join(", ")})`);
        const updating = database.prepare(`update ${quote(schema.model)} set ${schema.columns.map((column) => `${quote(column)} = ?`).join(", ")} where ${where}`);
        for (const row of remove) removing.run(...key(row));
        for (const row of insert) inserting.run(...values(row));
        for (const row of update) updating.run(...values(row), ...key(row));
      }
      writeMeta(database, next);
    });
    this.current = next;
    return true;
  }

  /**
   * The root a mutation's row changes make from `base`: the collection's rows
   * there with the changes applied, timed at `now`, in a new collection
   * reference, and the objects it adds.
   */
  async candidate(base: AcceptedUpdate, changes: readonly SQLiteRowChange[], now: string, read: Read): Promise<{ root: ObjectHash; objects: Map<ObjectHash, Uint8Array> }> {
    const spine = (await locate(read, base.root, this.path))!;
    const directory = spine.at(-1)!.directory;
    const collection = (await loadDirectoryCollection(directory, read))!;
    const rows = keyed(this.schemas, rowsFromLogical(this.logical.result, this.layout, collection.tables));
    for (const change of changes) {
      const schema = this.schemas.find((candidate) => candidate.model === change.collection);
      if (!schema) continue;
      const byKey = rows.get(schema.model)!;
      const before = change.before && sqliteRow(schema, change.before);
      const after = change.after && sqliteRow(schema, change.after);
      if (before) byKey.delete(stableKeyFromProperties(schema.primaryKey, before)!);
      if (after) byKey.set(stableKeyFromProperties(schema.primaryKey, after)!, after);
    }
    const changed: RowsByTable = Object.fromEntries([...rows].map(([model, byKey]) => [model, [...byKey.values()]]));
    const tables = stamp(logicalFromRows(this.logical.result, this.layout, changed, { now }), collection.tables, now);
    const encoded = encodeCollection(this.logical, tables);
    const replaced = replaceAt(spine, { ...directory, collection: encoded.reference });
    for (const [hash, bytes] of encoded.objects) replaced.objects.set(hash as ObjectHash, bytes);
    return replaced;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.live.reload("source-changed");
    await this.live[Symbol.asyncDispose]();
    await this.store[Symbol.asyncDispose]();
    await this.engine[Symbol.asyncDispose]();
  }
}

function writeMeta(database: Database, applied: Applied): void {
  const set = database.prepare(`insert into ${META} (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`);
  set.run("update", applied.update.id);
  set.run("schema", applied.schema);
  set.run("collection", applied.collection);
}

function readMeta(path: string): { update: string; schema: string; collection: string } | null {
  if (!existsSync(path)) return null;
  try {
    const database = new Database(path, { readonly: true });
    try {
      const rows = database.query(`select key, value from ${META}`).all() as Array<{ key: string; value: string }>;
      const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      return meta.update && meta.schema && meta.collection ? meta as { update: string; schema: string; collection: string } : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/** A query registered with the host: its handle, the collection it reads, and how its module names that collection. */
export interface HostQueryEntry {
  /** The handle's module, export and version; it serves every tree's request for them. */
  ref: Omit<QueryHandleRef, "tree">;
  handle: QueryHandle<unknown, unknown>;
  /** The collection directory's path in the handle's tree. */
  collection: string;
  /** The `node()` path the handle's module names the collection by, such as `./data`. */
  authoredRoot: string;
}

export interface HostMutationEntry {
  ref: Omit<MutationHandleRef, "tree">;
  handle: MutationHandle<unknown, unknown>;
  collection: string;
  authoredRoot: string;
}

export interface HostCollectionsOptions {
  queries?: readonly HostQueryEntry[];
  mutations?: readonly HostMutationEntry[];
  /** Profile fields for queries that read people; by default the host's profile cards. */
  profiles?: ProfileResolver;
  /** A mutation's logical time; tests fix it. */
  now?: () => Date;
}

/** The context the host's mutate route gives a mutation: the caller the update is submitted as. */
export interface HostMutationContext {
  user: OverstoryUser | null;
  caller?: UpdateCaller;
}

const refKey = (ref: Omit<QueryHandleRef, "tree">) => `${ref.module}\0${ref.export}\0${ref.version}`;

/**
 * The host's collection materializations, at `<dataRoot>/materialized/<tree>/<path>/`.
 * Each is built on first use, caught up after every accepted update to its
 * tree, and caught up again before a mutation computes against it.
 */
export class HostCollections implements AsyncDisposable {
  private readonly open = new Map<string, MaterializedCollection>();
  private readonly turns = new Map<string, Promise<unknown>>();
  private readonly receipts: Database;
  private readonly stopAccepted: () => void;
  private readonly queries = new Map<string, HostQueryEntry>();
  private readonly mutationEntries = new Map<string, HostMutationEntry>();

  constructor(readonly daemon: HostDaemon, readonly dataRoot: string, private readonly options: HostCollectionsOptions = {}) {
    for (const entry of options.queries ?? []) this.queries.set(refKey(entry.ref), entry);
    for (const entry of options.mutations ?? []) this.mutationEntries.set(refKey(entry.ref), entry);
    // Receipts are durable, unlike the materializations: a retry after the
    // response was lost returns the original result.
    this.receipts = new Database(join(dataRoot, "mutation-receipts.sqlite3"), { create: true, strict: true });
    this.receipts.exec("pragma journal_mode = wal");
    this.receipts.exec("create table if not exists receipts (tree text not null, subject text not null, mutation_id text not null, request_digest text not null, update_id text, observed_through text not null, result_json text not null, primary key (tree, subject, mutation_id))");
    // A mutation's result, written before its update is submitted, so a retry after a stop between acceptance and receipt is answered.
    this.receipts.exec("create table if not exists pending_receipts (tree text not null, subject text not null, mutation_id text not null, request_digest text not null, change text not null, result_json text not null, primary key (tree, subject, mutation_id))");
    this.stopAccepted = daemon.subscribeAccepted((update) => {
      for (const collection of this.open.values()) {
        if (collection.tree !== update.tree) continue;
        void this.current(collection.tree, collection.path).catch((error) => console.error("overstoryd collection catch-up failed", error));
      }
    });
  }

  private readonly read: Read = (hash) => this.daemon.object(hash);

  private directoryOf(tree: string, path: string): string {
    return join(this.dataRoot, "materialized", tree, encodeURIComponent(path));
  }

  /** Run `work` as the only change to one collection's materialization. */
  private turn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.turns.set(key, next);
    return next.finally(() => { if (this.turns.get(key) === next) this.turns.delete(key); });
  }

  /** The collection at `path` in `tree`, caught up to the tree's accepted head. */
  current(tree: string, path: string): Promise<MaterializedCollection> {
    const key = `${tree}\0${path}`;
    return this.turn(key, async () => {
      const head = this.daemon.currentUpdate(tree);
      if (!head) throw new MutationCallError({ code: "not-found", message: "The tree has no accepted state", retryable: false });
      const existing = this.open.get(key);
      if (existing && await existing.catchUp(head, this.read, (id) => this.daemon.update(id))) return existing;
      if (existing) {
        this.open.delete(key);
        await existing[Symbol.asyncDispose]();
      }
      const opened = await this.materialize(tree, path, head);
      this.open.set(key, opened);
      return opened;
    });
  }

  /** Open the file left from before when it can catch up, or build it from the accepted rows at `head`. */
  private async materialize(tree: string, path: string, head: AcceptedUpdate): Promise<MaterializedCollection> {
    const directory = this.directoryOf(tree, path);
    const spine = await locate(this.read, head.root, path);
    const located = spine?.at(-1)?.directory;
    const schema = located && schemaEntry(located);
    if (!located?.collection || !schema) throw new MutationCallError({ code: "not-found", message: `${path} is not a collection`, retryable: false });
    const profiles = this.options.profiles ?? this.profileCards();
    const meta = readMeta(join(directory, DATABASE));
    const left = meta?.schema === schema ? this.daemon.update(meta.update) : null;
    if (meta && left && left.tree === tree) {
      const reopened = await MaterializedCollection.open(tree, path, directory, { update: left, schema, collection: meta.collection }, profiles, this.options.now);
      if (await reopened.catchUp(head, this.read, (id) => this.daemon.update(id))) return reopened;
      await reopened[Symbol.asyncDispose]();
    }
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const schemaBytes = await this.read(schema);
    await writeFile(join(directory, "schema.usl"), schemaBytes);
    const logical = sharedCollectionSchemaCache.compileLogical(schemaBytes);
    const layout = layoutOf(logical.result, { store: "database" });
    const schemas = sharedCollectionSchemaCache.compileTables(schemaBytes, "database").tables;
    const rows = keyed(schemas, rowsFromLogical(logical.result, layout, (await loadDirectoryCollection(located, this.read))!.tables));
    const applied: Applied = { update: head, schema, collection: stableJSONString(located.collection) };
    const database = new Database(join(directory, DATABASE), { create: true, strict: true });
    try {
      database.exec(setupSql(layout, "sqlite"));
      database.exec(`create table ${META} (key text primary key, value text not null)`);
      database.transaction(() => {
        for (const schema of schemas) {
          const insert = database.prepare(`insert into ${quote(schema.model)} (${schema.columns.map(quote).join(", ")}) values (${schema.columns.map(() => "?").join(", ")})`);
          for (const row of rows.get(schema.model)!.values()) insert.run(...schema.columns.map((column) => toSQLite(row[column])));
        }
        writeMeta(database, applied);
      })();
    } finally {
      database.close();
    }
    return MaterializedCollection.open(tree, path, directory, applied, profiles, this.options.now);
  }

  /** People as the host's profile cards describe them. */
  private profileCards(): ProfileResolver {
    return {
      resolve: async (ids, fields) => {
        const rows = ids.filter((id) => this.daemon.get(id)).map((id) => {
          const card = this.daemon.profileCard(id);
          const handle = this.daemon.handleForProfile(id) ?? id;
          const person: Record<string, unknown> = { id, name: card.displayName ?? handle, handle, portrait: null, bio: card.description ?? null };
          return Object.fromEntries(fields.map((field) => [field, person[field] ?? null]));
        });
        return { rows, dependencies: rows.map((row) => ({ profile: String(row.id ?? ""), tree: String(row.id ?? ""), ref: this.daemon.currentUpdate(String(row.id ?? ""))?.root ?? "" })) };
      },
    };
  }

  /** The query runtime the host's `/queries` route serves. */
  queryRuntime(): QueryStreamRuntime {
    return {
      stream: async (request: QueryStreamRequest, context): Promise<ReadableStream<QueryStreamEvent>> => {
        const entries = request.queries.map((mount) => {
          const entry = this.queries.get(refKey(mount.handle));
          if (!entry) throw new Error("A mounted query handle or version is not active");
          return { mount, entry };
        });
        const collections = new Set(entries.map(({ entry }) => entry.collection));
        if (collections.size !== 1) throw new Error("A query stream reads one collection");
        const collection = await this.current(request.document.tree, [...collections][0]!);
        const ids = new Set<string>();
        const mounts = entries.map(({ mount, entry }): MountedQuery => {
          if (!mount.id || ids.has(mount.id)) throw new Error("Mounted query ids must be non-empty and unique");
          ids.add(mount.id);
          const source = collection.sources(entry.authoredRoot).find((candidate) => candidate.authoredPath === entry.handle.source.path);
          if (!source) throw new Error("The query's node() source is not in its collection");
          collection.live.bind(entry.handle, source);
          return { id: mount.id, tree: mount.handle.tree, handle: entry.handle, input: mount.input, knownOutputHash: mount.knownOutputHash };
        });
        return collection.live.stream(mounts, context);
      },
    };
  }

  /** The mutation runtime the host's `/mutate` route serves. */
  mutationRuntime(): MutationCallRuntime {
    return { call: (request, context) => this.mutate(request, context as HostMutationContext) };
  }

  /**
   * Run a named mutation (07 §5): compute against the materialization at the
   * tree's head U, roll back, and submit the row changes as one update whose
   * change identity comes from the request digest, guarded on U with
   * `ifCurrent`. A tree that moved meanwhile catches up and reruns. The
   * receipt names the accepted update, and an exact retry returns it.
   */
  async mutate(request: MutationCallRequest, context: HostMutationContext): Promise<MutationResultReceipt> {
    const entry = this.mutationEntries.get(refKey(request.handle));
    if (!entry) throw new MutationCallError({ code: "not-found", message: "The mutation handle or version is not active", retryable: false });
    if (!context.caller) throw new MutationCallError({ code: "permission-denied", message: "A mutation needs a caller who can write the tree", retryable: false });
    const tree = request.handle.tree;
    const subject = context.user?.profile ?? "anonymous";
    for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt++) {
      const collection = await this.current(tree, entry.collection);
      const base = collection.applied;
      const call = { scope: tree, handle: request.handle, mutationID: request.mutationID, input: request.input, user: context.user, sources: collection.sources(entry.authoredRoot) };
      const prepared = await collection.mutations.prepare(entry.handle, call);
      const stored = this.receipts.query("select request_digest, update_id, observed_through, result_json from receipts where tree = ? and subject = ? and mutation_id = ?")
        .get(tree, subject, request.mutationID) as { request_digest: string; observed_through: string; result_json: string } | null;
      if (stored) {
        if (stored.request_digest !== prepared.requestDigest) {
          throw new MutationCallError({ code: "conflict", message: "The mutation identity was already used for different intent", retryable: false });
        }
        return { mutationID: request.mutationID, requestDigest: prepared.requestDigest, observedThrough: stored.observed_through, result: JSON.parse(stored.result_json) };
      }
      const change = `mutation-${sha256(`${tree}\0${subject}\0${request.mutationID}\0${prepared.requestDigest}`).slice(0, 32)}`;
      const pending = this.receipts.query("select request_digest, result_json from pending_receipts where tree = ? and subject = ? and mutation_id = ?")
        .get(tree, subject, request.mutationID) as { request_digest: string; result_json: string } | null;
      if (pending) {
        if (pending.request_digest !== prepared.requestDigest) {
          throw new MutationCallError({ code: "conflict", message: "The mutation identity was already used for different intent", retryable: false });
        }
        // The host stopped after submitting: the update that carries the change answers the retry.
        const landed = this.daemon.acceptedChange(tree, change);
        if (landed) {
          await this.current(tree, entry.collection);
          return this.settleReceipt(tree, subject, request.mutationID, prepared.requestDigest, landed, JSON.parse(pending.result_json));
        }
      }
      const trial = await collection.mutations.trial(entry.handle, call, prepared);
      if (collection.applied.id !== base.id) continue;
      let accepted: string | null = null;
      if (trial.changes.length) {
        const candidate = await collection.candidate(base, trial.changes, trial.mutationNow, this.read);
        const read: Read = async (hash) => candidate.objects.get(hash) ?? this.read(hash);
        const operations = await deriveRowOperations(base.root, candidate.root, read);
        if (!operations) throw new MutationCallError({ code: "internal-error", message: "The mutation's changes can't be stated as row operations", retryable: false });
        this.receipts.query("insert or replace into pending_receipts (tree, subject, mutation_id, request_digest, change, result_json) values (?, ?, ?, ?, ?, ?)")
          .run(tree, subject, request.mutationID, prepared.requestDigest, change, JSON.stringify(trial.result ?? null));
        const response = await this.daemon.submitUpdate(tree, {
          base: base.id,
          updates: [{
            change,
            candidate: candidate.root,
            ifCurrent: base.id,
            trace: [{ before: base.root, after: candidate.root, operations }],
            resolves: [],
            deltas: [],
            objects: [...candidate.objects].map(([hash, bytes]) => ({ hash, bytes })),
          }],
        }, context.caller);
        if (response.status === 409) continue;
        if (!("results" in response.result)) throw new MutationCallError({ code: "conflict", message: response.result.message, retryable: true });
        accepted = response.result.results.at(-1)!.update.id;
        await this.current(tree, entry.collection);
      }
      return this.settleReceipt(tree, subject, request.mutationID, prepared.requestDigest, accepted, trial.result);
    }
    throw new MutationCallError({ code: "conflict", message: "The tree kept changing while the mutation ran", retryable: true });
  }

  /** Record a mutation's receipt in place of its pending result, and return it. */
  private settleReceipt(tree: string, subject: string, mutationID: string, requestDigest: MutationResultReceipt["requestDigest"], update: string | null, result: unknown): MutationResultReceipt {
    const receipt: MutationResultReceipt = { mutationID, requestDigest, observedThrough: this.daemon.observedThrough(tree), result };
    this.receipts.transaction(() => {
      this.receipts.query("insert into receipts (tree, subject, mutation_id, request_digest, update_id, observed_through, result_json) values (?, ?, ?, ?, ?, ?, ?)")
        .run(tree, subject, mutationID, requestDigest, update, receipt.observedThrough, JSON.stringify(result ?? null));
      this.receipts.query("delete from pending_receipts where tree = ? and subject = ? and mutation_id = ?").run(tree, subject, mutationID);
    })();
    return receipt;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stopAccepted();
    await Promise.allSettled([...this.turns.values()]);
    for (const collection of this.open.values()) await collection[Symbol.asyncDispose]();
    this.open.clear();
    this.receipts.close();
  }
}
