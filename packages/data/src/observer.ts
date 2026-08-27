import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { RelationMetadata, StoreSchema } from "./schema.ts";

export type SQLiteChangeOperation = "insert" | "update" | "delete";

export interface SQLiteRowChange {
  collection: string;
  operation: SQLiteChangeOperation;
  primaryKey: Record<string, unknown>;
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export type SQLiteStoreChange =
  | { cursor: string; precision: "rows"; changes: SQLiteRowChange[] }
  | { cursor: string; precision: "schema"; schemaVersion: number }
  | { cursor: string; precision: "store"; reason: "external" };

type StoreListener = (change: SQLiteStoreChange) => void;
type LoggedChange = { collection: string; operation: SQLiteChangeOperation; before_json: string | null; after_json: string | null };

export interface SQLiteTransactionControl {
  /** Reserve the one durable cursor associated with this logical transaction. */
  reserveCursor(): string;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pragmaNumber(database: Database, name: "data_version" | "schema_version"): number {
  const row = database.query(`pragma ${name}`).get() as Record<string, unknown> | null;
  return Number(row?.[name] ?? 0);
}

function jsonObject(prefix: "old" | "new", relation: RelationMetadata): string {
  return `json_object(${Object.values(relation.fields).flatMap((field) => [
    literal(field.name),
    field.type === "bytes"
      ? `case when ${prefix}.${identifier(field.name)} is null then null else json_object('$bytes', hex(${prefix}.${identifier(field.name)})) end`
      : `${prefix}.${identifier(field.name)}`,
  ]).join(", ")})`;
}

function parseRow(value: string | null): Record<string, unknown> | null {
  return value === null ? null : JSON.parse(value) as Record<string, unknown>;
}

function rowChange(
  schema: StoreSchema,
  row: { collection: string; operation: SQLiteChangeOperation; before_json: string | null; after_json: string | null },
): SQLiteRowChange {
  const before = parseRow(row.before_json);
  const after = parseRow(row.after_json);
  const relation = schema.relations[row.collection]!;
  for (const value of [before, after]) {
    if (!value) continue;
    for (const field of Object.values(relation.fields)) {
      if (field.type === "boolean" && value[field.name] !== null && value[field.name] !== undefined) {
        value[field.name] = Boolean(value[field.name]);
      }
    }
  }
  const source = after ?? before ?? {};
  const fields = Object.keys(relation.fields);
  const changedFields = row.operation === "update"
    ? fields.filter((field) => !Object.is(before?.[field], after?.[field]))
    : fields;
  return {
    collection: row.collection,
    operation: row.operation,
    primaryKey: Object.fromEntries(relation.primaryKey.map((field) => [field, source[field]])),
    changedFields,
    before,
    after,
  };
}

function coalesceRowChanges(schema: StoreSchema, rows: LoggedChange[]): SQLiteRowChange[] {
  const values = new Map<string, SQLiteRowChange>();
  for (const row of rows) {
    const next = rowChange(schema, row);
    const key = `${next.collection}\0${JSON.stringify(next.primaryKey)}`;
    const previous = values.get(key);
    if (!previous) {
      values.set(key, next);
      continue;
    }
    const before = previous.before;
    const after = next.after;
    if (before === null && after === null) {
      values.delete(key);
      continue;
    }
    const operation: SQLiteChangeOperation = before === null ? "insert" : after === null ? "delete" : "update";
    const fields = Object.keys(schema.relations[next.collection]!.fields);
    const changedFields = operation === "update"
      ? fields.filter((field) => !Object.is(before?.[field], after?.[field]))
      : fields;
    if (operation === "update" && changedFields.length === 0) {
      values.delete(key);
      continue;
    }
    values.set(key, { ...next, operation, before, after, changedFields });
  }
  return [...values.values()];
}

/**
 * Owns Arbor writes to one SQLite store. TEMP triggers make row observation
 * transactional: their log rows roll back with the write and are published
 * only after the outer commit succeeds.
 */
export class SQLiteStoreBroker implements AsyncDisposable {
  private readonly database: Database;
  private readonly probe: Database;
  private readonly listeners = new Set<StoreListener>();
  private sequence = 0;
  private schemaVersion: number;
  private externalVersion: number;
  private watcher?: FSWatcher;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private writeTail: Promise<void> = Promise.resolve();
  private pendingAsyncWrites = 0;
  private externalInvalidationPending = false;

