// Beetle on the host (Apps 015 step 2): overstoryd runs `.beetle` views and mutations in
// process, since no general-purpose code runs. A handle names a file in a tree; the host
// reads that file and everything it uses at the tree's head, checks it, and answers with
// the evaluator over the bound collections' accepted rows. A mutation's facts become one
// row-only update guarded on the head it read, submitted as its caller.

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BeetleError,
  compileProgram,
  Evaluator,
  isSchemaPath,
  pageSource,
  parseView,
  resolvePath,
  editedLogical,
  OverlayStore,
  runMutation,
  Store,
  StoreSchema,
  type Program,
  type WriteStore,
} from "@ovst/beetle";
import {
  decodeProtocolDirectory,
  decodeProtocolPage,
  liveViewStream,
  logicalRowKey,
  semanticRequestDigest,
  stableJSONString,
  type AcceptedUpdate,
  type DerivableUpdateRequest,
  type HandleRef,
  type LogicalRow,
  type MutationCallRequest,
  type MutationCallRuntime,
  type MutationResultReceipt,
  type ObjectHash,
  type ProtocolDirectory,
  type RowOperation,
  type ViewEvent,
  type ViewsRequest,
  type ViewsRuntime,
} from "@ovst/protocol";
import { changedCollectionRows, directoryCollectionSchema, loadDirectoryCollection, rowOperationsBetween, type LogicalSchema } from "@ovst/collection-schema";
import { SQLiteStore, SQLiteWriteStore } from "@ovst/beetle/sqlite";
import { Materialization, type LogicalChanges } from "./beetle-materialized.ts";
import { rowsFromLogical, type LogicalTables, type RowsByTable } from "@ovst/usl";
import type { HostDaemon, UpdateCaller } from "./overstoryd.ts";

type Read = (hash: ObjectHash) => Promise<Uint8Array>;
type RowWrite = { table: string; key: string; deleted?: true };

/** How many times a mutation runs again when its tree moves under it. */
const ATTEMPTS = 5;
/** How many checked files and loaded collections are kept. */
const CACHED = 64;

/** A refusal a caller may see: a public Beetle error, or a request the host can't answer. */
export class BeetleRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly retryable = false) {
    super(message);
    this.name = "BeetleRefusal";
  }
}

const STATUS: Record<string, number> = { unauthorized: 401, forbidden: 403, missing: 404, invalid: 422, conflict: 409 };
const refusalOf = (error: BeetleError) => new BeetleRefusal(error.code, error.message, STATUS[error.code] ?? 400);

/** Whether a handle's path names a Beetle file: a `.beetle` file or a page's view blocks. */
export function isBeetlePath(path: string): boolean {
  return path.endsWith(".beetle") || path.endsWith(".md");
}

/** A file as checked at one root: its program, its code version, and what it read. */
interface Checked {
  program: Program;
  /** SHA-256 over the paths and texts of the file and every file it uses (Beetle §6). */
  version: string;
}

/** A bound collection at one root: its rows and where they are. */
interface Loaded {
  path: string;
  directory: ObjectHash;
  rows: RowsByTable;
  layout: StoreSchema["layout"];
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key: string, value: V): void {
    this.map.set(key, value);
    while (this.map.size > CACHED) this.map.delete(this.map.keys().next().value!);
  }
}

/** Times for rows a mutation produced: unchanged rows keep theirs, changed ones are modified at `now`, new ones created then. */
function stamp(after: LogicalTables, before: LogicalTables, now: number): LogicalTables {
  const out: LogicalTables = {};
  for (const [model, rows] of Object.entries(after)) {
    const prior = new Map((before[model] ?? []).map((row) => [logicalRowKey(row as LogicalRow), row]));
    out[model] = rows.map((row) => {
      const was = prior.get(logicalRowKey(row as LogicalRow));
      if (!was) return { ...row, created: now, modified: now };
      if (stableJSONString(was.fields) === stableJSONString(row.fields)) return { ...row, created: was.created, modified: was.modified };
      return { ...row, created: was.created, modified: now };
    });
  }
  return out;
}

export interface BeetleHostOptions {
  /** The trees whose hosting is enabled (Beetle §6): every tree, or these. */
  trees: "all" | readonly string[] | ((tree: string) => boolean);
  /** A mutation's logical time; tests fix it. */
  now?: () => Date;
}

