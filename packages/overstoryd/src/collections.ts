// The host's own projection of its trees' collections (Schema language 005
// milestone 6): one SQLite file per collection, in its schema's database
// layout, derived from accepted state. Its execution sidecar (Apps 005 step 4)
// runs named queries on the files and mutations in rolled-back transactions on
// them; overstoryd keeps the files, holds the clients' query streams and asks
// the sidecar again when a file changes. The files are a cache: never backed
// up, retained or audited. Deleting one only means the next use rebuilds it,
// and nothing in it changes what a root means.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProtocolDirectory,
  liveQueryStream,
  stableJSONString,
  stableKeyFromProperties,
  type AcceptedUpdate,
  type Hash,
  type JSONValue,
  type MutationCallRequest,
  type MutationCallRuntime,
  type MutationResultReceipt,
  type ObjectHash,
  type ProtocolDirectory,
  type QueryStreamEvent,
  type QueryStreamRequest,
  type QueryStreamRuntime,
} from "@ovst/protocol";
import {
  loadDirectoryCollection,
  sharedCollectionSchemaCache,
  toSQLite,
  type CollectionSchema,
  type LogicalSchema,
} from "@ovst/collection-schema";
import { layoutOf, rowsFromLogical, setupSql, type Table } from "@ovst/usl";
import type { ExecCollection, ExecHandle, ExecProfile, ExecPublicError, ExecReads } from "@ovst/exec-protocol";
import { ExecProcess, ExecUnavailableError } from "./exec-process.ts";
import type { HostDaemon, UpdateCaller } from "./overstoryd.ts";

type Row = Record<string, JSONValue>;
type Read = (hash: ObjectHash) => Promise<Uint8Array>;

const DATABASE = "_store.sqlite3";
/** The materialization's own record, which the query engine's introspection ignores (`__arbor_*`). */
const META = "__arbor_materialized";
/** How many times a question is asked again when its collection changes under it. */
const ATTEMPTS = 5;
/** The disk the host's materializations may use before idle ones are evicted. */
const MATERIALIZED_BYTES = 1 << 30;
/** How long a materialization must go unused before it may be evicted. */
const MATERIALIZED_IDLE_MS = 15 * 60_000;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The directories from `root` to the one at `path`, each with the entry name that leads on, and the last one's hash. */
async function locate(read: Read, root: ObjectHash, path: string): Promise<{ spine: Array<{ directory: ProtocolDirectory; name?: string }>; hash: ObjectHash } | null> {
  const names = path.split("/").filter(Boolean);
  const spine: Array<{ directory: ProtocolDirectory; name?: string }> = [{ directory: decodeProtocolDirectory(await read(root)) }];
  let hash = root;
  for (const name of names) {
    const entry = spine.at(-1)!.directory.entries.find((candidate) => candidate.name === name);
    if (!entry?.directory) return null;
    spine.at(-1)!.name = name;
    hash = entry.directory as ObjectHash;
    spine.push({ directory: decodeProtocolDirectory(await read(hash)) });
  }
  return { spine, hash };
}

const schemaEntry = (directory: ProtocolDirectory) => directory.entries.find((entry) => entry.name === "schema.usl")?.file;

/** The rows of the database layout by table and stable key. */
function keyed(schemas: readonly CollectionSchema[], rows: Record<string, Row[]>): Map<string, Map<string, Row>> {
  return new Map(schemas.map((schema) => [schema.model, new Map((rows[schema.model] ?? [])
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== null)) as Row)
    .map((row) => [stableKeyFromProperties(schema.primaryKey, row)!, row]))]));
}

/** Where a materialization stands: the accepted update it reflects, its schema file, its collection reference and directory. */
interface Applied {
  update: AcceptedUpdate;
  schema: ObjectHash;
  collection: string;
  directory: ObjectHash;
}

/** One collection's materialization: its file and overstoryd's own connection to it. */
export class MaterializedCollection implements AsyncDisposable {
  /** Counts the catch-ups that changed the collection's rows or names, so a reader can tell whether what it read still holds. */
  revision = 0;
  private dataVersion: number;

