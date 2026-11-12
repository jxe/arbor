// A placement's projection of a folder's logical collection (spec 06 §2.4):
// files of one format, or a SQLite database. Reading is tolerant, so any valid
// edit becomes changed rows against the state last applied to the folder;
// writing is minimal, so only changed rows are written.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  compareUTF8,
  hashObject as hashBytes,
  logicalRowKey,
  stableJSONString,
  stableKeyFromProperties,
  type JSONValue,
  type LogicalRow,
  type ObjectHash,
  type ProtocolDirectory,
  collectionSchemaName,
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
  sqliteRow,
  toSQLite,
  type CollectionFileFormat,
  type CollectionSchema,
  type CollectionState,
  type CollectionSchemaCache,
  type LogicalSchema,
} from "@ovst/collection-schema";
import { layoutOf, logicalFromRows, rowsFromLogical, setupSql, type LogicalTables, type RowsByTable, type Table } from "@ovst/usl";
import type { SnapshotCollection } from "@ovst/fs";

/**
 * A collection's schema file from before schema.beetle. Trees were converted on the
 * Protocol 003 flag day, so one left in a folder beside the converted schema.beetle
 * is never published, and writing the collection removes it.
 */
const LEFTOVER_SCHEMA = "schema.usl";

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

/**
 * The folder's collection as last applied to it: its rows, which unchanged rows keep their
 * times from, and the log state a change to them is appended to (collections §1).
 */
export interface CollectionBasis {
  tables: LogicalTables;
  fingerprint?: string;
  state?: CollectionState;
}
export type CollectionBasisSource = (directory: string) => Promise<CollectionBasis | null>;

export interface CollectionProjectionOptions {
  schemas?: CollectionSchemaCache;
  /** The folder's rows as last applied to it, which unchanged rows keep their times from. */
  basis?: CollectionBasisSource;
  /** The form a collection created from nothing takes. Canonical JSONL by default. */
  form?: (directory: string) => CollectionProjectionForm | undefined;
  /** The time a changed row gets. */
  now?: () => string;
  /** Where SQLite projections' bases are kept: private placement state. A temporary folder by default. */
  baseDirectory?: string;
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

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** A stored row without its absent members. */
const withoutAbsent = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) as Row;

/**
 * A SQLite projection's base (placements on disk §5): a private database in the same
 * layout holding exactly the rows Story Sync last applied, so another program's committed
 * edits are the rows the two differ in, found in SQL with no triggers in the projection.
 */
const BASE_META = "_story_base";
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
/** Tables and triggers an earlier Story Sync installed in projections to log edits. */
const LEGACY_LOG = /^_overstory_/;

/** Read every row of each table, by key tuple. */
function readAll(database: Database, tables: readonly CollectionSchema[], schemaName = "main"): Map<string, Map<string, Row>> {
  return new Map(tables.map((schema) => {
    const columns = schema.columns.map(quote).join(", ");
    const rows = (database.query(`select ${columns} from ${schemaName}.${quote(schema.model)}`).all() as Array<Record<string, unknown>>).map((raw) => sqliteRow(schema, raw));
    return [schema.model, new Map(rows.map((row) => [keyTuple(schema, row), row]))];
  }));
}

/** A row's key values as SQLite holds them. */
const keyTuple = (schema: CollectionSchema, row: Row) => JSON.stringify(schema.primaryKey.map((column) => toSQLite(row[column])));

