// A directory's logical collection as the tree holds it (spec 06 §2.1): its
// `schema.usl` entry, its `collection` reference, and the rows that reference
// reaches, named as the folder's logical children.

import {
  compareUTF8,
  logicalRowKey,
  type CollectionReference,
  type Hash,
  type JSONValue,
  type LogicalRow,
  type ObjectHash,
  type ProtocolDirectory,
} from "@ovst/protocol";
import type { LogicalModel, LogicalTables } from "@ovst/usl";
import { sharedCollectionSchemaCache, type CollectionSchemaCache } from "./cache.ts";
import { CollectionSchemaError, COLLECTION_SCHEMA_SOURCE } from "./diagnostics.ts";
import { encodeCollection, loadCollection, LogicalCollectionError, type LogicalSchema } from "./logical.ts";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/** Why a collection directory is invalid: its schema, a constraint on its rows, or a malformed object. */
export class ProtocolCollectionError extends Error {
  constructor(
    readonly kind: "schema" | "constraint" | "source",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolCollectionError";
  }
}

/** One row, as a logical child of its folder (the main model) or of its model's node. */
export interface CollectionRowNode {
  model: string;
  /** Its logical name: the `path` field's value, else derived from its key. */
  name: string;
  /** Its canonical key JSON (spec 03 §2). */
  stableKey: string;
  row: LogicalRow;
}

export interface DirectoryCollection {
  schema: LogicalSchema;
  reference: CollectionReference;
  logicalHash: Hash;
  tables: LogicalTables;
  /** The model whose rows are the folder's own children, if any. */
  main: string | null;
  /** Each model's rows in stable-key order, named. */
  rows: Map<string, CollectionRowNode[]>;
}

const RESERVED_PREFIX = "~row-";

