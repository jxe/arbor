// A placement's projection of a folder's logical collection (spec 06 §2.4):
// files of one format, or a SQLite database. Reading is tolerant, so any valid
// edit becomes changed rows against the state last applied to the folder;
// writing is minimal, so only changed rows are written.

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareUTF8,
  logicalRowKey,
  stableJSONString,
  stableKeyFromProperties,
  type JSONValue,
  type LogicalRow,
  type ObjectHash,
  type ProtocolDirectory,
} from "@ovst/protocol";
import { writeAtomic } from "@ovst/protocol/file-ops";
import {
  checkCollectionNames,
  checkLogicalTables,
  collectionFileRows,
  decodeCollectionFileSource,
  encodeCollection,
  encodeCsvRows,
  loadDirectoryCollection,
  sharedCollectionSchemaCache,
  spliceCollectionFile,
  type CollectionFileFormat,
  type CollectionSchema,
  type CollectionSchemaCache,
  type LogicalSchema,
} from "@ovst/collection-schema";
import { layoutOf, logicalFromRows, rowsFromLogical, setupSql, type LogicalTables, type RowsByTable, type Table } from "@ovst/usl";
import type { SnapshotCollection } from "@ovst/fs";

/** The folder's database, and the files SQLite keeps beside it. */
export const DATABASE_FILE = "_store.sqlite3";
export const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, `${DATABASE_FILE}-journal`];
const FORMATS = ["csv", "json", "jsonl"] as const satisfies readonly CollectionFileFormat[];

/** How a placement projects one collection. */
export type CollectionProjectionForm =
  /** `_store.<format>` for a one-table file layout, else `<Table>.<format>` per table. */
  | { kind: "files"; format: CollectionFileFormat }
  | { kind: "sqlite" };

type Row = Record<string, JSONValue>;
type Load = (hash: ObjectHash) => Promise<Uint8Array>;

export interface CollectionProjectionOptions {
  schemas?: CollectionSchemaCache;
  /** The folder's rows as last applied to it, which unchanged rows keep their times from. */
  basis?: (directory: string) => Promise<LogicalTables | null>;
  /** The form a collection created from nothing takes. Canonical JSONL by default. */
  form?: (directory: string) => CollectionProjectionForm | undefined;
  /** The time a changed row gets. */
  now?: () => string;
}

/** The files a form keeps the folder's rows in. */
function formFiles(form: CollectionProjectionForm, tables: readonly Table[]): string[] {
  if (form.kind === "sqlite") return DATABASE_FILES;
  return tables.length === 1 ? [`_store.${form.format}`] : tables.map((t) => `${t.name}.${form.format}`);
}

/** The form the folder's files are in, null for none, or "mixed" when it holds more than one. */
function detectForm(fileNames: readonly string[], tables: readonly Table[]): CollectionProjectionForm | null | "mixed" {
  const forms: CollectionProjectionForm[] = [];
  if (fileNames.includes(DATABASE_FILE)) forms.push({ kind: "sqlite" });
  for (const format of FORMATS) {
    const store = fileNames.includes(`_store.${format}`);
    const perTable = tables.length > 1 && tables.some((t) => fileNames.includes(`${t.name}.${format}`));
    if (store || perTable) forms.push({ kind: "files", format });
  }
  if (forms.length > 1) return "mixed";
  const form = forms[0];
  // A one-table layout keeps its rows in `_store.*`; a several-table layout can't.
  if (form?.kind === "files" && fileNames.includes(`_store.${form.format}`) !== (tables.length === 1)) return "mixed";
  return form ?? null;
}

/** A stored SQLite value as the row's JSON value: flags as booleans, value arrays from their JSON text. Null is absent. */
function fromSQLite(schema: CollectionSchema, column: string, value: unknown): JSONValue | undefined {
  if (value === null || value === undefined) return undefined;
  const check = schema.row.byName.get(column)?.check;
  if (check?.kind === "bool" && typeof value === "number") return value !== 0;
  if (check?.kind === "array" && typeof value === "string") return JSON.parse(value) as JSONValue;
  if (typeof value === "bigint") return Number(value);
  return value as JSONValue;
}

function toSQLite(value: JSONValue | undefined): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** A stored row without its absent members. */
const withoutAbsent = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) as Row;