/** The rows of `tables` that `rows` differs from `before` in: removed, inserted, updated. */
interface Change { model: string; primaryKey: readonly string[]; columns: readonly string[]; remove: Row[]; insert: Row[]; update: Array<[Row, Row]> }
function changesTo(tables: readonly CollectionSchema[], layout: readonly Table[], before: Map<string, Map<string, Row>> | null, wanted: RowsByTable): Change[] {
  const changes: Change[] = [];
  for (const schema of tables) {
    // A connection row's times aren't logical, so they change only with the row.
    const join = !!layout.find((t) => t.name === schema.model)?.ends;
    const same = (a: Row, b: Row) => join
      ? comparable({ ...a, created: null, modified: null }) === comparable({ ...b, created: null, modified: null })
      : comparable(a) === comparable(b);
    const keyOf = (row: Row) => stableKeyFromProperties(schema.primaryKey, row)!;
    const rows = new Map((wanted[schema.model] ?? []).map(withoutAbsent).map((row) => [keyOf(row), row]));
    const present = new Map([...(before?.get(schema.model)?.values() ?? [])].map((row) => [keyOf(row), row]));
    const change: Change = { model: schema.model, primaryKey: schema.primaryKey, columns: schema.columns, remove: [], insert: [], update: [] };
    for (const [stableKey, row] of present) if (!rows.has(stableKey)) change.remove.push(row);
    for (const [stableKey, row] of rows) {
      const was = present.get(stableKey);
      if (!was) change.insert.push(row);
      else if (!same(was, row)) change.update.push([was, row]);
    }
    if (change.remove.length || change.insert.length || change.update.length) changes.push(change);
  }
  return changes;
}

/** Apply changes in the caller's transaction, and to `rows`, the in-memory copy of what the database holds. */
function applyChanges(database: Database, tables: readonly CollectionSchema[], changes: readonly Change[], rows: Map<string, Map<string, Row>>): void {
  for (const change of changes) {
    const schema = tables.find((table) => table.model === change.model)!;
    const where = change.primaryKey.map((column) => `${quote(column)} = ?`).join(" and ");
    const key = (row: Row) => change.primaryKey.map((column) => toSQLite(row[column]));
    const values = (row: Row) => change.columns.map((column) => toSQLite(row[column]));
    const remove = database.prepare(`delete from ${quote(change.model)} where ${where}`);
    const insert = database.prepare(`insert into ${quote(change.model)} (${change.columns.map(quote).join(", ")}) values (${change.columns.map(() => "?").join(", ")})`);
    const update = database.prepare(`update ${quote(change.model)} set ${change.columns.map((c) => `${quote(c)} = ?`).join(", ")} where ${where}`);
    for (const row of change.remove) remove.run(...key(row));
    for (const row of change.insert) insert.run(...values(row));
    for (const [before, row] of change.update) update.run(...values(row), ...key(before));
    const byKey = rows.get(change.model) ?? new Map<string, Row>();
    rows.set(change.model, byKey);
    for (const row of change.remove) byKey.delete(keyTuple(schema, row));
    for (const [before] of change.update) byKey.delete(keyTuple(schema, before));
    for (const row of [...change.insert, ...change.update.map(([, row]) => row)]) byKey.set(keyTuple(schema, row), row);
  }
}

/** The database's rows as Story Sync last read or wrote them. */
interface DatabaseState {
  file: string;
  rows: Map<string, Map<string, Row>>;
}

/** A row the schema can't read stops the projection from being read until it is fixed, so no other row is lost with it. */
class UnreadableRow extends Error {}

/**
 * What a read of the folder's projection depends on: the schema, and each
 * projection file's identity, size and change times (a SQLite database's
 * journal and WAL included), or null when a file can't be stated.
 */
