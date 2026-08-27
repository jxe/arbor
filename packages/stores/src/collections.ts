import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { parse } from "csv-parse";
import { parseDocument } from "yaml";
import type { ChildrenPage, Diagnostic, Hash, JSONValue, NodeRef, NodeSnapshot, NodeSummary, TreeRef } from "@arbor/core";
import type { CollectionBacking, CollectionRow, CollectionSummary } from "@arbor/core/internal";
import { canonicalJSONString, parseCanonicalStableKey, revisionOf, rowPathSegment, sha256, stableKeyFromProperties } from "@arbor/core";
import { introspectSQLiteDatabase, introspectStoreSchema, type FieldMetadata, type StoreSchema } from "@arbor/data";
import { parseMarkdown } from "@arbor/editor";
import { ConnectionStore, connectionName } from "./connections.ts";
import { SchemaSandbox, type SchemaDescription } from "./schema.ts";

interface CollectionDefinition {
  backing: CollectionBacking;
  schemaPath?: string;
  storePath?: string;
  markdownPaths?: string[];
  diagnostics: Diagnostic[];
}

interface LoadedCollection {
  description: SchemaDescription;
  rows: CollectionRow[];
  revision: string;
  modelDigest: string;
  diagnostics: Diagnostic[];
  identityRule?: { properties: string[] };
  editable: boolean;
}

interface LoadedCollectionSlice {
  path: string;
  backing: CollectionBacking;
  columns: string[];
  identityRule?: { properties: string[] };
  revision: string;
  schemaRevision: string;
  rows: CollectionRow[];
  nextCursor: string | null;
  diagnostics: Diagnostic[];
  editable: boolean;
}

export interface ChildProviderContext {
  tree: TreeRef;
  observedThrough: string;
  writable: boolean;
  readPhysical?: (path: string) => Promise<NodeSnapshot>;
}

export interface CollectionWriteTarget {
  directory: string;
  parentPath: string;
  backing: CollectionBacking;
  table?: string;
  path: string;
  stableKey: string | null;
  revision: string;
  properties: Record<string, JSONValue>;
  identityRule?: { properties: string[] };
  writable: boolean;
}

interface LoadedSQLiteTable {
  columns: string[];
  rows: CollectionRow[];
  revision: string;
  modelDigest: string;
  diagnostics: Diagnostic[];
  identityRule?: { properties: string[] };
}

interface LoadedSQLiteStore {
  schema: StoreSchema;
  tables: Record<string, LoadedSQLiteTable>;
  schemaVersion: number;
  revision: string;
  modelDigest: string;
}

interface StoredCursor {
  version: 1;
  query: string;
  revision: string;
  mode: "keyset" | "offset";
  after?: string;
  offset?: number;
}

export class CollectionCursorError extends Error {}

export class CollectionPropertyConflictError extends Error {
  constructor(public current: CollectionRow) {
    super("The row properties changed since they were read");
  }
}

export class CollectionMutationMismatchError extends Error {}
export class CollectionPropertyWriteError extends Error {}

function jsonValue(value: unknown): JSONValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: JSONValue[] = [];
    for (const item of value) {
      const converted = jsonValue(item);
      if (converted !== undefined) result.push(converted);
    }
    return result;
  }
  if (value && typeof value === "object") {
    const result: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonValue(item);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }
  return undefined;
}

function digest(value: unknown): Hash {
  return `sha256:${sha256(canonicalJSONString(value))}`;
}

function rowSummary(
  row: CollectionRow,
  page: LoadedCollectionSlice,
  parentPath: string,
  tree: TreeRef,
  writable: boolean,
): NodeSummary {
  const properties = (jsonValue(row.values) ?? {}) as Record<string, JSONValue>;
  const revision = row.revision ?? digest({ key: row.key, properties });
  const editable = page.editable && (!page.identityRule || row.stableKey !== null) && writable;
  return {
    ref: {
      tree,
      path: `${parentPath === "/" ? "" : parentPath}/${row.path}`,
      stableKey: row.stableKey,
    },
    name: typeof properties.title === "string" ? properties.title
      : typeof properties.name === "string" ? properties.name
      : typeof properties.slug === "string" ? properties.slug
      : row.path,
    revision,
    properties,
    capabilities: {
      properties: {
        revision,
        schema: page.schemaRevision as Hash,
        writable: editable,
      },
      ...(page.backing === "markdown" ? {
        content: {
          revision,
          mediaType: "text/markdown",
          format: "markdown" as const,
          writable: editable,
        },
      } : {}),
    },
    materialization: "available",
    diagnostics: row.diagnostics,
  };
}

function sqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlitePropertyValue(field: FieldMetadata, value: unknown): unknown {
  if (value === null) return null;
  if (field.type === "boolean") return Boolean(value);
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function sqliteWriteValue(field: FieldMetadata, value: JSONValue): string | number | bigint | boolean | Uint8Array | null {
  if (value === null) return null;
  if (field.type === "string") {
    if (typeof value !== "string") throw new CollectionPropertyWriteError(`${field.name} must be a string`);
    return value;
  }
  if (field.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return BigInt(value);
    throw new CollectionPropertyWriteError(`${field.name} must be a finite number or exact integer string`);
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new CollectionPropertyWriteError(`${field.name} must be a boolean`);
    return value ? 1 : 0;
  }
  if (field.type === "bytes") {
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 1 || typeof value.$bytes !== "string") {
      throw new CollectionPropertyWriteError(`${field.name} must be a {$bytes: base64} value`);
    }
    return new Uint8Array(Buffer.from(value.$bytes, "base64"));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new CollectionPropertyWriteError(`${field.name} cannot be bound to this SQLite column`);
}

function sqliteRow(
  schema: StoreSchema,
  relation: StoreSchema["relations"][string],
  raw: Record<string, unknown>,
): CollectionRow {
  const columns = Object.keys(relation.fields);
  const values = Object.fromEntries(columns.map((column) => [column, sqlitePropertyValue(relation.fields[column]!, raw[column])])) as Record<string, JSONValue>;
  const stableKey = stableKeyFromProperties(relation.primaryKey, values);
  if (!stableKey) throw new CollectionPropertyWriteError(`SQLite row does not have a valid ${relation.primaryKey.join(", ")} stable key`);
  return {
    key: stableKey,
    path: rowPathSegment(stableKey),
    stableKey,
    revision: revisionOf(canonicalJSONString({ schema: schema.fingerprint, relation: relation.name, values })),
    values,
    diagnostics: [],
  };
}

function encodeCursor(value: StoredCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string | null, query: string, revision: string, mode: StoredCursor["mode"]): StoredCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<StoredCursor>;
    if (value.version !== 1 || value.query !== query || value.revision !== revision || value.mode !== mode) throw new Error();
    if (mode === "keyset" && typeof value.after !== "string") throw new Error();
    if (mode === "offset" && (!Number.isSafeInteger(value.offset) || value.offset! < 0)) throw new Error();
    return value as StoredCursor;
  } catch {
    throw new CollectionCursorError("The collection cursor is invalid or belongs to another revision");
  }
}