  private constructor(
    readonly tree: string,
    readonly path: string,
    readonly databasePath: string,
    readonly logical: LogicalSchema,
    readonly layout: Table[],
    readonly schemas: readonly CollectionSchema[],
    private readonly database: Database,
    private current: Applied,
  ) {
    this.dataVersion = this.version();
  }

  static async open(tree: string, path: string, directory: string, applied: Applied): Promise<MaterializedCollection> {
    const schemaBytes = await Bun.file(join(directory, "schema.usl")).bytes();
    const logical = sharedCollectionSchemaCache.compileLogical(schemaBytes);
    const layout = layoutOf(logical.result, { store: "database" });
    const schemas = sharedCollectionSchemaCache.compileTables(schemaBytes, "database").tables;
    const databasePath = join(directory, DATABASE);
    const database = new Database(databasePath, { create: false, strict: true });
    database.exec("pragma journal_mode = wal");
    database.exec("pragma busy_timeout = 10000");
    database.exec("pragma foreign_keys = on");
    return new MaterializedCollection(tree, path, databasePath, logical, layout, schemas, database, applied);
  }

  /** The accepted update the file reflects. */
  get applied(): AcceptedUpdate { return this.current.update; }

  /** The collection as a question names it to the sidecar. */
  question(authored: string, dataRoot: string): ExecCollection {
    return {
      authored,
      tree: this.tree,
      path: this.path,
      file: this.databasePath.slice(join(dataRoot, "materialized").length + 1),
      update: this.current.update.id,
      directory: this.current.directory,
    };
  }

  private version(): number {
    return (this.database.query("pragma data_version").get() as { data_version: number }).data_version;
  }

  /** Whether another connection committed to the file since overstoryd last looked: only overstoryd may. */
  touchedByAnother(): boolean {
    const now = this.version();
    const touched = now !== this.dataVersion;
    this.dataVersion = now;
    return touched;
  }

