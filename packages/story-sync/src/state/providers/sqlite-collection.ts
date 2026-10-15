import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  compareUTF8,
  stableKeyFromProperties,
  type CollectionTablesDescriptor,
  type JSONValue,
  type ObjectHash,
  type ProtocolDirectory,
} from "@ovst/protocol";
import {
  canonicalTableText,
  collectionFileRows,
  sharedCollectionSchemaCache,
  type CollectionSchema,
  type CollectionSchemaCache,
} from "@ovst/collection-schema";
import { compileUsl, layoutOf, setupSql } from "@ovst/usl";
import { sqliteBackend } from "@ovst/usl/verify";

/** The folder's database, and the files SQLite keeps beside it. */
export const DATABASE_FILE = "_store.sqlite3";
export const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, `${DATABASE_FILE}-journal`];

type Row = Record<string, JSONValue>;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A stored SQLite value as the row's JSON value: flags as booleans, value
 * arrays from their JSON text. Null is absent. */
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

function readTable(database: Database, schema: CollectionSchema): Array<{ stableKey: string; properties: Row }> {
  const columns = schema.columns.map(quote).join(", ");
  return (database.query(`select ${columns} from ${quote(schema.model)}`).all() as Array<Record<string, unknown>>).map((raw) => {
    const properties: Row = {};
    for (const column of schema.columns) {
      const value = fromSQLite(schema, column, raw[column]);
      if (value !== undefined) properties[column] = value;
    }
    const stableKey = stableKeyFromProperties(schema.primaryKey, properties);
    if (!stableKey) throw new Error(`A row of ${schema.model} has no valid key`);
    return { stableKey, properties };
  });
}

/**
 * The tree form of a folder's `_store.sqlite3` (spec 06 §2.1): one canonical
 * JSONL file per table of the schema's database layout, under a
 * `collection-tables` descriptor with `store: "sqlite"`. Null when the
 * database does not implement the schema or a row is invalid, so the folder
 * keeps the database as an ordinary file.
 */
export async function describeDatabaseCollection(
  directory: string,
  schemaBytes: Uint8Array,
  schemas: CollectionSchemaCache = sharedCollectionSchemaCache,
): Promise<{ descriptor: CollectionTablesDescriptor; files: Array<{ name: string; bytes: Uint8Array }> } | null> {
  const path = join(directory, DATABASE_FILE);
  try {
    const set = schemas.compileTables(schemaBytes, "database");
    const checked = compileUsl(new TextDecoder().decode(schemaBytes));
    const diagnostics = await sqliteBackend.verify(layoutOf(checked, { store: "database" }), path);
    if (diagnostics.some((d) => d.severity === "error")) return null;
    const database = new Database(path, { readonly: true });
    try {
      const files: Array<{ name: string; bytes: Uint8Array }> = [];
      const tables: CollectionTablesDescriptor["tables"] = [];
      for (const schema of [...set.tables].sort((a, b) => compareUTF8(a.model, b.model))) {
        const bytes = new TextEncoder().encode(canonicalTableText(schema, readTable(database, schema)));
        const source = `${schema.model}.jsonl`;
        tables.push({ table: schema.model, source, childSetHash: collectionFileRows("jsonl", bytes, schema).childSetHash });
        files.push({ name: source, bytes });
      }
      return {
        descriptor: { version: 1, type: "collection-tables", format: "jsonl", schemaSource: "schema.usl", schemaFingerprint: set.revision, tables, store: "sqlite" },
        files,
      };
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/**
 * Make the folder's `_store.sqlite3` hold exactly the rows of an accepted
 * database collection, creating it from the schema's setup SQL when it is
 * missing. Rows already equal are left untouched; the rest are deleted,
 * inserted or updated in one transaction.
 */
export async function writeDatabaseCollection(
  directory: string,
  object: ProtocolDirectory,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  schemas: CollectionSchemaCache = sharedCollectionSchemaCache,
): Promise<void> {
  const descriptor = object.childrenSource;
  if (descriptor?.type !== "collection-tables" || descriptor.store !== "sqlite") throw new Error("Not a database collection");
  const file = (name: string) => {
    const hash = object.entries.find((entry) => entry.name === name)?.file;
    if (!hash) throw new Error(`The database collection has no ${name}`);
    return load(hash as ObjectHash);
  };
  const schemaBytes = await file(descriptor.schemaSource);
  const set = schemas.compileTables(schemaBytes, "database");
  const path = join(directory, DATABASE_FILE);
  const created = !existsSync(path);
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec("pragma busy_timeout = 5000");
    if (created) database.exec(setupSql(layoutOf(compileUsl(new TextDecoder().decode(schemaBytes)), { store: "database" }), "sqlite"));
    const wanted = new Map<CollectionSchema, Map<string, Row>>();
    for (const table of descriptor.tables) {
      const schema = set.tables.find((t) => t.model === table.table);
      if (!schema) throw new Error(`schema.usl stores no table ${table.table}`);
      const rows = collectionFileRows("jsonl", await file(table.source), schema).rows;
      wanted.set(schema, new Map(rows.map((row) => [row.stableKey, row.properties])));
    }
    database.transaction(() => {
      for (const [schema, rows] of wanted) {
        const present = new Map(readTable(database, schema).map((row) => [row.stableKey, row.properties]));
        const where = schema.primaryKey.map((column) => `${quote(column)} = ?`).join(" and ");
        const key = (row: Row) => schema.primaryKey.map((column) => toSQLite(row[column]));
        const remove = database.prepare(`delete from ${quote(schema.model)} where ${where}`);
        const insert = database.prepare(`insert into ${quote(schema.model)} (${schema.columns.map(quote).join(", ")}) values (${schema.columns.map(() => "?").join(", ")})`);
        const update = database.prepare(`update ${quote(schema.model)} set ${schema.columns.map((c) => `${quote(c)} = ?`).join(", ")} where ${where}`);
        for (const [stableKey, row] of present) if (!rows.has(stableKey)) remove.run(...key(row));
        for (const [stableKey, row] of rows) {
          const values = schema.columns.map((column) => toSQLite(row[column]));
          const before = present.get(stableKey);
          if (!before) insert.run(...values);
          else if (canonicalTableText(schema, [{ stableKey, properties: before }]) !== canonicalTableText(schema, [{ stableKey, properties: row }]))
            update.run(...values, ...key(before));
        }
      }
    })();
  } finally {
    database.close();
  }
}
