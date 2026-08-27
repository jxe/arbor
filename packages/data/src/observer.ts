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

  constructor(readonly databasePath: string, readonly schema: StoreSchema, options: { watchExternal?: boolean } = {}) {
    this.database = new Database(databasePath, { create: false, strict: true });
    this.probe = new Database(databasePath, { readonly: true, strict: true });
    this.database.exec("pragma foreign_keys = on");
    this.database.exec("create temp table __arbor_changes (sequence integer primary key autoincrement, collection text not null, operation text not null, before_json text, after_json text)");
    for (const relation of Object.values(schema.relations).filter((value) => value.source === "sqlite")) {
      const table = identifier(relation.name);
      const prefix = `__arbor_${relation.name.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
      this.database.exec(`create temp trigger ${identifier(`${prefix}_insert`)} after insert on ${table} begin insert into __arbor_changes(collection, operation, before_json, after_json) values (${literal(relation.name)}, 'insert', null, ${jsonObject("new", relation)}); end`);
      this.database.exec(`create temp trigger ${identifier(`${prefix}_update`)} after update on ${table} begin insert into __arbor_changes(collection, operation, before_json, after_json) values (${literal(relation.name)}, 'update', ${jsonObject("old", relation)}, ${jsonObject("new", relation)}); end`);
      this.database.exec(`create temp trigger ${identifier(`${prefix}_delete`)} after delete on ${table} begin insert into __arbor_changes(collection, operation, before_json, after_json) values (${literal(relation.name)}, 'delete', ${jsonObject("old", relation)}, null); end`);
    }
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
    this.database.exec("delete from __arbor_changes");
    this.database.exec("begin immediate");
    let result: Result;
    let rows: Array<{ collection: string; operation: SQLiteChangeOperation; before_json: string | null; after_json: string | null }>;
    try {
      result = body(this.database);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("SQLiteStoreBroker.transaction callbacks must be synchronous");
      }
      rows = this.database.query("select collection, operation, before_json, after_json from __arbor_changes order by sequence").all() as typeof rows;
      this.database.exec("commit");
    } catch (error) {
      try { this.database.exec("rollback"); } catch {}
      throw error;
    }
    this.externalVersion = pragmaNumber(this.probe, "data_version");
    const nextSchemaVersion = pragmaNumber(this.database, "schema_version");
    if (nextSchemaVersion !== this.schemaVersion) {
      this.schemaVersion = nextSchemaVersion;
      this.publish({ cursor: this.nextCursor(), precision: "schema", schemaVersion: nextSchemaVersion });
    } else if (rows.length > 0) {
      this.publish({ cursor: this.nextCursor(), precision: "rows", changes: rows.map((row) => rowChange(this.schema, row)) });
    }
    return result;
  }

  /** Deterministic hook for tests and the fallback used by the WAL watcher. */
  checkExternalChanges(): boolean {
    const version = pragmaNumber(this.probe, "data_version");
    if (version === this.externalVersion) return false;
    this.externalVersion = version;
    this.publish({ cursor: this.nextCursor(), precision: "store", reason: "external" });
    return true;
  }

  private nextCursor(): string {
    this.sequence += 1;
    return this.currentCursor();
  }

  private publish(change: SQLiteStoreChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.listeners.clear();
    this.probe.close();
    this.database.close();
  }
}