/**
 * Story Sync's change log in a database it projects: triggers it installs on
 * each table record the key of every row any program inserts, updates or
 * deletes, so a scan rereads only those rows. `_overstory_sync` holds a
 * nonce that tells this database's log from a copy's. A database without the
 * log, or with a trigger gone, is read whole.
 */
const CHANGES = "_overstory_changes";
const SYNC = "_overstory_sync";
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const triggerName = (model: string, event: string) => `_overstory_${model}_${event}`;
const EVENTS = ["insert", "update", "delete"] as const;

function changeLogSql(tables: readonly CollectionSchema[], nonce: string): string {
  const statements = [
    `create table if not exists ${CHANGES} (id integer primary key autoincrement, model text not null, key text not null)`,
    `create table if not exists ${SYNC} (nonce text not null)`,
    `delete from ${SYNC}`,
    `insert into ${SYNC} (nonce) values (${literal(nonce)})`,
  ];
  for (const table of tables) {
    const key = (side: "new" | "old") => `json_array(${table.primaryKey.map((column) => `${side}.${quote(column)}`).join(", ")})`;
    const log = (side: "new" | "old") => `insert into ${CHANGES} (model, key) values (${literal(table.model)}, ${key(side)});`;
    const body = { insert: log("new"), update: `${log("old")} ${log("new")}`, delete: log("old") };
    for (const event of EVENTS) {
      statements.push(`drop trigger if exists ${quote(triggerName(table.model, event))}`);
      statements.push(`create trigger ${quote(triggerName(table.model, event))} after ${event} on ${quote(table.model)} begin ${body[event]} end`);
    }
  }
  return statements.map((statement) => `${statement};`).join("\n");
}

/** The log's nonce, when the database has its log and every trigger. */
function changeLogNonce(database: Database, tables: readonly CollectionSchema[]): string | null {
  const names = new Set((database.query("select name from sqlite_master where type in ('table', 'trigger')").all() as Array<{ name: string }>).map((r) => r.name));
  if (!names.has(CHANGES) || !names.has(SYNC)) return null;
  if (!tables.every((table) => EVENTS.every((event) => names.has(triggerName(table.model, event))))) return null;
  return (database.query(`select nonce from ${SYNC}`).get() as { nonce: string } | null)?.nonce ?? null;
}

const lastChange = (database: Database) => (database.query(`select coalesce(max(id), 0) as id from ${CHANGES}`).get() as { id: number }).id;

/** A row's key values as the change log's triggers write them. */
const keyTuple = (schema: CollectionSchema, row: Row) => JSON.stringify(schema.primaryKey.map((column) => toSQLite(row[column])));

/** The database's rows as Story Sync last read or wrote them, and how far into its change log that was. */
interface DatabaseState {
  file: string;
  nonce: string;
  cursor: number;
  rows: Map<string, Map<string, Row>>;
}

/** A row the schema can't read stops the projection from being read until it is fixed, so no other row is lost with it. */
class UnreadableRow extends Error {}

function sqliteRow(schema: CollectionSchema, raw: Record<string, unknown>): Row {
  const row: Row = {};
  for (const column of schema.columns) {
    const value = fromSQLite(schema, column, raw[column]);
    if (value !== undefined) row[column] = value;
  }
  return row;
}

function readSQLiteTable(database: Database, schema: CollectionSchema): Row[] {
  const columns = schema.columns.map(quote).join(", ");
  return (database.query(`select ${columns} from ${quote(schema.model)}`).all() as Array<Record<string, unknown>>).map((raw) => sqliteRow(schema, raw));
}

function fileIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}`;
}

/** A stored row as a projection compares it: time columns at the logical form's precision. */
function comparable(row: Row): string {
  const out: Row = {};
  for (const [name, value] of Object.entries(row)) {
    if (value === null) continue;
    out[name] = (name === "created" || name === "modified") && typeof value === "string" && !Number.isNaN(Date.parse(value))
      ? new Date(Date.parse(value)).toISOString()
      : value;
  }
  return stableJSONString(out);
}

const sameFields = (a: LogicalRow, b: LogicalRow) => stableJSONString(a.fields) === stableJSONString(b.fields);

/**
 * Story Sync's collection projections. One instance remembers the rows it
 * last read or wrote for each folder, so a folder that hasn't changed reads
 * as the same rows, with the same times.
 */
export class CollectionProjections {
  private readonly schemas: CollectionSchemaCache;
  private readonly last = new Map<string, LogicalTables>();
  private readonly databases = new Map<string, DatabaseState>();
  private readonly resolving = new Set<string>();

  constructor(private readonly options: CollectionProjectionOptions = {}) {
    this.schemas = options.schemas ?? sharedCollectionSchemaCache;
  }

  private compile(schemaBytes: Uint8Array): { logical: LogicalSchema; files: Table[]; database: Table[] } {
    const logical = this.schemas.compileLogical(schemaBytes);
    return { logical, files: layoutOf(logical.result, { store: "files" }), database: layoutOf(logical.result, { store: "database" }) };
  }

  /** The rows a form's files hold, by table, with rows the schema can't read left out. */
  private async readRows(directory: string, form: CollectionProjectionForm, tables: Table[], schemaBytes: Uint8Array): Promise<RowsByTable> {
    const rows: RowsByTable = {};
    if (form.kind === "sqlite") {
      const set = this.schemas.compileTables(schemaBytes, "database");
      for (const [model, byKey] of this.readDatabase(directory, set.tables).rows) rows[model] = [...byKey.values()];
      return rows;
    }
    const set = this.schemas.compileTables(schemaBytes, "files");
    for (const [index, name] of formFiles(form, tables).entries()) {
      const schema = set.tables.find((t) => t.model === tables[index]!.name)!;
      const text = await readFile(join(directory, name), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const decoded = decodeCollectionFileSource(form.format, text, name, schema);
      const problem = [...decoded.diagnostics, ...decoded.rows.flatMap((row) => row.diagnostics)].find((d) => d.severity === "error");
      if (problem) throw new UnreadableRow(`${name}: ${problem.message}`);
      rows[schema.model] = decoded.rows.map((row) => row.values as Row);
    }
    return rows;
  }

  /**
   * Times for rows read from a projection: a row whose fields are unchanged
   * from the folder's last state keeps that state's times; a changed one
   * keeps its `created` and is modified now; a new one is created now unless
   * the projection stored its times.
   */
  private stamp(read: LogicalTables, before: LogicalTables | null, now: string): LogicalTables {
    const out: LogicalTables = {};
    for (const [model, rows] of Object.entries(read)) {
      const prior = new Map((before?.[model] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow]));
      out[model] = rows.map((row) => {
        const was = prior.get(logicalRowKey(row));
        if (!was) return row;
        if (sameFields(was, row as LogicalRow)) return { ...row, created: was.created, modified: was.modified };
        return { ...row, created: was.created, modified: row.modified !== was.modified && row.modified !== now ? row.modified : now };
      });
    }
    return out;
  }

  /**
   * The folder's collection as its projection holds it, or null when the
   * folder is not a collection Story Sync can read, so its files sync as
   * ordinary files. A folder with only `schema.usl` holds no rows yet.
   * `basis` stands in for the configured one, as for a first placement
   * whose rows should keep the host's times.
   */
  async read(directory: string, fileNames: readonly string[], basis = this.options.basis): Promise<SnapshotCollection | null> {
    let compiled;
    let schemaBytes: Uint8Array;
    try {
      schemaBytes = new Uint8Array(await readFile(join(directory, "schema.usl")));
      compiled = this.compile(schemaBytes);
    } catch {
      return null;
    }
    const { logical, files, database } = compiled;
    if (!files.length) return null;
    const form = detectForm(fileNames, files);
    if (form === "mixed") return null;
    // Finding the basis can read the folder's objects back, which can describe
    // this folder again: that inner read goes without a basis.
    let before = this.last.get(directory) ?? null;
    if (!before && basis && !this.resolving.has(directory)) {
      this.resolving.add(directory);
      try { before = await basis(directory); } finally { this.resolving.delete(directory); }
    }
    const now = this.options.now?.() ?? new Date().toISOString();
    let tables: LogicalTables | null;
    try {
      const layout = form?.kind === "sqlite" ? database : files;
      const rows = form ? await this.readRows(directory, form, layout, schemaBytes) : {};
      tables = this.stamp(logicalFromRows(logical.result, layout, rows, { now }), before, now);
      if (checkLogicalTables(logical, tables).length) throw new UnreadableRow("The rows don't satisfy schema.usl");
      const projected = new Set(form ? formFiles(form, layout) : []);
      checkCollectionNames(fileNames.filter((name) => !projected.has(name)), logical, tables);
    } catch {
      // Until the projection reads again the folder keeps the rows it had.
      tables = before && !checkLogicalTables(logical, before).length ? before : null;
    }
    if (!tables) return null;
    const encoded = encodeCollection(logical, tables);
    this.last.set(directory, tables);
    return {
      collection: encoded.reference,
      objects: encoded.objects.values(),
      replaces: form ? formFiles(form, form.kind === "sqlite" ? database : files).filter((name) => fileNames.includes(name)) : [],
    };
  }

  /**
   * Write an accepted collection into the folder's projection: the form its
   * files are in, or the placement's choice for a new one. Only changed rows
   * are written. Returns the files that hold the projection.
   */
  async write(directory: string, object: ProtocolDirectory, load: Load): Promise<readonly string[]> {
    const collection = await loadDirectoryCollection(object, load, this.schemas);
    if (!collection) return [];
    const schemaBytes = await load(object.entries.find((e) => e.name === "schema.usl")!.file!);
    const { files, database } = this.compile(schemaBytes);
    const detected = detectForm(existsSync(directory) ? await readdir(directory) : [], files);
    const form = detected && detected !== "mixed" ? detected : this.options.form?.(directory) ?? { kind: "files", format: "jsonl" } as const;
    if (detected === "mixed") throw new Error(`${directory} holds more than one projection of its collection`);
    if (form.kind === "sqlite") await this.writeSQLite(directory, database, schemaBytes, rowsFromLogical(collection.schema.result, database, collection.tables));
    else await this.writeFiles(directory, form.format, files, schemaBytes, rowsFromLogical(collection.schema.result, files, collection.tables));
    this.last.set(directory, collection.tables);
    return formFiles(form, form.kind === "sqlite" ? database : files);
  }

  private async writeFiles(directory: string, format: CollectionFileFormat, tables: Table[], schemaBytes: Uint8Array, wanted: RowsByTable): Promise<void> {
    const set = this.schemas.compileTables(schemaBytes, "files");
    for (const [index, name] of formFiles({ kind: "files", format }, tables).entries()) {
      const schema = set.tables.find((t) => t.model === tables[index]!.name)!;
      const path = join(directory, name);
      const rows = (wanted[schema.model] ?? []).map(withoutAbsent);
      const keyed = new Map(rows.map((row) => [stableKeyFromProperties(schema.primaryKey, row)!, row]));
      const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      let text: string;
      let current: ReturnType<typeof collectionFileRows> | null = null;
      try {
        current = existing === null ? null : collectionFileRows(format, new TextEncoder().encode(existing), schema);
      } catch {
        current = null;
      }
      if (existing === null || !current) {
        // Canonical form: rows in stable-key order, columns in layout order.
        const ordered = [...keyed].sort(([a], [b]) => compareUTF8(a, b)).map(([, row]) => row);
        text = format === "csv" ? encodeCsvRows(schema, ordered)
          : format === "json" ? JSON.stringify(ordered)
          : ordered.map((row) => `${JSON.stringify(row)}\n`).join("");
      } else {
        // A file that doesn't store row times keeps not storing them: the
        // tree holds them, and reading the file back keeps them (`stamp`).
        if (!current.rows.some((row) => Object.hasOwn(row.properties, "created") || Object.hasOwn(row.properties, "modified"))) {
          for (const row of keyed.values()) { delete row.created; delete row.modified; }
        }
        const replaced = new Map<string, Row | null>();
        const seen = new Set<string>();
        for (const row of current.rows) {
          seen.add(row.stableKey);
          const next = keyed.get(row.stableKey);
          if (!next) replaced.set(row.sourceKey, null);
          // A stored value that reads back as the wanted one is left as stored.
          else if (comparable(row.properties) !== comparable(next)) replaced.set(row.sourceKey, next);
        }
        const appended = [...keyed].filter(([key]) => !seen.has(key)).sort(([a], [b]) => compareUTF8(a, b)).map(([, row]) => row);
        if (!replaced.size && !appended.length) continue;
        text = spliceCollectionFile(format, existing, schema, { replaced, appended });
      }
      if (text !== existing) await writeAtomic(path, new TextEncoder().encode(text));
    }
  }

  /**
   * The database's rows. With its change log, and a state from this database
   * and log, only the rows changed since are reread; otherwise every table is
   * read, after installing the log so later scans needn't. A database Story
   * Sync can't write is read whole each time.
   */
  private readDatabase(directory: string, tables: readonly CollectionSchema[]): DatabaseState {
    const path = join(directory, DATABASE_FILE);
    const file = fileIdentity(path);
    const known = this.databases.get(directory);
    const database = new Database(path, { readonly: true });
    let state: DatabaseState | null = null;
    try {
      database.exec("begin");
      try {
        const nonce = changeLogNonce(database, tables);
        if (nonce && known && known.file === file && known.nonce === nonce) {
          state = { ...known, rows: new Map([...known.rows].map(([model, rows]) => [model, new Map(rows)])) };
          const changes = database.query(`select id, model, key from ${CHANGES} where id > ? order by id`).all(known.cursor) as Array<{ id: number; model: string; key: string }>;
          const reread = new Set<string>();
          for (const change of changes) {
            state.cursor = change.id;
            const schema = tables.find((table) => table.model === change.model);
            const key = JSON.stringify(JSON.parse(change.key));
            if (!schema || reread.has(`${change.model}\0${key}`)) continue;
            reread.add(`${change.model}\0${key}`);
            const where = schema.primaryKey.map((column) => `${quote(column)} = ?`).join(" and ");
            const raw = database.query(`select ${schema.columns.map(quote).join(", ")} from ${quote(schema.model)} where ${where}`)
              .get(...(JSON.parse(key) as Array<string | number | null>)) as Record<string, unknown> | null;
            const byKey = state.rows.get(schema.model) ?? new Map<string, Row>();
            state.rows.set(schema.model, byKey);
            if (raw) byKey.set(key, sqliteRow(schema, raw));
            else byKey.delete(key);
          }
        } else if (nonce) {
          state = { file, nonce, cursor: lastChange(database), rows: new Map(tables.map((schema) => [schema.model, new Map(readSQLiteTable(database, schema).map((row) => [keyTuple(schema, row), row]))])) };
        }
      } finally {
        database.exec("commit");
      }
    } finally {
      database.close();
    }
    if (!state) state = this.installChangeLog(path, file, tables);
    if (state.nonce) this.databases.set(directory, state);
    return state;
  }

  /** Install the change log and read every table in one transaction, so no edit falls between them. */
  private installChangeLog(path: string, file: string, tables: readonly CollectionSchema[]): DatabaseState {
    const readAll = (database: Database) => new Map(tables.map((schema) => [schema.model, new Map(readSQLiteTable(database, schema).map((row) => [keyTuple(schema, row), row]))]));
    let database: Database;
    try {
      database = new Database(path, { readwrite: true, strict: true });
    } catch {
      const reader = new Database(path, { readonly: true });
      try { return { file, nonce: "", cursor: 0, rows: readAll(reader) }; } finally { reader.close(); }
    }
    try {
      database.exec("pragma busy_timeout = 5000");
      const nonce = crypto.randomUUID();
      return database.transaction(() => {
        database.exec(changeLogSql(tables, nonce));
        return { file, nonce, cursor: lastChange(database), rows: readAll(database) };
      }).immediate();
    } catch {
      return { file, nonce: "", cursor: 0, rows: readAll(database) };
    } finally {
      database.close();
    }
  }

  /** Make the database hold exactly the rows, creating it from the schema's setup SQL when missing, in one transaction. */
  private async writeSQLite(directory: string, tables: Table[], schemaBytes: Uint8Array, wanted: RowsByTable): Promise<void> {
    const set = this.schemas.compileTables(schemaBytes, "database");
    const path = join(directory, DATABASE_FILE);
    const created = !existsSync(path);
    type Change = { model: string; primaryKey: readonly string[]; columns: readonly string[]; remove: Row[]; insert: Row[]; update: Array<[Row, Row]> };
    // Work out the changes read-only first, so a database that already holds
    // the rows is never opened for writing (which would touch its files).
    const changes: Change[] = [];
    // Rows another program changed since the last scan are edits not yet
    // published; the accepted write leaves them for the next scan to publish.
    const scanned = this.databases.get(directory);
    const current = created ? null : this.readDatabase(directory, set.tables);
    {
      for (const schema of set.tables) {
        // A connection row's times aren't logical, so they change only with the row.
        const join = !!tables.find((t) => t.name === schema.model)?.ends;
        const same = (a: Row, b: Row) => join
          ? comparable({ ...a, created: null, modified: null }) === comparable({ ...b, created: null, modified: null })
          : comparable(a) === comparable(b);
        const keyOf = (row: Row) => stableKeyFromProperties(schema.primaryKey, row)!;
        const rows = new Map((wanted[schema.model] ?? []).map(withoutAbsent).map((row) => [keyOf(row), row]));
        const present = new Map([...(current?.rows.get(schema.model)?.values() ?? [])].map((row) => [keyOf(row), row]));
        const change: Change = { model: schema.model, primaryKey: schema.primaryKey, columns: schema.columns, remove: [], insert: [], update: [] };
        for (const [stableKey, row] of present) if (!rows.has(stableKey)) change.remove.push(row);
        for (const [stableKey, row] of rows) {
          const before = present.get(stableKey);
          if (!before) change.insert.push(row);
          else if (!same(before, row)) change.update.push([before, row]);
        }
        if (change.remove.length || change.insert.length || change.update.length) changes.push(change);
      }
    }
    if (!created && !changes.length) return;
    const database = new Database(path, { create: true, strict: true });
    try {
      database.exec("pragma busy_timeout = 5000");
      if (created) database.exec(setupSql(tables, "sqlite"));
      const nonce = current?.nonce || crypto.randomUUID();
      database.transaction(() => {
        // Story Sync's own writes aren't edits to read back: the log keeps only
        // what other programs changed, including any since `current` was read.
        if (!current?.nonce) database.exec(changeLogSql(set.tables, nonce));
        const mark = lastChange(database);
        if (current?.nonce && scanned?.nonce === current.nonce) {
          const edited = new Set((database.query(`select model, key from ${CHANGES} where id > ? and id <= ?`).all(scanned.cursor, mark) as Array<{ model: string; key: string }>)
            .map((change) => `${change.model}\0${JSON.stringify(JSON.parse(change.key))}`));
          for (const change of changes) {
            const schema = set.tables.find((table) => table.model === change.model)!;
            const kept = (row: Row) => !edited.has(`${change.model}\0${keyTuple(schema, row)}`);
            change.remove = change.remove.filter(kept);
            change.insert = change.insert.filter(kept);
            change.update = change.update.filter(([before, row]) => kept(before) && kept(row));
          }
        }
        for (const change of changes) {
          const where = change.primaryKey.map((column) => `${quote(column)} = ?`).join(" and ");
          const key = (row: Row) => change.primaryKey.map((column) => toSQLite(row[column]));
          const values = (row: Row) => change.columns.map((column) => toSQLite(row[column]));
          const remove = database.prepare(`delete from ${quote(change.model)} where ${where}`);
          const insert = database.prepare(`insert into ${quote(change.model)} (${change.columns.map(quote).join(", ")}) values (${change.columns.map(() => "?").join(", ")})`);
          const update = database.prepare(`update ${quote(change.model)} set ${change.columns.map((c) => `${quote(c)} = ?`).join(", ")} where ${where}`);
          for (const row of change.remove) remove.run(...key(row));
          for (const row of change.insert) insert.run(...values(row));
          for (const [before, row] of change.update) update.run(...values(row), ...key(before));
        }
        database.query(`delete from ${CHANGES} where id > ?`).run(mark);
        if (current?.nonce) database.query(`delete from ${CHANGES} where id <= ?`).run(current.cursor);
      }).immediate();
      const state: DatabaseState = current?.nonce
        ? current
        : { file: fileIdentity(path), nonce, cursor: 0, rows: new Map(set.tables.map((schema) => [schema.model, new Map()])) };
      for (const change of changes) {
        const schema = set.tables.find((table) => table.model === change.model)!;
        const byKey = state.rows.get(change.model) ?? new Map<string, Row>();
        state.rows.set(change.model, byKey);
        for (const row of change.remove) byKey.delete(keyTuple(schema, row));
        for (const [before] of change.update) byKey.delete(keyTuple(schema, before));
        for (const row of [...change.insert, ...change.update.map(([, row]) => row)]) byKey.set(keyTuple(schema, row), row);
      }
      if (!current?.nonce) state.cursor = lastChange(database);
      this.databases.set(directory, state);
    } finally {
      database.close();
    }
  }
}