export class BeetleHost implements AsyncDisposable {
  private readonly checked = new Lru<Checked>();
  private readonly collections = new Lru<Loaded>();
  private readonly receipts: Database;
  /** The SQLite copies of collections views read, by tree and collection path. */
  private readonly materialized = new Map<string, Materialization>();
  private readonly turns = new Map<string, Promise<unknown>>();

  constructor(readonly daemon: HostDaemon, private readonly dataRoot: string, private readonly options: BeetleHostOptions) {
    mkdirSync(join(dataRoot, "beetle"), { recursive: true });
    this.receipts = new Database(join(dataRoot, "beetle", "receipts.sqlite3"), { create: true, strict: true });
    this.receipts.exec("pragma journal_mode = wal");
    this.receipts.exec(`create table if not exists receipts (
      tree text not null, subject text not null, mutation_id text not null,
      request_digest text not null, request_json text, receipt_json text,
      primary key (tree, subject, mutation_id))`);
  }

  enabled(tree: string): boolean {
    const trees = this.options.trees;
    return trees === "all" || (typeof trees === "function" ? trees(tree) : trees.includes(tree));
  }

  private readonly read: Read = (hash) => this.daemon.object(hash);

  // ---------------------------------------------------------------- reading files

  private async directoryAt(root: ObjectHash, path: string): Promise<{ directory: ProtocolDirectory; hash: ObjectHash } | null> {
    let hash = root;
    let directory = decodeProtocolDirectory(await this.read(root));
    for (const name of path.split("/").filter(Boolean)) {
      const entry = directory.entries.find((candidate) => candidate.name === name);
      if (!entry?.directory) return null;
      hash = entry.directory as ObjectHash;
      directory = decodeProtocolDirectory(await this.read(hash));
    }
    return { directory, hash };
  }

  /** A file's text at a root: a file entry's bytes, or a page's body. */
  private async textAt(root: ObjectHash, path: string): Promise<string | undefined> {
    const slash = path.lastIndexOf("/");
    const parent = await this.directoryAt(root, path.slice(0, slash));
    if (!parent) return undefined;
    const name = path.slice(slash + 1);
    const entry = parent.directory.entries.find((e) => e.name === name) ?? (name.endsWith(".md") ? parent.directory.entries.find((e) => e.name === name.slice(0, -3) && e.page) : undefined);
    if (entry?.file) return new TextDecoder().decode(await this.read(entry.file as ObjectHash));
    if (entry?.page) return new TextDecoder().decode(decodeProtocolPage(await this.read(entry.page as ObjectHash)).body);
    return undefined;
  }

  /** The file at `path` checked at `root`, with every file it uses read first. */
  async check(root: ObjectHash, path: string): Promise<Checked> {
    const key = `${root}\0${path}`;
    const cached = this.checked.get(key);
    if (cached) return cached;
    const files = new Map<string, string | undefined>();
    const load = async (p: string) => {
      if (!files.has(p)) files.set(p, await this.textAt(root, p));
      return files.get(p);
    };
    const own = await load(path);
    if (own === undefined) throw new BeetleRefusal("not-found", `There is no file at ${path}`, 404);
    // The nearest collection schema at or above the file binds its tables.
    for (let dir = path.slice(0, path.lastIndexOf("/")); ; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      if (await load(`${dir}/schema.beetle`) !== undefined || !dir) break;
    }
    const queue = [path];
    const seen = new Set<string>();
    while (queue.length) {
      const p = queue.shift()!;
      if (seen.has(p)) continue;
      seen.add(p);
      const text = await load(p);
      if (text === undefined) continue;
      const file = p.endsWith(".md") ? pageSource(text).file : parseView(text).file;
      for (const { decl } of file.declarations) {
        if (decl.kind !== "use") continue;
        const target = resolvePath(p, decl.path);
        queue.push(target);
      }
    }
    const read = (p: string) => files.get(p);
    const program = compileProgram(own, { path, read });
    if (program.check.diagnostics.length) {
      const first = program.check.diagnostics[0]!;
      throw new BeetleRefusal("invalid-request", `${first.path ?? path}:${first.line}:${first.column}: ${first.code}: ${first.message}`, 400);
    }
    const hash = createHash("sha256");
    for (const p of [...files.keys()].filter((p) => files.get(p) !== undefined).sort()) hash.update(`${p}\0${files.get(p)}\0`);
    const checked = { program, version: `sha256:${hash.digest("hex")}` };
    this.checked.set(key, checked);
    return checked;
  }