export async function detectCollection(directory: string): Promise<CollectionDefinition | null> {
  const names = await readdir(directory);
  const schemaPath = names.includes("schema.ts") ? join(directory, "schema.ts") : undefined;
  const stores = ["_store.csv", "_store.json", "_store.jsonl", "_store.sqlite3", "_store.postgres"].filter((name) => names.includes(name));
  const markdownPaths = schemaPath
    ? names.filter((name) => name.endsWith(".md") && name !== "_index.md").map((name) => join(directory, name))
    : [];
  if (!schemaPath && stores.length === 0) return null;
  const diagnostics: Diagnostic[] = [];
  const shapes = stores.length + (markdownPaths.length ? 1 : 0);
  if (shapes > 1) diagnostics.push({
    code: "mixed-collection-backing",
    message: "A collection must use exactly one of _store.csv, _store.json, _store.jsonl, _store.sqlite3, _store.postgres, or Markdown records.",
    path: directory,
    severity: "error",
  });
  if (stores[0] === "_store.postgres") return { backing: "postgres", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.csv") return { backing: "csv", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.json") return { backing: "json", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.jsonl") return { backing: "jsonl", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.sqlite3") return { backing: "sqlite", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  return { backing: "markdown", markdownPaths, schemaPath, diagnostics };
}

export class CollectionStore {
  constructor(
    private schemas = new SchemaSandbox(),
    private connections = new ConnectionStore(),
  ) {}

  async summary(directory: string): Promise<CollectionSummary | null> {
    const definition = await detectCollection(directory);
    if (!definition) return null;
    if (definition.diagnostics.some((item) => item.severity === "error")) {
      return {
        backing: definition.backing,
        columns: [],
        revision: revisionOf(JSON.stringify(definition.diagnostics)),
        schemaRevision: revisionOf("invalid-collection-schema"),
        diagnostics: definition.diagnostics,
        editable: false,
      };
    }
    if (definition.backing === "postgres") {
      const postgres = await this.postgresReference(definition.storePath!);
      const connection = await this.connections.get(connectionName(postgres.connection));
      if (!connection) return { backing: "postgres", columns: [], editable: false, tables: [] };
      const sql = new Bun.SQL(connection.dsn);
      try {
        const rows = await sql`select table_name from information_schema.tables where table_schema = ${postgres.schema} and table_type = 'BASE TABLE' order by table_name`;
        return { backing: "postgres", columns: [], editable: false, tables: rows.map((row: Record<string, unknown>) => String(row.table_name)) };
      } finally { await sql.close(); }
    }
    if (definition.backing === "sqlite") {
      const loaded = await this.loadSQLiteStore(definition);
      return {
        backing: "sqlite",
        columns: [],
        revision: loaded.revision,
        schemaRevision: loaded.schema.fingerprint,
        modelDigest: loaded.modelDigest,
        diagnostics: definition.diagnostics,
        editable: false,
        rollupScope: "subtree",
        total: Object.keys(loaded.tables).length,
        tables: Object.keys(loaded.tables).sort(),
      };
    }
    const loaded = await this.loadFileCollection(definition);
    return {
      backing: definition.backing,
      columns: loaded.description.columns,
      ...(loaded.identityRule ? { identityRule: loaded.identityRule } : {}),
      revision: loaded.revision,
      schemaRevision: loaded.description.revision,
      modelDigest: loaded.modelDigest,
      diagnostics: loaded.diagnostics,
      total: loaded.rows.length,
      editable: loaded.editable,
    };
  }

  async tableSummary(directory: string, table: string): Promise<CollectionSummary | null> {
    const definition = await detectCollection(directory);
    if (!definition || definition.diagnostics.some((item) => item.severity === "error")) return null;
    if (definition.backing === "sqlite") {
      const loaded = await this.loadSQLiteStore(definition);
      const relation = loaded.tables[table];
      if (!relation) return null;
      return {
        backing: "sqlite",
        columns: relation.columns,
        ...(relation.identityRule ? { identityRule: relation.identityRule } : {}),
        revision: relation.revision,
        schemaRevision: loaded.schema.fingerprint,
        modelDigest: relation.modelDigest,
        diagnostics: relation.diagnostics,
        editable: Boolean(relation.identityRule),
        rollupScope: "children",
        total: relation.rows.length,
      };
    }
    if (definition.backing === "postgres") {
      const summary = await this.summary(directory);
      return summary?.tables?.includes(table) ? { ...summary, tables: undefined } : null;
    }
    return null;
  }

  async postgresSchema(directory: string): Promise<Record<string, Record<string, string>>> {
    const definition = await detectCollection(directory);
    if (!definition || definition.backing !== "postgres") return {};
    const reference = await this.postgresReference(definition.storePath!);
    const connection = await this.connections.get(connectionName(reference.connection));
    if (!connection) throw new Error(`Connection ${reference.connection} is unavailable`);
    const sql = new Bun.SQL(connection.dsn);
    try {
      const rows = await sql`
        select table_name, column_name, data_type, is_nullable
        from information_schema.columns
        where table_schema = ${reference.schema}
        order by table_name, ordinal_position
      ` as Array<Record<string, unknown>>;
      const result: Record<string, Record<string, string>> = {};
      for (const row of rows) {
        const table = String(row.table_name);
        const nullable = String(row.is_nullable) === "YES" ? " | null" : "";
        result[table] ??= {};
        result[table]![String(row.column_name)] = `${postgresType(String(row.data_type))}${nullable}`;
      }
      return result;
    } finally { await sql.close(); }
  }

  async tableSnapshot(
    directory: string,
    treePath: string,
    table: string,
    context: ChildProviderContext,
  ): Promise<NodeSnapshot | null> {
    const summary = await this.tableSummary(directory, table);
    if (!summary) return null;
    const revision = summary.revision ?? `external:${summary.backing}:${table}`;
    const schema = (summary.schemaRevision ?? digest({ columns: summary.columns, identityRule: summary.identityRule })) as Hash;
    const representation = summary.backing === "postgres"
      ? { type: "external" as const, driver: "postgres" }
      : {
        type: "rollup" as const,
        codec: "sqlite" as const,
        scope: "children" as const,
        modelDigest: (summary.modelDigest ?? digest({ columns: summary.columns, identityRule: summary.identityRule })) as Hash,
      };
    return {
      ref: { tree: context.tree, path: treePath, stableKey: null },
      name: table,
      revision,
      properties: {},
      capabilities: {
        children: {
          revision,
          schema,
          representation,
          ...(summary.total === undefined ? {} : { total: summary.total }),
          writable: summary.editable && context.writable,
        },
      },
      materialization: "available",
      diagnostics: summary.diagnostics ?? [],
      observedThrough: context.observedThrough,
    };
  }

  async tableItems(
    directory: string,
    parentPath: string,
    context: ChildProviderContext,
  ): Promise<NodeSummary[]> {
    const summary = await this.summary(directory);
    if (!summary?.tables) return [];
    const snapshots = await Promise.all(summary.tables.map((table) => this.tableSnapshot(
      directory,
      `${parentPath === "/" ? "" : parentPath}/${table}`,
      table,
      context,
    )));
    return snapshots.filter((item): item is NodeSnapshot => item !== null).map(({
      observedThrough: _observedThrough,
      content: _content,
      ...item
    }) => item);
  }

  async children(
    directory: string,
    treePath: string,
    parent: NodeRef,
    context: ChildProviderContext,
    cursor: string | null = null,
    limit = 100,
    table?: string,
  ): Promise<ChildrenPage> {
    const page = await this.loadRows(directory, treePath, cursor, limit, table);
    return {
      parent,
      items: page.rows.map((row) => rowSummary(row, page, treePath, context.tree, context.writable)),
      nextCursor: page.nextCursor,
      observedThrough: context.observedThrough,
    };
  }

  async resolveChild(
    directory: string,
    parentPath: string,
    ref: { path: string; stableKey: string | null },
    context: ChildProviderContext,
    table?: string,
  ): Promise<NodeSnapshot | null> {
    const result = await this.resolveRow(directory, parentPath, ref, table);
    if (!result) return null;
    const summary = rowSummary(result.row, result.page, parentPath, context.tree, context.writable);
    if (result.page.backing !== "markdown") return { ...summary, observedThrough: context.observedThrough };
    if (!context.readPhysical) throw new Error("Markdown child resolution requires a physical node reader");
    const physical = await context.readPhysical(summary.ref.path);
    return {
      ...physical,
      ...summary,
      content: physical.content,
      diagnostics: [...physical.diagnostics, ...summary.diagnostics],
      observedThrough: context.observedThrough,
    };
  }

  async writeTarget(
    directory: string,
    parentPath: string,
    ref: { path: string; stableKey: string | null },
    table?: string,
  ): Promise<CollectionWriteTarget | null> {
    const result = await this.resolveRow(directory, parentPath, ref, table);
    if (!result) return null;
    return {
      directory,
      parentPath,
      backing: result.page.backing,
      ...(table ? { table } : {}),
      path: `${parentPath === "/" ? "" : parentPath}/${result.row.path}`,
      stableKey: result.row.stableKey,
      revision: result.row.revision ?? digest({ key: result.row.key, properties: result.row.values }),
      properties: (jsonValue(result.row.values) ?? {}) as Record<string, JSONValue>,
      ...(result.page.identityRule ? { identityRule: result.page.identityRule } : {}),
      writable: result.page.editable && (!result.page.identityRule || result.row.stableKey !== null),
    };
  }

  private async loadRows(directory: string, treePath: string, cursor: string | null = null, limit = 100, tableName?: string): Promise<LoadedCollectionSlice> {
    const definition = await detectCollection(directory);
    if (!definition) throw new Error(`${treePath} is not a collection`);
    const safeLimit = Math.max(1, Math.min(limit, 500));
    if (definition.diagnostics.some((item) => item.severity === "error")) {
      return { path: treePath, backing: definition.backing, columns: [], rows: [], nextCursor: null, revision: revisionOf(JSON.stringify(definition.diagnostics)), schemaRevision: revisionOf("invalid-collection-schema"), diagnostics: definition.diagnostics, editable: false };
    }
    if (definition.backing === "postgres") {
      const query = `postgres:${treePath}:${tableName ?? ""}`;
      const decoded = decodeCursor(cursor, query, "external:postgres", "offset");
      const offset = decoded?.offset ?? 0;
      const { rows, hasMore } = await this.postgresRows(definition, tableName, offset, safeLimit);
      return {
        path: treePath,
        backing: definition.backing,
        columns: [...new Set(rows.flatMap((row) => Object.keys(row.values)))],
        rows,
        nextCursor: hasMore ? encodeCursor({ version: 1, query, revision: "external:postgres", mode: "offset", offset: offset + rows.length }) : null,
        revision: "external:postgres",
        schemaRevision: revisionOf(JSON.stringify([...new Set(rows.flatMap((row) => Object.keys(row.values)))])),
        diagnostics: definition.diagnostics,
        editable: false,
      };
    }
    if (definition.backing === "sqlite") {
      if (!tableName) throw new Error("A SQLite table is required");
      const loaded = await this.loadSQLiteStore(definition);
      const table = loaded.tables[tableName];
      if (!table) throw new Error(`Unknown SQLite table ${tableName}`);
      const allKeyed = Boolean(table.identityRule) && table.rows.every((row) => row.stableKey !== null);
      const mode = allKeyed ? "keyset" : "offset";
      const query = `sqlite:${treePath}:${tableName}`;
      const decoded = decodeCursor(cursor, query, table.revision, mode);
      const ordered = allKeyed
        ? [...table.rows].sort((left, right) => left.stableKey! < right.stableKey! ? -1 : left.stableKey! > right.stableKey! ? 1 : 0)
        : table.rows;
      const start = mode === "keyset" && decoded
        ? ordered.findIndex((row) => row.stableKey! > decoded.after!)
        : decoded?.offset ?? 0;
      const safeStart = start < 0 ? ordered.length : start;
      const rows = ordered.slice(safeStart, safeStart + safeLimit);
      const hasMore = safeStart + rows.length < ordered.length;
      return {
        path: treePath,
        backing: "sqlite",
        columns: table.columns,
        ...(table.identityRule ? { identityRule: table.identityRule } : {}),
        rows,
        nextCursor: !hasMore ? null : mode === "keyset"
          ? encodeCursor({ version: 1, query, revision: table.revision, mode, after: rows.at(-1)!.stableKey! })
          : encodeCursor({ version: 1, query, revision: table.revision, mode, offset: safeStart + rows.length }),
        revision: table.revision,
        schemaRevision: loaded.schema.fingerprint,
        diagnostics: [...definition.diagnostics, ...table.diagnostics],
        editable: Boolean(table.identityRule),
      };
    }
    const loaded = await this.loadFileCollection(definition);
    const allKeyed = Boolean(loaded.identityRule) && loaded.rows.every((row) => row.stableKey !== null);
    const mode = allKeyed ? "keyset" : "offset";
    const query = `${definition.backing}:${treePath}`;
    const decoded = decodeCursor(cursor, query, loaded.revision, mode);
    const ordered = allKeyed
      ? [...loaded.rows].sort((left, right) => left.stableKey! < right.stableKey! ? -1 : left.stableKey! > right.stableKey! ? 1 : 0)
      : loaded.rows;
    const start = mode === "keyset" && decoded
      ? ordered.findIndex((row) => row.stableKey! > decoded.after!)
      : decoded?.offset ?? 0;
    const safeStart = start < 0 ? ordered.length : start;
    const rows = ordered.slice(safeStart, safeStart + safeLimit);
    const hasMore = safeStart + rows.length < ordered.length;
    const nextCursor = !hasMore ? null : mode === "keyset"
      ? encodeCursor({ version: 1, query, revision: loaded.revision, mode, after: rows.at(-1)!.stableKey! })
      : encodeCursor({ version: 1, query, revision: loaded.revision, mode, offset: safeStart + rows.length });
    return {
      path: treePath,
      backing: definition.backing,
      columns: loaded.description.columns.length
        ? loaded.description.columns
        : [...new Set(rows.flatMap((row) => Object.keys(row.values)))],
      ...(loaded.identityRule ? { identityRule: loaded.identityRule } : {}),
      rows,
      nextCursor,
      revision: loaded.revision,
      schemaRevision: loaded.description.revision,
      diagnostics: loaded.diagnostics,
      editable: loaded.editable,
    };
  }

  private async resolveRow(
    directory: string,
    treePath: string,
    ref: { path: string; stableKey: string | null },
    tableName?: string,
  ): Promise<{ row: CollectionRow; page: LoadedCollectionSlice } | null> {
    const definition = await detectCollection(directory);
    if (!definition || definition.backing === "postgres" || definition.diagnostics.some((item) => item.severity === "error")) return null;
    if (definition.backing === "sqlite") {
      if (!tableName) return null;
      const loaded = await this.loadSQLiteStore(definition);
      const table = loaded.tables[tableName];
      if (!table) return null;
      const segment = ref.path.slice(ref.path.lastIndexOf("/") + 1);
      const row = ref.stableKey !== null
        ? table.rows.find((candidate) => candidate.stableKey === ref.stableKey)
        : table.rows.find((candidate) => candidate.path === segment);
      if (!row) return null;
      return {
        row,
        page: {
          path: treePath,
          backing: "sqlite",
          columns: table.columns,
          ...(table.identityRule ? { identityRule: table.identityRule } : {}),
          rows: [row],
          nextCursor: null,
          revision: table.revision,
          schemaRevision: loaded.schema.fingerprint,
          diagnostics: [...definition.diagnostics, ...table.diagnostics],
          editable: Boolean(table.identityRule),
        },
      };
    }
    const loaded = await this.loadFileCollection(definition);
    const segment = ref.path.slice(ref.path.lastIndexOf("/") + 1);
    const row = ref.stableKey !== null
      ? loaded.rows.find((candidate) => candidate.stableKey === ref.stableKey)
      : loaded.rows.find((candidate) => candidate.path === segment);
    if (!row) return null;
    return {
      row,
      page: {
        path: treePath,
        backing: definition.backing,
        columns: loaded.description.columns,
        ...(loaded.identityRule ? { identityRule: loaded.identityRule } : {}),
        rows: [row],
        nextCursor: null,
        revision: loaded.revision,
        schemaRevision: loaded.description.revision,
        diagnostics: loaded.diagnostics,
        editable: loaded.editable,
      },
    };
  }

  /** Validate and normalize a complete property replacement for one Markdown record. */
  async prepareMarkdownProperties(
    directory: string,
    properties: Record<string, JSONValue>,
  ): Promise<{ properties: Record<string, JSONValue>; identityRule?: { properties: string[] } }> {
    const definition = await detectCollection(directory);
    if (!definition || definition.backing !== "markdown" || !definition.schemaPath) {
      throw new CollectionPropertyWriteError(`${directory} is not a schema-governed Markdown collection`);
    }
    if (definition.diagnostics.some((item) => item.severity === "error")) {
      throw new CollectionPropertyWriteError(definition.diagnostics.map((item) => item.message).join("; "));
    }
    const description = await this.schemas.compile(definition.schemaPath);
    const validated = await this.schemas.validate(definition.schemaPath, properties);
    if (validated.diagnostics.length) {
      throw new CollectionPropertyWriteError(validated.diagnostics.map((item) => {
        const field = item.field ? `${item.field}: ` : "";
        return `${field}${item.message}`;
      }).join("; "));
    }
    if (!validated.value || typeof validated.value !== "object" || Array.isArray(validated.value)) {
      throw new CollectionPropertyWriteError("Markdown collection properties must validate to an object");
    }
    const identityProperties = description.primaryKey
      ?? (description.columns.includes("id") ? ["id"] : null);
    return {
      properties: validated.value as Record<string, JSONValue>,
      ...(identityProperties ? { identityRule: { properties: identityProperties } } : {}),
    };
  }

  /** Replace one stable SQLite row's complete property map under row-level CAS. */
  async writeProperties(
    directory: string,
    treePath: string,
    ref: { path: string; stableKey: string | null },
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    tableName: string,
    mutation: { scope: string; id: string },
  ): Promise<CollectionRow> {
    const definition = await detectCollection(directory);
    if (!definition || definition.backing !== "sqlite") {
      throw new CollectionPropertyWriteError(`${treePath} is not a writable SQLite table`);
    }
    const loaded = await this.loadSQLiteStore(definition);
    const relation = loaded.schema.relations[tableName];
    if (!relation || relation.source !== "sqlite") throw new CollectionPropertyWriteError(`Unknown SQLite table ${tableName}`);
    if (!relation.primaryKey.length || !ref.stableKey) {
      throw new CollectionPropertyWriteError(`SQLite table ${tableName} requires a primary key for direct property writes`);
    }
    const keyPairs = parseCanonicalStableKey(ref.stableKey);
    if (!keyPairs || keyPairs.length !== relation.primaryKey.length || keyPairs.some((pair, index) => pair[0] !== relation.primaryKey[index])) {
      throw new CollectionPropertyWriteError("The supplied stable key does not match the table primary key");
    }
    const columns = Object.keys(relation.fields);
    const sortedColumns = [...columns].sort();
    const supplied = Object.keys(properties).sort();
    if (supplied.length !== sortedColumns.length || supplied.some((column, index) => column !== sortedColumns[index])) {
      throw new CollectionPropertyWriteError(`writeProperties requires exactly these fields: ${columns.join(", ")}`);
    }
    for (const [name, keyValue] of keyPairs) {
      if (properties[name] !== keyValue) throw new CollectionPropertyWriteError(`Identity property ${name} is immutable`);
    }
    const requestHash = sha256(canonicalJSONString({ tableName, stableKey: ref.stableKey, basePropertiesRevision, properties }));
    const database = new Database(definition.storePath!, { strict: true });
    database.exec("pragma foreign_keys = on");
    database.exec("begin immediate");
    try {
      const currentSchemaVersion = database.query("pragma schema_version").get() as { schema_version: number };
      if (currentSchemaVersion.schema_version !== loaded.schemaVersion) {
        throw new CollectionPropertyWriteError("The SQLite schema changed while the row write was being prepared");
      }
      database.exec(`create table if not exists __arbor_property_receipts (
        scope text not null,
        mutation_id text not null,
        request_hash text not null,
        result_json text not null,
        primary key (scope, mutation_id)
      )`);
      const receipt = database.query("select request_hash, result_json from __arbor_property_receipts where scope = ? and mutation_id = ?")
        .get(mutation.scope, mutation.id) as { request_hash: string; result_json: string } | null;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new CollectionMutationMismatchError("This mutation ID was already used for a different row write");
        database.exec("commit");
        return JSON.parse(receipt.result_json) as CollectionRow;
      }
      const where = relation.primaryKey.map((name) => `${sqliteIdentifier(name)} = ?`).join(" and ");
      const keyValues = keyPairs.map(([name, value]) => sqliteWriteValue(relation.fields[name]!, value));
      const projection = columns.map(sqliteIdentifier).join(", ");
      const currentRaw = database.query(`select ${projection} from ${sqliteIdentifier(tableName)} where ${where}`).get(...keyValues) as Record<string, unknown> | null;
      if (!currentRaw) throw new CollectionPropertyWriteError("No SQLite row owns the supplied stable key");
      const current = sqliteRow(loaded.schema, relation, currentRaw);
      if (current.revision !== basePropertiesRevision) throw new CollectionPropertyConflictError(current);
      const mutable = columns.filter((column) => !relation.primaryKey.includes(column));
      if (mutable.length) {
        const assignments = mutable.map((column) => `${sqliteIdentifier(column)} = ?`).join(", ");
        const values = mutable.map((column) => sqliteWriteValue(relation.fields[column]!, properties[column]!));
        database.query(`update ${sqliteIdentifier(tableName)} set ${assignments} where ${where}`).run(...values, ...keyValues);
      }
      const savedRaw = database.query(`select ${projection} from ${sqliteIdentifier(tableName)} where ${where}`).get(...keyValues) as Record<string, unknown> | null;
      if (!savedRaw) throw new CollectionPropertyWriteError("The SQLite row disappeared while it was being written");
      const saved = sqliteRow(loaded.schema, relation, savedRaw);
      database.query("insert into __arbor_property_receipts (scope, mutation_id, request_hash, result_json) values (?, ?, ?, ?)")
        .run(mutation.scope, mutation.id, requestHash, canonicalJSONString(saved));
      database.exec("commit");
      return saved;
    } catch (error) {
      try { database.exec("rollback"); } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  private async loadSQLiteStore(definition: CollectionDefinition): Promise<LoadedSQLiteStore> {
    const directory = dirname(definition.storePath!);
    let schema: StoreSchema;
    try {
      schema = await introspectStoreSchema({
        databasePath: definition.storePath!,
        schemaPath: join(directory, "schema.sql"),
        relationshipsPath: join(directory, "relationships.json"),
      });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      schema = introspectSQLiteDatabase(definition.storePath!);
    }
    const database = new Database(definition.storePath!, { readonly: true, strict: true });
    database.exec("begin");
    try {
      const schemaVersion = (database.query("pragma schema_version").get() as { schema_version: number }).schema_version;
      const tables: Record<string, LoadedSQLiteTable> = {};
      for (const relation of Object.values(schema.relations).filter((candidate) => candidate.source === "sqlite")) {
        const columns = Object.keys(relation.fields);
        const rawRows = database.query(`select ${columns.map(sqliteIdentifier).join(", ")} from ${sqliteIdentifier(relation.name)}`).all() as Record<string, unknown>[];
        const identityRule = relation.primaryKey.length
          ? { properties: relation.primaryKey }
          : undefined;
        const diagnostics: Diagnostic[] = identityRule ? [] : [{
          code: "missing-primary-key",
          message: `SQLite table ${relation.name} has no declared primary key, so its rows do not have stable identity.`,
          path: definition.storePath!,
          severity: "warning",
        }];
        const rows = rawRows.map((raw, index) => {
          const values = Object.fromEntries(columns.map((column) => [column, sqlitePropertyValue(relation.fields[column]!, raw[column])]));
          const stableKey = identityRule ? stableKeyFromProperties(identityRule.properties, values) : null;
          const rowDiagnostics = [...(identityRule && !stableKey ? [{
            code: "invalid-row-key",
            message: `SQLite row does not have a valid ${identityRule.properties.join(", ")} stable key.`,
            path: definition.storePath!,
            row: index,
            severity: "error" as const,
          }] : [])];
          return {
            key: stableKey ?? `row:${index}`,
            path: stableKey ? rowPathSegment(stableKey) : `~row-${index + 1}`,
            stableKey,
            revision: revisionOf(canonicalJSONString({ schema: schema.fingerprint, relation: relation.name, values })),
            values,
            diagnostics: rowDiagnostics,
          } satisfies CollectionRow;
        });
        const logicalRows = [...rows]
          .sort((left, right) => (left.stableKey ?? left.path).localeCompare(right.stableKey ?? right.path))
          .map((row) => ({ key: row.stableKey, properties: row.values }));
        const modelDigest = revisionOf(canonicalJSONString(logicalRows));
        const revision = revisionOf(canonicalJSONString({ schema: schema.fingerprint, relation: relation.name, rows: logicalRows }));
        tables[relation.name] = {
          columns,
          rows,
          revision,
          modelDigest,
          diagnostics,
          ...(identityRule ? { identityRule } : {}),
        };
      }
      const logicalStore = Object.fromEntries(Object.entries(tables).sort(([left], [right]) => left.localeCompare(right)).map(([name, table]) => [name, table.modelDigest]));
      const modelDigest = revisionOf(canonicalJSONString(logicalStore));
      return {
        schema,
        tables,
        schemaVersion,
        modelDigest,
        revision: revisionOf(canonicalJSONString({ schema: schema.fingerprint, tables: logicalStore })),
      };
    } finally {
      database.exec("rollback");
      database.close();
    }
  }

  private async loadFileCollection(definition: CollectionDefinition): Promise<LoadedCollection> {
    const description = definition.schemaPath
      ? await this.schemas.compile(definition.schemaPath)
      : { jsonSchema: {}, columns: [], primaryKey: null, revision: revisionOf("") };
    const loaded = definition.backing === "csv" ? await this.csvRows(definition)
      : definition.backing === "json" ? await this.jsonRows(definition)
      : definition.backing === "jsonl" ? await this.jsonlRows(definition)
      : await this.markdownRows(definition);
    const identityProperties = description.primaryKey
      ?? (definition.backing === "markdown" && description.columns.includes("id") ? ["id"] : null);
    const identityRule = identityProperties ? { properties: identityProperties } : undefined;
    const validated = await Promise.all(loaded.rows.map(async (row, index) => {
      const result = definition.schemaPath
        ? await this.schemas.validate(definition.schemaPath, row.values)
        : { value: row.values, diagnostics: [] };
      const values = (result.value as Record<string, unknown> | undefined) ?? row.values;
      const stableKey = identityRule && result.diagnostics.length === 0
        ? stableKeyFromProperties(identityRule.properties, values)
        : null;
      const diagnostics = [...row.diagnostics, ...result.diagnostics];
      if (identityRule && !stableKey) diagnostics.push({
        code: "invalid-row-key",
        message: `Row does not have a valid ${identityRule.properties.join(", ")} stable key.`,
        path: definition.storePath ?? row.path,
        row: index,
        severity: "error",
      });
      return {
        ...row,
        path: definition.backing === "markdown" ? row.path : stableKey ? rowPathSegment(stableKey) : `~row-${index + 1}`,
        stableKey,
        revision: row.revision ?? revisionOf(JSON.stringify(values)),
        values,
        diagnostics,
      } satisfies CollectionRow;
    }));
    const counts = new Map<string, number>();
    for (const row of validated) if (row.stableKey) counts.set(row.stableKey, (counts.get(row.stableKey) ?? 0) + 1);
    const rows = validated.map((row, index) => {
      if (!row.stableKey || counts.get(row.stableKey) === 1) return row;
      return {
        ...row,
        path: definition.backing === "markdown" ? row.path : `~row-${index + 1}`,
        stableKey: null,
        diagnostics: [...row.diagnostics, {
          code: "duplicate-row-key",
          message: "The declared stable key is duplicated in this collection.",
          path: definition.storePath ?? row.path,
          row: index,
          severity: "error" as const,
        }],
      };
    });
    const revision = revisionOf(`${loaded.revision}\0${description.revision}\0${JSON.stringify({ columns: description.columns, primaryKey: identityProperties })}`);
    const modelDigest = revisionOf(canonicalJSONString([...rows]
      .sort((left, right) => {
        const leftKey = left.stableKey ?? left.path;
        const rightKey = right.stableKey ?? right.path;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((row) => ({ key: row.stableKey, path: row.path, properties: row.values }))));
    return {
      description,
      rows,
      revision,
      modelDigest,
      diagnostics: [...definition.diagnostics, ...loaded.diagnostics],
      ...(identityRule ? { identityRule } : {}),
      editable: definition.backing === "markdown",
    };
  }

  private async csvRows(definition: CollectionDefinition): Promise<{ rows: CollectionRow[]; revision: string; diagnostics: Diagnostic[] }> {
    const source = await readFile(definition.storePath!);
    const parser = createReadStream(definition.storePath!).pipe(parse({ columns: true, bom: true, relax_column_count: true }));
    const rows: CollectionRow[] = [];
    let index = 0;
    for await (const record of parser) {
      rows.push({ key: `row:${index + 2}`, path: `~row-${index + 1}`, stableKey: null, values: record as Record<string, unknown>, diagnostics: [] });
      index += 1;
    }
    return { rows, revision: revisionOf(source), diagnostics: [] };
  }

  private async jsonRows(definition: CollectionDefinition): Promise<{ rows: CollectionRow[]; revision: string; diagnostics: Diagnostic[] }> {
    const source = await readFile(definition.storePath!, "utf8");
    try {
      const value = JSON.parse(source) as unknown;
      if (!Array.isArray(value)) throw new Error("_store.json must contain one top-level array");
      return {
        rows: value.map((item, index) => item && typeof item === "object" && !Array.isArray(item)
          ? { key: `item:${index}`, path: `~row-${index + 1}`, stableKey: null, values: item as Record<string, unknown>, diagnostics: [] }
          : {
            key: `item:${index}`,
            path: `~row-${index + 1}`,
            stableKey: null,
            values: {},
            diagnostics: [{ code: "invalid-json-row", message: "Each _store.json item must be an object.", path: definition.storePath!, row: index, severity: "error" as const }],
          }),
        revision: revisionOf(source),
        diagnostics: [],
      };
    } catch (error) {
      return {
        rows: [],
        revision: revisionOf(source),
        diagnostics: [{ code: "invalid-json-store", message: error instanceof Error ? error.message : String(error), path: definition.storePath!, severity: "error" }],
      };
    }
  }

  private async jsonlRows(definition: CollectionDefinition): Promise<{ rows: CollectionRow[]; revision: string; diagnostics: Diagnostic[] }> {
    const source = await readFile(definition.storePath!, "utf8");
    const input = createReadStream(definition.storePath!, "utf8");
    const reader = createInterface({ input, crlfDelay: Infinity });
    const rows: CollectionRow[] = [];
    let lineNumber = 0;
    for await (const line of reader) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each _store.jsonl line must be an object");
        rows.push({ key: `line:${lineNumber}`, path: `~row-${rows.length + 1}`, stableKey: null, values: value as Record<string, unknown>, diagnostics: [] });
      } catch (error) {
        rows.push({
          key: `line:${lineNumber}`,
          path: `~row-${rows.length + 1}`,
          stableKey: null,
          values: {},
          diagnostics: [{ code: "invalid-jsonl", message: error instanceof Error ? error.message : String(error), path: definition.storePath!, row: lineNumber, severity: "error" }],
        });
      }
    }
    return { rows, revision: revisionOf(source), diagnostics: [] };
  }

  private async markdownRows(definition: CollectionDefinition): Promise<{ rows: CollectionRow[]; revision: string; diagnostics: Diagnostic[] }> {
    const paths = (definition.markdownPaths ?? []).sort();
    const rows = await Promise.all(paths.map(async (path) => {
      const source = await readFile(path, "utf8");
      const document = parseMarkdown(source);
      return {
        key: String(document.frontmatter.id ?? basename(path, ".md")),
        path: basename(path, ".md"),
        stableKey: null,
        revision: revisionOf(source),
        values: document.frontmatter,
        diagnostics: [],
      } satisfies CollectionRow;
    }));
    return {
      rows,
      revision: revisionOf(rows.map((row) => `${row.path}:${row.revision}`).join("\n")),
      diagnostics: [],
    };
  }

  private async postgresReference(path: string): Promise<{ connection: string; schema: string }> {
    const value = parseDocument(await readFile(path, "utf8")).toJS() as { connection?: string; schema?: string; driver?: string };
    if (value.driver !== "postgres" || !value.connection) throw new Error("Invalid _store.postgres reference");
    return { connection: value.connection, schema: value.schema ?? "public" };
  }

  private async postgresRows(definition: CollectionDefinition, table: string | undefined, cursor: number, limit: number): Promise<{ rows: CollectionRow[]; hasMore: boolean }> {
    if (!table || !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(table)) throw new Error("A valid Postgres table is required");
    const reference = await this.postgresReference(definition.storePath!);
    const connection = await this.connections.get(connectionName(reference.connection));
    if (!connection) throw new Error(`Connection ${reference.connection} is unavailable`);
    const sql = new Bun.SQL(connection.dsn);
    const schema = reference.schema.replaceAll('"', '""');
    const safeTable = table.replaceAll('"', '""');
    try {
      const result = await sql.unsafe(`select * from "${schema}"."${safeTable}" offset $1 limit $2`, [cursor, limit + 1]);
      const rows = result.slice(0, limit).map((values: Record<string, unknown>, index: number) => ({
        key: `row:${cursor + index}`,
        path: `~row-${cursor + index + 1}`,
        stableKey: null,
        values,
        diagnostics: [],
      }));
      return { rows, hasMore: result.length > limit };
    } finally { await sql.close(); }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.schemas[Symbol.asyncDispose]();
  }
}

function postgresType(type: string): string {
  if (["smallint", "integer", "bigint", "decimal", "numeric", "real", "double precision"].includes(type)) return "number";
  if (type === "boolean") return "boolean";
  if (["json", "jsonb"].includes(type)) return "unknown";
  if (["bytea"].includes(type)) return "Uint8Array";
  if (type.endsWith(" without time zone") || type.endsWith(" with time zone") || type === "date") return "Date";
  return "string";
}