  constructor(readonly databasePath: string, readonly schema: StoreSchema, options: { watchExternal?: boolean } = {}) {
    this.database = new Database(databasePath, { create: false, strict: true });
    this.probe = new Database(databasePath, { readonly: true, strict: true });
    this.database.exec("pragma foreign_keys = on");
    this.database.exec("create table if not exists __arbor_runtime_state (key text primary key, value integer not null)");
    this.database.query("insert or ignore into __arbor_runtime_state(key, value) values ('store_cursor', 0)").run();
    this.database.exec("create table if not exists __arbor_mutation_receipts (scope text not null, subject text not null, mutation_id text not null, request_digest text not null, handle_json text not null, input_json text not null, mutation_now text not null, observed_through text not null, result_json text not null, primary key(scope, subject, mutation_id))");
    this.database.exec("create temp table __arbor_changes (sequence integer primary key autoincrement, collection text not null, operation text not null, before_json text, after_json text)");
    for (const relation of Object.values(schema.relations).filter((value) => value.source === "sqlite")) {
      const table = identifier(relation.name);
      const prefix = `__arbor_${relation.name.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
      this.database.exec(`create temp trigger ${identifier(`${prefix}_insert`)} after insert on ${table} begin insert into __arbor_changes(collection, operation, before_json, after_json) values (${literal(relation.name)}, 'insert', null, ${jsonObject("new", relation)}); end`);
      this.database.exec(`create temp trigger ${identifier(`${prefix}_update`)} after update on ${table} begin insert into __arbor_changes(collection, operation, before_json, after_json) values (${literal(relation.name)}, 'update', ${jsonObject("old", relation)}, ${jsonObject("new", relation)}); end`);
      this.database.exec(`create temp trigger ${identifier(`${prefix}_delete`)} after delete on ${table} begin insert into __arbor_changes(collection, operation, before_json, after_json) values (${literal(relation.name)}, 'delete', ${jsonObject("old", relation)}, null); end`);
    }
    this.sequence = Number((this.database.query("select value from __arbor_runtime_state where key = 'store_cursor'").get() as { value: number }).value);
    this.schemaVersion = pragmaNumber(this.database, "schema_version");
    this.externalVersion = pragmaNumber(this.probe, "data_version");
    if (options.watchExternal !== false) {
      const filename = basename(databasePath);
      this.watcher = watch(dirname(databasePath), (_event, changed) => {
        if (changed && !String(changed).startsWith(filename)) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => void this.checkExternalChanges(), 15);
      });
      this.watcher.unref();
    }
  }

  currentCursor(): string {
    return `sqlite:${this.sequence}`;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transaction<Result>(body: (database: Database) => Result): Result {
    if (this.pendingAsyncWrites > 0) throw new Error("An asynchronous SQLite write is already queued");
    this.database.exec("delete from __arbor_changes");
    this.database.exec("begin immediate");
    let result: Result;
    let rows: LoggedChange[];
    let cursor: string | undefined;
    let nextSchemaVersion: number;
    try {
      result = body(this.database);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("SQLiteStoreBroker.transaction callbacks must be synchronous");
      }
      rows = this.database.query("select collection, operation, before_json, after_json from __arbor_changes order by sequence").all() as typeof rows;
      nextSchemaVersion = pragmaNumber(this.database, "schema_version");
      if (rows.length > 0 || nextSchemaVersion !== this.schemaVersion) cursor = this.reserveCursor();
      this.database.exec("commit");
    } catch (error) {
      try { this.database.exec("rollback"); } catch {}
      throw error;
    }
    this.afterCommit(rows, nextSchemaVersion!, cursor);
    return result;
  }

  async transactionAsync<Result>(
    body: (database: Database, control: SQLiteTransactionControl) => Result | Promise<Result>,
  ): Promise<{ result: Result; observedThrough: string }> {
    this.pendingAsyncWrites += 1;
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let reserved: string | undefined;
    let began = false;
    const control: SQLiteTransactionControl = {
      reserveCursor: () => reserved ??= this.reserveCursor(),
    };
    try {
      this.database.exec("delete from __arbor_changes");
      this.database.exec("begin immediate");
      began = true;
      const result = await body(this.database, control);
      const rows = this.database.query("select collection, operation, before_json, after_json from __arbor_changes order by sequence").all() as LoggedChange[];
      const nextSchemaVersion = pragmaNumber(this.database, "schema_version");
      if ((rows.length > 0 || nextSchemaVersion !== this.schemaVersion) && !reserved) reserved = this.reserveCursor();
      this.database.exec("commit");
      this.afterCommit(rows, nextSchemaVersion, reserved);
      return { result, observedThrough: reserved ?? this.currentCursor() };
    } catch (error) {
      if (began) try { this.database.exec("rollback"); } catch {}
      throw error;
    } finally {
      this.pendingAsyncWrites -= 1;
      release();
    }
  }

  /** Deterministic hook for tests and the fallback used by the WAL watcher. */
  checkExternalChanges(): boolean {
    const version = pragmaNumber(this.probe, "data_version");
    if (version === this.externalVersion) return false;
    if (this.pendingAsyncWrites > 0) {
      this.externalInvalidationPending = true;
      void this.writeTail.then(() => this.checkExternalChanges());
      return false;
    }
    this.database.exec("begin immediate");
    let cursor: string;
    try {
      cursor = this.reserveCursor();
      this.database.exec("commit");
    } catch (error) {
      try { this.database.exec("rollback"); } catch {}
      throw error;
    }
    this.sequence = Number(cursor.slice("sqlite:".length));
    this.externalInvalidationPending = false;
    this.externalVersion = pragmaNumber(this.probe, "data_version");
    this.publish({ cursor, precision: "store", reason: "external" });
    return true;
  }

  private reserveCursor(): string {
    const row = this.database.query("update __arbor_runtime_state set value = value + 1 where key = 'store_cursor' returning value")
      .get() as { value: number } | null;
    if (!row) throw new Error("The SQLite store cursor is unavailable");
    return `sqlite:${row.value}`;
  }

  private afterCommit(rows: LoggedChange[], nextSchemaVersion: number, cursor: string | undefined): void {
    if (!this.externalInvalidationPending) this.externalVersion = pragmaNumber(this.probe, "data_version");
    if (!cursor) return;
    this.sequence = Number(cursor.slice("sqlite:".length));
    if (nextSchemaVersion !== this.schemaVersion) {
      this.schemaVersion = nextSchemaVersion;
      this.publish({ cursor, precision: "schema", schemaVersion: nextSchemaVersion });
    } else {
      this.publish({ cursor, precision: "rows", changes: coalesceRowChanges(this.schema, rows) });
    }
  }

  private publish(change: SQLiteStoreChange): void {
    for (const listener of [...this.listeners]) {
      try { listener(change); }
      catch (error) { console.error("Arbor SQLite change listener failed", error); }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.listeners.clear();
    this.probe.close();
    this.database.close();
  }
}