  /** Whether a handle names something Beetle declares: any handle in a `.beetle` file or page, or a schema's view or mutation. */
  async names(tree: string, handle: HandleRef): Promise<boolean> {
    if (!this.enabled(tree)) return false;
    if (isBeetlePath(handle.path) && !isSchemaPath(handle.path)) return true;
    if (!isSchemaPath(handle.path)) return false;
    const head = this.daemon.currentUpdate(tree);
    if (!head) return false;
    try {
      const { program } = await this.check(head.root as ObjectHash, handle.path);
      const declared = program.check.views.some((v) => v.name === handle.name) || program.check.mutations.some((m) => m.name === handle.name);
      return declared;
    } catch {
      return false;
    }
  }

  /** A collection directory's rows in its database layout, cached by the directory's hash. */
  private async loadRows(path: string, at: { directory: ProtocolDirectory; hash: ObjectHash }): Promise<Loaded | null> {
    let loaded = this.collections.get(at.hash);
    if (!loaded) {
      const collection = await loadDirectoryCollection(at.directory, this.read);
      if (!collection) return null;
      const store = new StoreSchema(collection.schema.result);
      loaded = {
        path,
        directory: at.hash,
        rows: rowsFromLogical(collection.schema.result, store.layout, collection.tables),
        layout: store.layout,
      };
      this.collections.set(at.hash, loaded);
    }
    return loaded;
  }