function validName(value: string): boolean {
  return value.length > 0 && value === value.normalize("NFC") && value !== "." && value !== ".."
    && !/[\\/\0]/.test(value) && !value.startsWith(RESERVED_PREFIX) && !value.toLowerCase().endsWith(".md");
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * A row's logical name (spec 06 §1.2, §2.2): its `path` field's value, which
 * must be a valid name; else its single string key when that is one; else
 * `~row-` and the base64url of its canonical key JSON.
 */
export function collectionRowName(model: Pick<LogicalModel, "name" | "path">, row: Pick<LogicalRow, "key" | "fields">): string {
  if (model.path) {
    const value = row.fields[model.path] ?? row.key.find(([name]) => name === model.path)?.[1];
    if (typeof value !== "string" || !validName(value)) {
      throw new ProtocolCollectionError("constraint", `${model.name} row ${logicalRowKey(row)}: its ${model.path} is not a valid logical name`);
    }
    return value;
  }
  const only = row.key.length === 1 ? row.key[0]![1] : null;
  return typeof only === "string" && validName(only) ? only : `${RESERVED_PREFIX}${base64url(logicalRowKey(row))}`;
}

/** A row's values as one record: its key fields, its fields, `created` and `modified`. */
export function collectionRowProperties(row: LogicalRow): Record<string, JSONValue> {
  return { ...Object.fromEntries(row.key), ...row.fields, created: row.created, modified: row.modified };
}

/** The logical names a directory's own entries take: `_index.md` is the body, and `x.md` is `x`. */
function entryNames(directory: ProtocolDirectory): Set<string> {
  return logicalEntryNames(directory.entries.map((entry) => entry.name));
}

function logicalEntryNames(names: Iterable<string>): Set<string> {
  return new Set([...names].flatMap((name) => name === "_index.md" ? [] : [name.endsWith(".md") ? name.slice(0, -3) : name]));
}

/** Require rows to name distinct children beside a folder's entries, as a
 * host will on accepting them. Throws {@link ProtocolCollectionError}. */
export function checkCollectionNames(entries: Iterable<string>, schema: LogicalSchema, tables: LogicalTables): void {
  nameRows(logicalEntryNames(entries), schema, tables);
}

function schemaFailure(error: unknown): never {
  if (error instanceof CollectionSchemaError) throw new ProtocolCollectionError("schema", `Invalid schema.usl: ${error.message}`);
  throw error;
}

/** The compiled `schema.usl` entry of a collection directory. */
export async function directoryCollectionSchema(directory: ProtocolDirectory, load: Load, schemas: CollectionSchemaCache = sharedCollectionSchemaCache): Promise<LogicalSchema> {
  const entry = directory.entries.find((e) => e.name === COLLECTION_SCHEMA_SOURCE)?.file;
  if (!entry) throw new ProtocolCollectionError("schema", "A collection's schema.usl must be a file entry");
  try {
    return schemas.compileLogical(await load(entry));
  } catch (error) {
    return schemaFailure(error);
  }
}

/** Name every row, and require the folder's children to have distinct names. */
function nameRows(entries: ReadonlySet<string>, schema: LogicalSchema, tables: LogicalTables): Pick<DirectoryCollection, "main" | "rows"> {
  const main = schema.result.models.find((m) => m.main)?.name ?? null;
  const rows = new Map<string, CollectionRowNode[]>();
  const taken = new Set(entries);
  for (const model of schema.models) {
    if (model.name !== main && taken.has(model.name)) throw new ProtocolCollectionError("constraint", `The folder has both an entry and a model named ${model.name}`);
    if (model.name !== main) taken.add(model.name);
  }
  for (const model of schema.models) {
    const names = model.name === main ? taken : new Set<string>();
    rows.set(model.name, (tables[model.name] ?? []).map((row) => {
      const name = collectionRowName(model, row);
      if (names.has(name)) throw new ProtocolCollectionError("constraint", `Two children of ${model.name === main ? "the folder" : model.name} are named ${name}`);
      names.add(name);
      return { model: model.name, name, stableKey: logicalRowKey(row), row: row as LogicalRow };
    }));
  }
  return { main, rows };
}

/**
 * Load and validate a directory's collection (spec 06 §2.1 steps 1–4), or
 * null for a plain directory. `load` returns verified object bytes. Throws
 * {@link ProtocolCollectionError}.
 */
export async function loadDirectoryCollection(
  directory: ProtocolDirectory,
  load: Load,
  schemas: CollectionSchemaCache = sharedCollectionSchemaCache,
): Promise<DirectoryCollection | null> {
  if (!directory.collection) return null;
  const schema = await directoryCollectionSchema(directory, load, schemas);
  let loaded;
  try {
    loaded = await loadCollection(schema, directory.collection, load);
  } catch (error) {
    if (error instanceof LogicalCollectionError) throw new ProtocolCollectionError("constraint", error.message);
    if (error instanceof TypeError) throw new ProtocolCollectionError("source", error.message);
    throw error;
  }
  return { schema, ...loaded, ...nameRows(entryNames(directory), schema, loaded.tables) };
}

/**
 * The directory with its collection set to `tables`, and every object that
 * holds them. The directory's entries must already hold its `schema.usl`.
 * Throws {@link ProtocolCollectionError} for rows the schema rejects.
 */
export async function encodeDirectoryCollection(
  directory: ProtocolDirectory,
  tables: LogicalTables,
  load: Load,
  schemas: CollectionSchemaCache = sharedCollectionSchemaCache,
): Promise<{ directory: ProtocolDirectory; objects: Map<ObjectHash, Uint8Array> }> {
  const schema = await directoryCollectionSchema(directory, load, schemas);
  let encoded;
  try {
    encoded = encodeCollection(schema, tables);
  } catch (error) {
    if (error instanceof LogicalCollectionError) throw new ProtocolCollectionError("constraint", error.message);
    if (error instanceof TypeError) throw new ProtocolCollectionError("constraint", error.message);
    throw error;
  }
  nameRows(entryNames(directory), schema, Object.fromEntries(Object.entries(tables).map(([model, rows]) => [model, [...rows].sort((a, b) => compareUTF8(logicalRowKey(a), logicalRowKey(b)))])));
  return { directory: { ...directory, collection: encoded.reference }, objects: encoded.objects as Map<ObjectHash, Uint8Array> };
}