  /**
   * Bring the file to `head`: unchanged collections only advance the record;
   * changed ones are diffed row by row and applied with it in one
   * transaction. False when the file can't follow (a new schema, or the
   * collection gone) and must be rebuilt.
   */
  async catchUp(head: AcceptedUpdate, read: Read, retained: (id: string) => AcceptedUpdate | null): Promise<boolean> {
    if (head.id === this.current.update.id) return true;
    const located = await locate(read, head.root, this.path);
    const directory = located?.spine.at(-1)?.directory;
    if (!located || !directory?.collection || schemaEntry(directory) !== this.current.schema) return false;
    const collection = stableJSONString(directory.collection);
    const writes: Array<{ schema: CollectionSchema; remove: Row[]; insert: Row[]; update: Row[] }> = [];
    if (collection !== this.current.collection) {
      const was = retained(this.current.update.id);
      const before = was && await locate(read, was.root, this.path);
      if (!before) return false;
      const rows = async (at: ProtocolDirectory) => keyed(this.schemas, rowsFromLogical(this.logical.result, this.layout, (await loadDirectoryCollection(at, read))!.tables) as Record<string, Row[]>);
      const [from, to] = [await rows(before.spine.at(-1)!.directory), await rows(directory)];
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
    const next: Applied = { update: head, schema: this.current.schema, collection, directory: located.hash };
    this.database.transaction(() => {
      this.database.exec("pragma defer_foreign_keys = on");
      for (const { schema, remove, insert, update } of writes) {
        const where = schema.primaryKey.map((column) => `${quote(column)} = ?`).join(" and ");
        const key = (row: Row) => schema.primaryKey.map((column) => toSQLite(row[column]));
        const values = (row: Row) => schema.columns.map((column) => toSQLite(row[column]));
        const removing = this.database.prepare(`delete from ${quote(schema.model)} where ${where}`);
        const inserting = this.database.prepare(`insert into ${quote(schema.model)} (${schema.columns.map(quote).join(", ")}) values (${schema.columns.map(() => "?").join(", ")})`);
        const updating = this.database.prepare(`update ${quote(schema.model)} set ${schema.columns.map((column) => `${quote(column)} = ?`).join(", ")} where ${where}`);
        for (const row of remove) removing.run(...key(row) as never[]);
        for (const row of insert) inserting.run(...values(row) as never[]);
        for (const row of update) updating.run(...values(row) as never[], ...key(row) as never[]);
      }
      writeMeta(this.database, next);
    })();
    if (collection !== this.current.collection) this.revision++;
    this.current = next;
    return true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.database.close();
  }
}

function writeMeta(database: Database, applied: Applied): void {
  const set = database.prepare(`insert into ${META} (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`);
  set.run("update", applied.update.id);
  set.run("schema", applied.schema);
  set.run("collection", applied.collection);
  set.run("directory", applied.directory);
}

function readMeta(path: string): { update: string; schema: string; collection: string; directory: string } | null {
  if (!existsSync(path)) return null;
  try {
    const database = new Database(path, { readonly: true });
    try {
      const rows = database.query(`select key, value from ${META}`).all() as Array<{ key: string; value: string }>;
      const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      return meta.update && meta.schema && meta.collection && meta.directory ? meta as { update: string; schema: string; collection: string; directory: string } : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

export interface HostCollectionsOptions {
  /** The module the execution sidecar loads its handles from, until handles are read from trees (Apps 005 step 2). */
  handles: string;
  /** How to start the sidecar; by default `bun` running `@ovst/overstoryd-exec`. The host adds its arguments. */
  command?: readonly string[];
  /** A mutation's logical time; tests fix it. */
  now?: () => Date;
  /** How long one question may take before the sidecar is restarted (default 30 s). */
  deadlineMs?: number;
  /** The disk budget for materializations (default 1 GiB); over it, idle ones are evicted, least recently used first. */
  materializedBytes?: number;
  /** How long a materialization goes unused before it counts as idle (default 15 minutes). */
  materializedIdleMs?: number;
}

/** The context the host's mutate route gives a mutation: the caller the update is submitted as. */
export interface HostMutationContext {
  user: { profile: string } | null;
  caller?: UpdateCaller;
}

/** The sidecar refused a question: an error the caller may see. */
export class ExecRefusal extends Error {
  constructor(readonly value: ExecPublicError) {
    super(value.message);
    this.name = "ExecRefusal";
  }
}

/** What overstoryd tells the streams it holds: a collection's rows changed, a tree a profile card comes from changed, or a file was rebuilt. */
type Change =
  | { kind: "collection"; tree: string; path: string }
  | { kind: "profile"; tree: string }
  | { kind: "reload"; tree: string; path: string };

/** One evaluation a stream holds: the value, its hash, and what it read. */
interface Evaluation {
  outputHash: Hash;
  value: unknown;
  reads: ExecReads;
}

const refKey = (ref: { module: string; export: string; version: string }) => `${ref.module}\0${ref.export}\0${ref.version}`;

/**
 * The host's collection materializations, at `<dataRoot>/materialized/<tree>/<path>/`,
 * and the execution sidecar that runs queries and mutations on them. Each is
 * built on first use, caught up after every accepted update to its tree, and
 * caught up again before a question names it.
 */
export class HostCollections implements AsyncDisposable {
  private readonly open = new Map<string, MaterializedCollection>();
  private readonly turns = new Map<string, Promise<unknown>>();
  private readonly stopAccepted: () => void;
  private readonly used = new Map<string, number>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  /** The streams open on each materialization, as listeners for its changes. */
  private readonly listeners = new Map<string, Set<(change: Change) => void>>();
  private sequence = 0;
  private origin?: string;
  readonly sidecar: ExecProcess;
  /** How many times a file was found written by another connection after a mutation; each one was rebuilt. */
  foreignWrites = 0;

  constructor(readonly daemon: HostDaemon, readonly dataRoot: string, private readonly options: HostCollectionsOptions) {
    const command = options.command ?? [process.execPath, Bun.resolveSync("@ovst/overstoryd-exec/cli", import.meta.dir)];
    this.sidecar = new ExecProcess(() => this.command(command), { deadlineMs: options.deadlineMs ?? 30_000 });
    this.stopAccepted = daemon.subscribeAccepted((update) => {
      this.publishAll({ kind: "profile", tree: update.tree });
      for (const collection of this.open.values()) {
        if (collection.tree !== update.tree) continue;
        void this.current(collection.tree, collection.path, false).catch((error) => console.error("overstoryd collection catch-up failed", error));
      }
    });
    this.sweeper = setInterval(() => void this.evictIdle().catch((error) => console.error("overstoryd collection eviction failed", error)),
      Math.max(60_000, this.idleMs / 3));
    this.sweeper.unref?.();
  }

  /** The host's own address, for the sidecar's standard API calls; set as the host starts listening. */
  listen(origin: string): void {
    this.origin = origin;
  }

  private command(base: readonly string[]): string[] {
    if (!this.origin) throw new ExecUnavailableError("The host is not listening yet");
    return [...base, "--handles", this.options.handles, "--materialized", join(this.dataRoot, "materialized"), "--state", join(this.dataRoot, "exec"), "--host", this.origin];
  }

  private get idleMs(): number { return this.options.materializedIdleMs ?? MATERIALIZED_IDLE_MS; }

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

  private publish(key: string, change: Change): void {
    this.sequence++;
    for (const listener of [...this.listeners.get(key) ?? []]) listener(change);
  }

  private publishAll(change: Change): void {
    if (![...this.listeners.values()].some((set) => set.size)) return;
    this.sequence++;
    for (const set of this.listeners.values()) for (const listener of [...set]) listener(change);
  }

  /** The collection at `path` in `tree`, caught up to the tree's accepted head. A catch-up after an accepted update doesn't count as use. */
  current(tree: string, path: string, use = true): Promise<MaterializedCollection> {
    const key = `${tree}\0${path}`;
    if (use) this.used.set(key, Date.now());
    return this.turn(key, async () => {
      const head = this.daemon.currentUpdate(tree);
      if (!head) throw new ExecRefusal({ code: "not-found", message: "The tree has no accepted state", retryable: false });
      const existing = this.open.get(key);
      if (existing) {
        const revision = existing.revision;
        if (await existing.catchUp(head, this.read, (id) => this.daemon.update(id))) {
          if (existing.revision !== revision) this.publish(key, { kind: "collection", tree, path });
          return existing;
        }
        this.open.delete(key);
        await existing[Symbol.asyncDispose]();
        this.publish(key, { kind: "reload", tree, path });
      }
      const opened = await this.materialize(tree, path, head);
      this.open.set(key, opened);
      void this.evictIdle().catch((error) => console.error("overstoryd collection eviction failed", error));
      return opened;
    });
  }

  /** After the sidecar used a file: if it wrote to it, which only overstoryd may, rebuild it. */
  private async verify(collection: MaterializedCollection): Promise<void> {
    if (!collection.touchedByAnother()) return;
    this.foreignWrites++;
    console.error("overstoryd: a materialization was written by another connection, which only overstoryd may do; rebuilding it");
    const key = `${collection.tree}\0${collection.path}`;
    await this.turn(key, async () => {
      if (this.open.get(key) !== collection) return;
      this.open.delete(key);
      await collection[Symbol.asyncDispose]();
      await rm(this.directoryOf(collection.tree, collection.path), { recursive: true, force: true });
      this.publish(key, { kind: "reload", tree: collection.tree, path: collection.path });
    });
  }

  /**
   * Keep the materializations within their disk budget: while over it, delete
   * idle ones, least recently used first. A materialization is idle when no
   * query stream is open on it, nothing is running against it, and it hasn't
   * been used for the idle time; a file left from before a restart is idle
   * from its last change. An evicted one is rebuilt on its next use.
   */
  async evictIdle(): Promise<void> {
    const root = join(this.dataRoot, "materialized");
    const found: Array<{ key: string; directory: string; bytes: number; used: number }> = [];
    for (const tree of await readdir(root).catch(() => [] as string[])) {
      for (const name of await readdir(join(root, tree)).catch(() => [] as string[])) {
        const directory = join(root, tree, name), key = `${tree}\0${decodeURIComponent(name)}`;
        let bytes = 0, changed = 0;
        for (const file of await readdir(directory).catch(() => [] as string[])) {
          const info = await stat(join(directory, file)).catch(() => null);
          if (info) { bytes += info.size; changed = Math.max(changed, info.mtimeMs); }
        }
        found.push({ key, directory, bytes, used: this.used.get(key) ?? changed });
      }
    }
    let total = found.reduce((sum, entry) => sum + entry.bytes, 0);
    const budget = this.options.materializedBytes ?? MATERIALIZED_BYTES;
    const idleBefore = Date.now() - this.idleMs;
    const listening = (key: string) => this.listeners.get(key)?.size ?? 0;
    for (const entry of found.filter((candidate) => candidate.used <= idleBefore).sort((a, b) => a.used - b.used)) {
      if (total <= budget) return;
      if (this.turns.has(entry.key) || listening(entry.key) > 0) continue;
      const evicted = await this.turn(entry.key, async () => {
        // Used or opened to a stream while waiting for the turn.
        if ((this.used.get(entry.key) ?? entry.used) > entry.used || listening(entry.key) > 0) return false;
        const open = this.open.get(entry.key);
        this.open.delete(entry.key);
        if (open) await open[Symbol.asyncDispose]();
        await rm(entry.directory, { recursive: true, force: true });
        this.used.delete(entry.key);
        return true;
      });
      if (evicted) total -= entry.bytes;
    }
  }

  /** Open the file left from before when it can catch up, or build it from the accepted rows at `head`. */
  private async materialize(tree: string, path: string, head: AcceptedUpdate): Promise<MaterializedCollection> {
    const directory = this.directoryOf(tree, path);
    const located = await locate(this.read, head.root, path);
    const at = located?.spine.at(-1)?.directory;
    const schema = at && schemaEntry(at);
    if (!located || !at?.collection || !schema) throw new ExecRefusal({ code: "not-found", message: `${path} is not a collection`, retryable: false });
    const meta = readMeta(join(directory, DATABASE));
    const left = meta?.schema === schema ? this.daemon.update(meta.update) : null;
    if (meta && left && left.tree === tree) {
      const reopened = await MaterializedCollection.open(tree, path, directory,
        { update: left, schema, collection: meta.collection, directory: meta.directory as ObjectHash });
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
    const rows = keyed(schemas, rowsFromLogical(logical.result, layout, (await loadDirectoryCollection(at, this.read))!.tables) as Record<string, Row[]>);
    const applied: Applied = { update: head, schema, collection: stableJSONString(at.collection), directory: located.hash };
    const database = new Database(join(directory, DATABASE), { create: true, strict: true });
    try {
      database.exec("pragma journal_mode = wal");
      database.exec(setupSql(layout, "sqlite"));
      database.exec(`create table ${META} (key text primary key, value text not null)`);
      database.transaction(() => {
        for (const schema of schemas) {
          const insert = database.prepare(`insert into ${quote(schema.model)} (${schema.columns.map(quote).join(", ")}) values (${schema.columns.map(() => "?").join(", ")})`);
          for (const row of rows.get(schema.model)!.values()) insert.run(...schema.columns.map((column) => toSQLite(row[column])) as never[]);
        }
        writeMeta(database, applied);
      })();
    } finally {
      database.close();
    }
    return MaterializedCollection.open(tree, path, directory, applied);
  }

  /** People's card fields as the host's profile cards describe them; null for an ID that is no profile here. */
  private profileCards(ids: readonly string[]): Record<string, ExecProfile | null> {
    return Object.fromEntries(ids.map((id) => {
      if (!this.daemon.get(id)) return [id, null];
      const card = this.daemon.profileCard(id);
      const handle = this.daemon.handleForProfile(id) ?? id;
      return [id, { id, name: card.displayName ?? handle, handle, portrait: null, bio: card.description ?? null, tree: id, ref: this.daemon.currentUpdate(id)?.root ?? "" }];
    }));
  }

  /** The handle the sidecar runs under this name, from its handshake. */
  private async handle(kind: "queries" | "mutations", ref: { module: string; export: string; version: string }): Promise<ExecHandle | undefined> {
    return (await this.sidecar.handles())[kind].find((candidate) => refKey(candidate) === refKey(ref));
  }

  /** One query's current value, asked of the sidecar against the caught-up file. */
  private async evaluate(tree: string, entry: ExecHandle, mount: { input?: unknown }, user: { profile: string } | null, known: Hash | undefined, signal: AbortSignal): Promise<Evaluation | { unchanged: Hash; reads: ExecReads }> {
    let profiles: Record<string, ExecProfile | null> = {};
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const collection = await this.current(tree, entry.collection);
      const answer = await this.sidecar.ask({
        kind: "query",
        query: { module: entry.module, export: entry.export, version: entry.version },
        input: mount.input,
        viewer: user,
        collections: [collection.question(entry.authored, this.dataRoot)],
        ...(Object.keys(profiles).length ? { profiles } : {}),
        ...(known ? { knownOutputHash: known } : {}),
      }, signal);
      if ("stale" in answer) continue;
      if ("need" in answer) {
        profiles = { ...profiles, ...this.profileCards(answer.need.profiles) };
        continue;
      }
      if ("refusal" in answer) throw new ExecRefusal(answer.refusal);
      if ("error" in answer) throw new ExecUnavailableError(answer.error.message);
      if ("unchanged" in answer) return { unchanged: known!, reads: answer.reads };
      if ("outputHash" in answer) return { outputHash: answer.outputHash, value: answer.value, reads: answer.reads };
      throw new ExecUnavailableError("The execution sidecar answered a query with a receipt");
    }
    throw new ExecUnavailableError("The collection kept changing while the query ran");
  }

  /** The query runtime the host's `/queries` route serves: overstoryd holds the stream and asks the sidecar again when what a result read changes. */
  queryRuntime(): QueryStreamRuntime {
    return {
      stream: async (request: QueryStreamRequest, context): Promise<ReadableStream<QueryStreamEvent>> => {
        const tree = request.document.tree;
        if (!Array.isArray(request.queries)) throw new Error("queries must be an array");
        const ids = new Set<string>();
        const mounts = await Promise.all(request.queries.map(async (mount) => {
          if (!mount.id || ids.has(mount.id)) throw new Error("Mounted query ids must be non-empty and unique");
          ids.add(mount.id);
          const entry = await this.handle("queries", mount.handle);
          if (!entry) throw new Error("A mounted query handle or version is not active");
          return { id: mount.id, input: mount.input, ...(mount.knownOutputHash ? { knownOutputHash: mount.knownOutputHash } : {}), entry };
        }));
        const paths = new Set(mounts.map((mount) => mount.entry.collection));
        if (paths.size !== 1) throw new Error("A query stream reads one collection");
        const path = [...paths][0]!;
        await this.current(tree, path);
        const key = `${tree}\0${path}`;
        // The last value the sidecar sent for each mount, so an unchanged answer has one.
        const last = new Map<string, Evaluation>();
        const evaluating = new AbortController();
        context.signal.addEventListener("abort", () => evaluating.abort(), { once: true });
        type Mount = typeof mounts[number];
        return liveQueryStream<Evaluation, ExecReads, Change, Mount>(mounts, context, {
          currentCursor: () => `query:${this.sequence}`,
          subscribe: (listener) => {
            const set = this.listeners.get(key) ?? new Set();
            set.add(listener);
            this.listeners.set(key, set);
            return () => {
              set.delete(listener);
              if (!set.size && this.listeners.get(key) === set) this.listeners.delete(key);
            };
          },
          initialSensitivity: () => ({ collections: [{ tree, path }], profiles: [] }),
          execute: async (mount) => {
            const known = last.get(mount.id)?.outputHash ?? mount.knownOutputHash;
            const answer = await this.evaluate(tree, mount.entry, mount, context.user, known, evaluating.signal);
            if ("unchanged" in answer) {
              const held = last.get(mount.id);
              return { outputHash: answer.unchanged, value: held?.outputHash === answer.unchanged ? held.value : undefined, reads: answer.reads };
            }
            last.set(mount.id, answer);
            return answer;
          },
          sensitivity: (_mount, execution) => execution.reads,
          relevant: (change, _mount, reads) => change.kind === "reload"
            || (change.kind === "collection" && (reads?.collections ?? [{ tree, path }]).some((read) => read.tree === change.tree && read.path === change.path))
            || (change.kind === "profile" && (reads?.profiles ?? []).some((read) => read.tree === change.tree)),
          result: (execution) => execution.value,
          outputHash: (execution) => execution.outputHash,
          safeError: (error) => error instanceof ExecRefusal ? error.value
            : { code: "unavailable", message: "The query could not be evaluated now", retryable: true },
          reload: (change) => change.kind === "reload" ? "source-changed" : undefined,
        });
      },
    };
  }

  /** The mutation runtime the host's `/mutate` route serves. */
  mutationRuntime(): MutationCallRuntime {
    return { call: (request, context) => this.mutate(request, context as HostMutationContext) };
  }

  /**
   * Run a named mutation (07 §5) in the sidecar, against the materialization
   * caught up to the tree's head, with an execution token carrying the
   * caller's own authority for this one question. The sidecar submits the
   * update and keeps the receipt; a collection that moved under it is asked
   * again.
   */
  async mutate(request: MutationCallRequest, context: HostMutationContext): Promise<MutationResultReceipt> {
    const entry = await this.handle("mutations", request.handle);
    if (!entry) throw new ExecRefusal({ code: "not-found", message: "The mutation handle or version is not active", retryable: false });
    const account = context.caller?.account;
    if (!account) throw new ExecRefusal({ code: "permission-denied", message: "A mutation needs a caller who can write the tree", retryable: false });
    const tree = request.handle.tree;
    const authentication = context.caller?.authentication;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const collection = await this.current(tree, entry.collection);
      const deadline = this.options.deadlineMs ?? 30_000;
      const token = this.daemon.execution.issue({
        code: tree,
        version: request.handle.version,
        caller: account.id,
        ...(context.caller?.linkDigest ? { linkDigest: context.caller.linkDigest } : {}),
        subject: `account:${account.id}`,
        expiresAt: Date.now() + deadline + 5_000,
        grants: [{ tree, within: "/", allow: ["read", "write"], lender: null }],
        active: () => !authentication || this.daemon.authenticationIsActive(authentication),
      });
      let answer;
      try {
        answer = await this.sidecar.ask({
          kind: "mutation",
          tree,
          mutation: { module: request.handle.module, export: request.handle.export, version: request.handle.version },
          mutationID: request.mutationID,
          input: request.input,
          viewer: context.user,
          collections: [collection.question(entry.authored, this.dataRoot)],
          token,
          now: (this.options.now?.() ?? new Date()).toISOString(),
        });
      } finally {
        this.daemon.execution.revoke(token);
        await this.verify(collection);
      }
      if ("stale" in answer) continue;
      if ("refusal" in answer) throw new ExecRefusal(answer.refusal);
      if ("error" in answer) throw new ExecUnavailableError(answer.error.message);
      if (!("receipt" in answer)) throw new ExecUnavailableError("The execution sidecar answered a mutation with a query result");
      // Reads after the receipt see the accepted rows.
      await this.current(tree, entry.collection);
      return answer.receipt;
    }
    throw new ExecUnavailableError("The tree kept changing while the mutation ran");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    clearInterval(this.sweeper);
    this.stopAccepted();
    await this.sidecar[Symbol.asyncDispose]();
    await Promise.allSettled([...this.turns.values()]);
    for (const collection of this.open.values()) await collection[Symbol.asyncDispose]();
    this.open.clear();
  }
}