  /** Run `work` as the only change to one copy. */
  private turn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.turns.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.turns.set(key, next);
    return next.finally(() => { if (this.turns.get(key) === next) this.turns.delete(key); });
  }

  /**
   * The SQLite copy of the collection at `path`, caught up to `root`: reopened from disk,
   * moved by the changed rows of the chunks that differ from the directory it last held, or built from the accepted rows.
   */
  private materialize(tree: string, path: string, root: ObjectHash, held = false): Promise<Materialization | null> {
    const key = `${tree}\0${path}`;
    return held ? this.catchUp(key, tree, path, root) : this.turn(key, () => this.catchUp(key, tree, path, root));
  }

  /** Hold the copies at `keys` for `work`, one turn after another in key order. */
  private holding<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = [...new Set(keys)].sort();
    return first === undefined ? work() : this.turn(first, () => this.holding(rest, work));
  }

  private async catchUp(key: string, tree: string, path: string, root: ObjectHash): Promise<Materialization | null> {
    {
      const at = await this.directoryAt(root, path);
      if (!at?.directory.collection) return null;
      const schema = at.directory.entries.find((e) => e.name === "schema.beetle")?.file;
      if (!schema) return null;
      const folder = join(this.dataRoot, "beetle", "materialized", tree, encodeURIComponent(path));
      let copy = this.materialized.get(key) ?? Materialization.reopen(folder) ?? undefined;
      if (copy && copy.schema === schema && copy.directory === at.hash) {
        this.materialized.set(key, copy);
        return copy;
      }
      if (copy && copy.schema === schema) {
        try {
          // Only the tables and chunks that changed are read, and only their rows are moved.
          const was = decodeProtocolDirectory(await this.read(copy.directory as ObjectHash));
          const logical = await directoryCollectionSchema(at.directory, this.read);
          const changes = await changedCollectionRows(logical, was.collection, at.directory.collection, this.read);
          copy.applyChanges(new StoreSchema(logical.result), changes, at.hash);
          this.materialized.set(key, copy);
          return copy;
        } catch (error) {
          console.error("overstoryd: a collection copy could not catch up; rebuilding it", error);
        }
      }
      const after = await this.loadRows(path, at);
      if (!after) return null;
      copy?.close();
      copy = Materialization.build(folder, after.layout, after.rows, at.hash, schema);
      this.materialized.set(key, copy);
      return copy;
    }
  }

  /**
   * An evaluator for a view at `root` over the SQLite copies, or null when a copy moved past
   * `root` while another was caught up (the caller asks again at the new head).
   */
  private async sqliteEvaluator(tree: string, root: ObjectHash, checked: Checked, caller: UpdateCaller | undefined, me: string | null, now: Date, people?: Set<string>, held = false): Promise<{ ev: Evaluator; sources: Map<string, { path: string; directory: ObjectHash }>; copies: Map<string, Materialization> } | null> {
    const copies = new Map<string, { copy: Materialization; path: string; directory: string }>();
    for (const schemaPath of checked.program.checker.schemas.keys()) {
      const path = schemaPath.slice(0, schemaPath.lastIndexOf("/")) || "/";
      const copy = await this.materialize(tree, path, root, held);
      if (copy) copies.set(schemaPath, { copy, path, directory: copy.directory });
    }
    // Everything below runs without yielding, so no copy changes while the view reads it.
    if ([...copies.values()].some(({ copy, directory }) => copy.directory !== directory)) return null;
    const person = this.personFields(caller, people);
    const stores = new Map<string, Store>();
    for (const [schemaPath, entry] of checked.program.checker.schemas) {
      const found = copies.get(schemaPath);
      const schema = new StoreSchema(entry.result);
      stores.set(schemaPath, found ? new SQLiteStore(schema, found.copy.database, person) : new Store(schema, {}, person));
    }
    const sources = new Map([...copies].map(([schemaPath, c]) => [schemaPath, { path: c.path, directory: c.directory as ObjectHash }]));
    return { ev: new Evaluator(checked.program, stores, { me, now, person }), sources, copies: new Map([...copies].map(([schemaPath, c]) => [schemaPath, c.copy])) };
  }

  /** A person's card fields, as the caller may read them. */
  private personFields(caller: UpdateCaller | undefined, read?: Set<string>) {
    return (id: string): Record<string, unknown> | null => {
      read?.add(id);
      if (!this.daemon.get(id) || !this.daemon.canRead(caller?.account ?? null, id, caller?.linkDigest)) return null;
      const card = this.daemon.profileCard(id);
      return {
        name: card.displayName ?? card.headingTitle ?? null,
        handle: this.daemon.handleForProfile(id) ?? null,
        bio: card.description ?? null,
        portrait: null,
      };
    };
  }

  // ---------------------------------------------------------------- views

  /** A stream of Beetle views, kept current as their tree's accepted head moves. */
  stream(request: ViewsRequest, context: { signal: AbortSignal; user: { profile: string } | null; caller?: UpdateCaller }): ReadableStream<ViewEvent> {
    const tree = request.views[0]!.handle.tree;
    type Mount = ViewsRequest["views"][number];
    type Execution = { value: unknown; people: Set<string> };
    type Change = { tree: string };
    return liveViewStream<Execution, Set<string>, Change, Mount>(request.views, context, {
      subscribe: (listener) => this.daemon.subscribeAccepted((update: AcceptedUpdate) => listener({ tree: update.tree })),
      execute: async (mount) => {
        const head = this.daemon.currentUpdate(tree);
        if (!head) throw new BeetleRefusal("not-found", "The tree has no accepted state", 404);
        const checked = await this.check(head.root as ObjectHash, mount.handle.path);
        if (checked.version !== mount.handle.version) throw new BeetleRefusal("not-found", "The view handle or version is not active", 404);
        const people = new Set<string>();
        let ev: Evaluator | null = null;
        for (let attempt = 0; !ev; attempt++) {
          if (attempt === 5) throw new BeetleRefusal("unavailable", "The tree kept changing while the view ran", 503, true);
          const at = this.daemon.currentUpdate(tree)!;
          if (at.root !== head.root && (await this.check(at.root as ObjectHash, mount.handle.path)).version !== checked.version) {
            throw new BeetleRefusal("not-found", "The view handle or version is not active", 404);
          }
          ev = (await this.sqliteEvaluator(tree, at.root as ObjectHash, checked, context.caller, context.user?.profile ?? null, new Date(), people))?.ev ?? null;
        }
        const decl = ev.declaredView(mount.handle.name);
        if (!decl) throw new BeetleRefusal("not-found", `${mount.handle.path} has no view ${mount.handle.name || "(unnamed)"}`, 404);
        if (decl.data) return { value: ev.data(mount.handle.name, mount.input), people };
        if (mount.form === "rows") throw new BeetleRefusal("unsupported-operation", "A rows answer for a Beetle view comes with Story's evaluator; ask for its tree", 422);
        return { value: ev.view(mount.handle.name, mount.input), people };
      },
      sensitivity: (_mount, execution) => execution.people,
      relevant: (change, _mount, people) => change.tree === tree || (people?.has(change.tree) ?? false),
      result: (execution) => execution.value,
      safeError: (error) => {
        if (error instanceof BeetleRefusal) return { code: error.code, message: error.message, retryable: error.retryable };
        if (error instanceof BeetleError) return { code: error.code, message: error.message, retryable: false };
        console.error("overstoryd: a Beetle view failed", error);
        return { code: "unavailable", message: "The view could not be evaluated now", retryable: true };
      },
    });
  }

  /** Refuse a stream's handles that aren't active before it opens. */
  async verify(request: ViewsRequest): Promise<void> {
    for (const mount of request.views) {
      const head = this.daemon.currentUpdate(mount.handle.tree);
      if (!head) throw new BeetleRefusal("not-found", "The tree has no accepted state", 404);
      const checked = await this.check(head.root as ObjectHash, mount.handle.path);
      if (checked.version !== mount.handle.version) throw new BeetleRefusal("not-found", "A mounted view handle or version is not active", 404);
    }
  }

  // ---------------------------------------------------------------- mutations

  /**
   * Run a mutation (updates and merging §4) as its caller: check its file at the head,
   * gather its facts over the accepted rows, and submit the rows they change as one
   * update guarded on that head. A head that moved runs it again. An exact retry is
   * answered from its receipt.
   */
  async mutate(request: MutationCallRequest, context: { user: { profile: string } | null; caller?: UpdateCaller }): Promise<MutationResultReceipt> {
    const caller = context.caller;
    if (!caller?.account) throw new BeetleRefusal("permission-denied", "A mutation needs a caller who can write the tree", 403);
    const tree = request.handle.tree;
    if (typeof request.mutationID !== "string" || !request.mutationID) throw new BeetleRefusal("invalid-request", "A mutation identity is required", 400);
    const subject = context.user?.profile ?? caller.account.id;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const head = this.daemon.currentUpdate(tree);
      if (!head) throw new BeetleRefusal("not-found", "The tree has no accepted state", 404);
      const checked = await this.check(head.root as ObjectHash, request.handle.path);
      if (checked.version !== request.handle.version) throw new BeetleRefusal("not-found", "The mutation handle or version is not active", 404);
      if (!checked.program.checker.mutations.has(request.handle.name)) throw new BeetleRefusal("not-found", `There is no mutation ${request.handle.name}`, 404);
      // Each bound collection's copy is held from its reads to its commit: no view or other
      // mutation catches it up while this one's transaction is open.
      const paths = [...checked.program.checker.schemas.keys()].map((schemaPath) => schemaPath.slice(0, schemaPath.lastIndexOf("/")) || "/");
      const receipt = await this.holding(paths.map((path) => `${tree}\0${path}`), () => this.mutateAt(tree, head, checked, request, context, subject));
      if (receipt) return receipt;
    }
    throw new BeetleRefusal("unavailable", "The tree kept changing while the mutation ran", 503, true);
  }

  /**
   * One attempt at a mutation at `head`, with its copies held: its writes go into a SQL
   * transaction on each changed copy (Performance 007), which commits, holding the rows as
   * accepted, only when its update is accepted. Null when the head moved: run it again.
   */
  private async mutateAt(tree: string, head: { id: string; root: string }, checked: Checked, request: MutationCallRequest, context: { user: { profile: string } | null; caller?: UpdateCaller }, subject: string): Promise<MutationResultReceipt | null> {
    const caller = context.caller!;
    // The logical models of each bound collection.
    const models = new Map<string, LogicalSchema>();
    for (const schemaPath of checked.program.checker.schemas.keys()) {
      const path = schemaPath.slice(0, schemaPath.lastIndexOf("/")) || "/";
      const at = await this.directoryAt(head.root as ObjectHash, path);
      if (at?.directory.collection) models.set(schemaPath, await directoryCollectionSchema(at.directory, this.read));
    }
    const now = this.options.now?.() ?? new Date();
    const run = await this.sqliteEvaluator(tree, head.root as ObjectHash, checked, caller, context.user?.profile ?? null, now, undefined, true);
    if (!run) return null;
    const sources = [...run.sources.values()].sort((a, b) => a.path.localeCompare(b.path));
    const requestDigest = semanticRequestDigest({ version: "mutate-v1", handle: request.handle, input: request.input ?? null, sources: sources.map((s) => ({ tree, path: s.path })) });
    const stored = this.receipts.query("select request_digest, request_json, receipt_json from receipts where tree = ? and subject = ? and mutation_id = ?")
      .get(tree, subject, request.mutationID) as { request_digest: string; request_json: string | null; receipt_json: string | null } | null;
    if (stored) {
      if (stored.request_digest !== requestDigest) throw new BeetleRefusal("conflict", "The mutation identity was already used for different intent", 409);
      if (stored.receipt_json) return JSON.parse(stored.receipt_json) as MutationResultReceipt;
      // Stopped after submitting: the same request again is answered by the host's own receipt.
      const pending = JSON.parse(stored.request_json!) as { update: DerivableUpdateRequest; rows: RowWrite[] };
      const resubmitted = await this.submit(tree, pending.update, caller);
      if (resubmitted) return this.settle(tree, subject, request.mutationID, pending.rows, requestDigest, resubmitted);
      this.receipts.query("delete from receipts where tree = ? and subject = ? and mutation_id = ?").run(tree, subject, request.mutationID);
      return null; // run it again over the copies at the new head
    }
    // Each changed collection's writes go into a transaction on its copy's own file.
    const copyOf = new Map<Store, Materialization>();
    for (const [schemaPath, store] of run.ev.stores) {
      const copy = run.copies.get(schemaPath);
      if (copy) copyOf.set(store, copy);
    }
    const writing = new Set<Materialization>();
    const writeTo = (store: Store): WriteStore => {
      const copy = copyOf.get(store);
      if (!copy) return new OverlayStore(store);
      writing.add(copy);
      return new SQLiteWriteStore(store, copy.beginWrite());
    };
    try {
      let outcome;
      try {
        outcome = runMutation(run.ev, request.handle.name, request.input ?? null, { mutationID: `${tree}\0${subject}\0${request.mutationID}`, writeTo });
      } catch (error) {
        if (error instanceof BeetleError) throw refusalOf(error);
        throw error;
      }
      const operations: RowOperation[] = [];
      const settled: Array<{ copy: Materialization; path: string; schema: StoreSchema; changes: LogicalChanges }> = [];
      for (const [schemaPath, { before: was, after: written }] of Object.entries(outcome.changed)) {
        const source = run.sources.get(schemaPath);
        const logical = models.get(schemaPath);
        if (!source || !logical) throw new BeetleRefusal("invalid", "A mutation writes only collections in its tree", 422);
        // Only the rows the mutation touched, and the rows that hold them, become logical rows.
        const touched = editedLogical(was, written, written.edits(), now.getTime());
        const next = stamp(touched.after, touched.before, now.getTime());
        const ops = rowOperationsBetween(logical.models, touched.before, next, { material: { kind: "basis", path: source.path, object: source.directory } });
        if (!ops) throw new BeetleRefusal("internal-error", "The mutation's changes can't be stated as row operations", 500);
        operations.push(...ops);
        const copy = run.copies.get(schemaPath);
        if (copy && writing.has(copy)) {
          const changes: LogicalChanges = {};
          for (const model of new Set([...Object.keys(touched.before), ...Object.keys(next)])) changes[model] = { before: touched.before[model] ?? [], after: next[model] ?? [] };
          settled.push({ copy, path: source.path, schema: was.schema, changes });
        }
      }
      const isDeleted = (table: string, key: unknown) => (outcome.deleted[table] ?? []).some((k) => stableJSONString(k) === stableJSONString(key));
      const rows: RowWrite[] = Object.entries(outcome.writes).flatMap(([table, keys]) => keys.map((key) => ({ table, key: stableJSONString(key), ...(isDeleted(table, key) ? { deleted: true as const } : {}) })))
        .sort((a, b) => (a.table === b.table ? a.key.localeCompare(b.key) : a.table.localeCompare(b.table)));
      if (!operations.length) return this.settle(tree, subject, request.mutationID, rows, requestDigest, null);
      operations.forEach((operation, index) => { operation.key = `row-${index + 1}`; });
      const change = `mutation-${createHash("sha256").update(`${tree}\0${subject}\0${request.mutationID}\0${requestDigest}`).digest("hex").slice(0, 32)}`;
      const update: DerivableUpdateRequest = {
        base: head.id,
        updates: [{ change, at: now.toISOString(), candidate: null, ifCurrent: head.id, trace: [{ operations }], resolves: [], deltas: [], objects: [] }],
      } as DerivableUpdateRequest;
      this.receipts.query("insert or replace into receipts (tree, subject, mutation_id, request_digest, request_json, receipt_json) values (?, ?, ?, ?, ?, null)")
        .run(tree, subject, request.mutationID, requestDigest, JSON.stringify({ update, rows }));
      const affected = await this.submit(tree, update, caller);
      if (!affected) {
        this.receipts.query("delete from receipts where tree = ? and subject = ? and mutation_id = ?").run(tree, subject, request.mutationID);
        return null;
      }
      // Accepted: each copy's transaction commits at the accepted collection's directory.
      const root = this.daemon.update(affected)?.root as ObjectHash | undefined;
      for (const { copy, path, schema, changes } of settled) {
        const at = root ? await this.directoryAt(root, path) : null;
        if (at) copy.commitWrite(schema, changes, at.hash);
      }
      return this.settle(tree, subject, request.mutationID, rows, requestDigest, affected);
    } finally {
      // Whatever didn't commit is rolled back; the copy then catches up from the log.
      for (const copy of writing) copy.rollbackWrite();
    }
  }

  /** Submit a mutation's update; the accepted update it made, or null when its guard went stale. */
  private async submit(tree: string, request: DerivableUpdateRequest, caller: UpdateCaller): Promise<string | null> {
    let response;
    try {
      response = await this.daemon.submitUpdate(tree, request, caller);
    } catch (error) {
      if (error instanceof Error && /stale|base-not-retained|conflict/i.test(`${(error as { code?: string }).code ?? ""} ${error.message}`)) return null;
      throw error;
    }
    if (response.status === 409 || !("results" in response.result)) return null;
    const results = (response.result as { results: Array<{ update: { id: string } }> }).results;
    return results.at(-1)?.update.id ?? null;
  }

  private settle(tree: string, subject: string, mutationID: string, rows: RowWrite[], requestDigest: MutationResultReceipt["requestDigest"], affected: string | null): MutationResultReceipt {
    const receipt: MutationResultReceipt = { mutationID, requestDigest, ...(affected ? { affected: { tree, update: affected } } : {}), result: null, rows };
    this.receipts.query("update receipts set receipt_json = ? where tree = ? and subject = ? and mutation_id = ?")
      .run(JSON.stringify(receipt), tree, subject, mutationID);
    this.receipts.query("insert or ignore into receipts (tree, subject, mutation_id, request_digest, request_json, receipt_json) values (?, ?, ?, ?, null, ?)")
      .run(tree, subject, mutationID, requestDigest, JSON.stringify(receipt));
    return receipt;
  }

  /** The runtime the host's `/views` route serves. */
  viewsRuntime(): ViewsRuntime {
    return {
      stream: async (request, context) => {
        if (!Array.isArray(request.views) || request.views.length === 0) throw new Error("views must be a nonempty array");
        const ids = new Set(request.views.map((mount) => mount?.id));
        if (ids.size !== request.views.length || [...ids].some((id) => typeof id !== "string" || !id)) throw new Error("Mounted view ids must be non-empty and unique");
        // The route checked that every handle names its source tree.
        const tree = request.views[0]!.handle.tree;
        for (const mount of request.views) {
          if (!mount.handle || typeof mount.handle.path !== "string") throw new Error("A mounted view names a handle");
          if (!await this.names(tree, mount.handle)) throw new BeetleRefusal("not-found", `${mount.handle.path} is not a Beetle file this host runs`, 404);
        }
        await this.verify(request);
        return this.stream(request, context as { signal: AbortSignal; user: { profile: string } | null; caller?: UpdateCaller });
      },
    };
  }

  /** The runtime the host's `/mutate` route serves. */
  mutationRuntime(): MutationCallRuntime {
    return {
      call: async (request, context) => {
        if (!request.handle || !await this.names(request.handle.tree, request.handle)) {
          throw new BeetleRefusal("not-found", "The mutation handle or version is not active", 404);
        }
        return this.mutate(request, context as { user: { profile: string } | null; caller?: UpdateCaller });
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.allSettled([...this.turns.values()]);
    for (const copy of this.materialized.values()) copy.close();
    this.materialized.clear();
    this.receipts.close();
  }
}