function filesStamp(directory: string, names: readonly string[], schemaBytes: Uint8Array): string | null {
  const parts = [hashBytes(schemaBytes)];
  for (const name of names) {
    try {
      const stat = statSync(join(directory, name), { bigint: true });
      parts.push(`${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      parts.push(`${name}:-`);
    }
  }
  return parts.join("\n");
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
  private readonly last = new Map<string, CollectionBasis>();
  private readonly databases = new Map<string, DatabaseState>();
  /** Each folder's base rows, as its base file holds them. */
  private readonly bases = new Map<string, Map<string, Map<string, Row>>>();
  private readonly resolving = new Set<string>();
  /** Each folder's last read, by the stamp of the files it read. */
  private readonly reads = new Map<string, { stamp: string; tables: LogicalTables; result: Omit<SnapshotCollection, "objects">; objects: Uint8Array[] }>();

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
      for (const [model, byKey] of this.readDatabase(directory, set.tables, hashBytes(schemaBytes)).rows) rows[model] = [...byKey.values()];
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
  private stamp(read: LogicalTables, before: LogicalTables | null, now: number): LogicalTables {
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
   * ordinary files. A folder with only `schema.beetle` holds no rows yet.
   * `basis` stands in for the configured one, as for a first placement
   * whose rows should keep the host's times.
   */
  async read(directory: string, fileNames: readonly string[], basis = this.options.basis): Promise<SnapshotCollection | null> {
    let compiled;
    let schemaBytes: Uint8Array;
    try {
      schemaBytes = new Uint8Array(await readFile(join(directory, collectionSchemaName(fileNames) ?? "schema.beetle")));
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
    let held = this.last.get(directory) ?? null;
    if (!held && basis && !this.resolving.has(directory)) {
      this.resolving.add(directory);
      try { held = await basis(directory); } finally { this.resolving.delete(directory); }
    }
    const before = held?.tables ?? null;
    // Unchanged files read as the rows they read as last time, without
    // decoding and encoding every row again on each scan.
    const stamp = form ? filesStamp(directory, formFiles(form, form.kind === "sqlite" ? database : files), schemaBytes) : null;
    const cached = this.reads.get(directory);
    if (stamp && cached?.stamp === stamp && cached.tables === before) return { ...cached.result, objects: cached.objects };
    const nowOption = this.options.now?.();
    const now = nowOption === undefined ? Date.now() : Date.parse(nowOption);
    let tables: LogicalTables | null;
    try {
      const layout = form?.kind === "sqlite" ? database : files;
      const rows = form ? await this.readRows(directory, form, layout, schemaBytes) : {};
      tables = this.stamp(logicalFromRows(logical.result, layout, rows, { now }), before, now);
      if (checkLogicalTables(logical, tables).length) throw new UnreadableRow("The rows don't satisfy the collection's schema");
      const projected = new Set(form ? formFiles(form, layout) : []);
      checkCollectionNames(fileNames.filter((name) => !projected.has(name)), logical, tables);
    } catch {
      // Until the projection reads again the folder keeps the rows it had.
      tables = before && !checkLogicalTables(logical, before).length ? before : null;
    }
    if (!tables) return null;
    const encoded = encodeCollection(logical, tables, held?.state && held.fingerprint === logical.fingerprint ? held.state : null);
    this.last.set(directory, { tables, fingerprint: logical.fingerprint, state: encoded.state });
    const result = {
      collection: encoded.reference,
      replaces: [
        ...(form ? formFiles(form, form.kind === "sqlite" ? database : files).filter((name) => fileNames.includes(name)) : []),
        ...(fileNames.includes(LEFTOVER_SCHEMA) ? [LEFTOVER_SCHEMA] : []),
      ],
    };
    const objects = [...encoded.objects.values()];
    if (stamp) this.reads.set(directory, { stamp, tables, result, objects });
    else this.reads.delete(directory);
    return { ...result, objects };
  }

  /**
   * Write an accepted collection into the folder's projection: the form its
   * files are in, or the placement's choice for a new one. Only changed rows
   * are written. Returns the files that hold the projection.
   */
  async write(directory: string, object: ProtocolDirectory, load: Load): Promise<readonly string[]> {
    const collection = await loadDirectoryCollection(object, load, this.schemas);
    if (!collection) return [];
    this.reads.delete(directory);
    const schemaName = collectionSchemaName(object.entries.map((e) => e.name));
    const schemaBytes = await load(object.entries.find((e) => e.name === schemaName)!.file!);
    const { files, database } = this.compile(schemaBytes);
    const detected = detectForm(existsSync(directory) ? await readdir(directory) : [], files);
    const form = detected && detected !== "mixed" ? detected : this.options.form?.(directory) ?? { kind: "files", format: "jsonl" } as const;
    if (detected === "mixed") throw new Error(`${directory} holds more than one projection of its collection`);
    if (form.kind === "sqlite") await this.writeSQLite(directory, database, schemaBytes, rowsFromLogical(collection.schema.result, database, collection.tables));
    else await this.writeFiles(directory, form.format, files, schemaBytes, rowsFromLogical(collection.schema.result, files, collection.tables));
    this.last.set(directory, { tables: collection.tables, fingerprint: collection.schema.fingerprint, state: collection.state });
    await rm(join(directory, LEFTOVER_SCHEMA), { force: true });
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

  /** Where the folder's base is kept. */
  private basePath(directory: string): string {
    const name = hashBytes(new TextEncoder().encode(resolve(directory))).slice(7, 39);
    return join(this.options.baseDirectory ?? join(tmpdir(), "story-sync-bases"), `${name}.sqlite3`);
  }

  /** The folder's base, when it holds the rows of this schema. */
  private base(directory: string, schemaHash: string): string | null {
    const path = this.basePath(directory);
    if (!existsSync(path)) return null;
    try {
      const database = new Database(path, { readonly: true });
      try {
        const meta = database.query(`select schema from ${BASE_META}`).get() as { schema: string } | null;
        if (meta?.schema === schemaHash) return path;
      } finally {
        database.close();
      }
    } catch {}
    this.bases.delete(directory);
    return null;
  }

  /**
   * The database's rows. With a base, they are the base's rows with the rows the
   * database differs from it in reread, found in SQL; without one every table is read.
   */
  private readDatabase(directory: string, tables: readonly CollectionSchema[], schemaHash: string): DatabaseState {
    const path = join(directory, DATABASE_FILE);
    const file = fileIdentity(path);
    const base = this.base(directory, schemaHash);
    const database = new Database(path, { readonly: true });
    let rows: Map<string, Map<string, Row>>;
    try {
      if (base) database.exec(`attach database ${literal(base)} as base`);
      database.exec("begin");
      try {
        if (!base) rows = readAll(database, tables);
        else {
          let applied = this.bases.get(directory);
          if (!applied) this.bases.set(directory, (applied = readAll(database, tables, "base")));
          rows = new Map([...applied].map(([model, byKey]) => [model, new Map(byKey)]));
          for (const schema of tables) {
            const byKey = rows.get(schema.model) ?? new Map<string, Row>();
            rows.set(schema.model, byKey);
            const columns = schema.columns.map(quote).join(", "), keys = schema.primaryKey.map(quote).join(", ");
            const table = quote(schema.model);
            const gone = database.query(`select ${keys} from base.${table} except select ${keys} from main.${table}`).all() as Array<Record<string, unknown>>;
            for (const raw of gone) byKey.delete(JSON.stringify(schema.primaryKey.map((column) => raw[column] ?? null)));
            const changed = database.query(`select ${columns} from main.${table} except select ${columns} from base.${table}`).all() as Array<Record<string, unknown>>;
            for (const raw of changed) {
              const row = sqliteRow(schema, raw);
              byKey.set(keyTuple(schema, row), row);
            }
          }
        }
      } finally {
        database.exec("commit");
      }
    } finally {
      database.close();
    }
    const state = { file, rows: rows! };
    this.databases.set(directory, state);
    return state;
  }

  /**
   * Make the database hold the accepted rows, creating it from the schema's setup SQL when
   * missing, in one transaction, and make the base hold them too. A row another program
   * changed since the last scan is an edit not yet published, and is left for the next scan.
   */
  private async writeSQLite(directory: string, tables: Table[], schemaBytes: Uint8Array, wanted: RowsByTable): Promise<void> {
    const set = this.schemas.compileTables(schemaBytes, "database");
    const schemaHash = hashBytes(schemaBytes);
    const path = join(directory, DATABASE_FILE);
    const created = !existsSync(path);
    // Work out the changes read-only first, so a database that already holds
    // the rows is never opened for writing (which would touch its files).
    const scanned = this.databases.get(directory);
    const current = created ? null : this.readDatabase(directory, set.tables, schemaHash);
    const changes = changesTo(set.tables, tables, current?.rows ?? null, wanted);
    if (current && scanned?.file === current.file) {
      const edited = (model: string, key: string) => {
        const was = scanned.rows.get(model)?.get(key), is = current.rows.get(model)?.get(key);
        return (was ? comparable(was) : null) !== (is ? comparable(is) : null);
      };
      for (const change of changes) {
        const schema = set.tables.find((table) => table.model === change.model)!;
        const kept = (row: Row) => !edited(change.model, keyTuple(schema, row));
        change.remove = change.remove.filter(kept);
        change.insert = change.insert.filter(kept);
        change.update = change.update.filter(([before, row]) => kept(before) && kept(row));
      }
    }
    const legacy = !created && this.hasLegacyLog(path);
    if (created || changes.length || legacy) {
      const database = new Database(path, { create: true, strict: true });
      try {
        database.exec("pragma busy_timeout = 5000");
        const rows = current?.rows ?? new Map<string, Map<string, Row>>(set.tables.map((schema) => [schema.model, new Map()]));
        database.transaction(() => {
          if (created) database.exec(setupSql(tables, "sqlite"));
          if (legacy) this.dropLegacyLog(database);
          applyChanges(database, set.tables, changes, rows);
        }).immediate();
        this.databases.set(directory, { file: fileIdentity(path), rows });
      } finally {
        database.close();
      }
    }
    this.writeBase(directory, set.tables, tables, schemaHash, wanted);
  }

  /** Make the folder's base hold `wanted`, the rows just applied. */
  private writeBase(directory: string, schemas: readonly CollectionSchema[], tables: Table[], schemaHash: string, wanted: RowsByTable): void {
    const path = this.basePath(directory);
    const existing = this.base(directory, schemaHash);
    const before = existing ? this.bases.get(directory) ?? null : null;
    if (!existing) rmSync(path, { force: true });
    mkdirSync(dirname(path), { recursive: true });
    const database = new Database(path, { create: true, strict: true });
    try {
      // Private and rebuildable: a lost write costs one whole read.
      database.exec("pragma journal_mode = wal");
      database.exec("pragma synchronous = off");
      const rows = before ?? (existing ? readAll(database, schemas) : new Map<string, Map<string, Row>>(schemas.map((schema) => [schema.model, new Map()])));
      const changes = changesTo(schemas, tables, rows, wanted);
      if (existing && !changes.length) { this.bases.set(directory, rows); return; }
      database.transaction(() => {
        if (!existing) {
          database.exec(setupSql(tables, "sqlite"));
          database.exec(`create table ${BASE_META} (schema text not null)`);
          database.query(`insert into ${BASE_META} (schema) values (?)`).run(schemaHash);
        }
        applyChanges(database, schemas, changes, rows);
      }).immediate();
      this.bases.set(directory, rows);
    } finally {
      database.close();
    }
  }

  /** Whether the database still has the change log an earlier Story Sync installed. */
  private hasLegacyLog(path: string): boolean {
    const database = new Database(path, { readonly: true });
    try {
      return (database.query("select name from sqlite_master where type in ('table', 'trigger')").all() as Array<{ name: string }>).some((r) => LEGACY_LOG.test(r.name));
    } finally {
      database.close();
    }
  }

  private dropLegacyLog(database: Database): void {
    const found = database.query("select type, name from sqlite_master where type in ('table', 'trigger')").all() as Array<{ type: string; name: string }>;
    for (const { type, name } of found) if (LEGACY_LOG.test(name)) database.exec(`drop ${type} if exists ${quote(name)}`);
  }
}
