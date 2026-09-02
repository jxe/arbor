import { dirname, join } from "node:path";
import { canonicalCBORHash } from "@arbor/core";
import { Database } from "bun:sqlite";
import type { Diagnostic, Hash, JSONValue } from "@arbor/core";
import {
  stableJSONString,
  parseCanonicalStableKey,
  revisionOf,
  rowPathSegment,
  sha256,
  stableKeyFromProperties,
} from "@arbor/core";
import { introspectSQLiteDatabase, introspectStoreSchema, type FieldMetadata, type StoreSchema } from "@arbor/data";
import {
  type ProjectionProvider,
  decodeProviderCursor,
  encodeProviderCursor,
  ProjectionProviderError,
  representationFor,
  type LoadedProjectionSlice,
  type PreparedProviderPropertyWrite,
  type ProjectionDefinition,
  type ProjectionDescriptor,
  type ProjectionWriteTarget,
  type ProviderChildRecord,
} from "./types.ts";
interface LoadedSQLiteTable {
  columns: string[];
  rows: ProviderChildRecord[];
  revision: string;
  modelHash: string;
  diagnostics: Diagnostic[];
  identityRule?: { properties: string[] };
}
interface LoadedSQLiteStore {
  schema: StoreSchema;
  tables: Record<string, LoadedSQLiteTable>;
  schemaVersion: number;
  revision: string;
  modelHash: string;
}
export class SQLiteProjectionDriver implements ProjectionProvider {
  readonly kinds = ["sqlite"] as const;
  async describe(definition: ProjectionDefinition): Promise<ProjectionDescriptor> {
    const loaded = await this.load(definition);
    return {
      columns: [],
      revision: loaded.revision,
      schemaRevision: loaded.schema.fingerprint,
      modelHash: loaded.modelHash,
      diagnostics: definition.diagnostics,
      editable: false,
      representation: representationFor("sqlite", loaded.modelHash as Hash, "subtree"),
      total: Object.keys(loaded.tables).length,
      tables: Object.keys(loaded.tables).sort(),
    };
  }
  async describeTable(definition: ProjectionDefinition, tableName: string): Promise<ProjectionDescriptor | null> {
    const loaded = await this.load(definition);
    const table = loaded.tables[tableName];
    if (!table) return null;
    return {
      columns: table.columns,
      ...(table.identityRule ? { identityRule: table.identityRule } : {}),
      revision: table.revision,
      schemaRevision: loaded.schema.fingerprint,
      modelHash: table.modelHash,
      diagnostics: table.diagnostics,
      editable: Boolean(table.identityRule),
      representation: representationFor("sqlite", table.modelHash as Hash, "children"),
      total: table.rows.length,
    };
  }
  async page(
    definition: ProjectionDefinition,
    treePath: string,
    cursor: string | null,
    limit: number,
    tableName?: string,
  ): Promise<LoadedProjectionSlice> {
    if (!tableName) throw new Error("A SQLite table is required");
    const loaded = await this.load(definition);
    const table = loaded.tables[tableName];
    if (!table) throw new Error(`Unknown SQLite table ${tableName}`);
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const allKeyed = Boolean(table.identityRule) && table.rows.every((row) => row.stableKey !== null);
    const mode = allKeyed ? "keyset" : "offset";
    const query = `sqlite:${treePath}:${tableName}`;
    const decoded = decodeProviderCursor(cursor, query, table.revision, mode);
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
      columns: table.columns,
      ...(table.identityRule ? { identityRule: table.identityRule } : {}),
      rows,
      nextCursor: !hasMore ? null : mode === "keyset"
        ? encodeProviderCursor({ version: 1, query, revision: table.revision, mode, after: rows.at(-1)!.stableKey! })
        : encodeProviderCursor({ version: 1, query, revision: table.revision, mode, offset: safeStart + rows.length }),
      revision: table.revision,
      schemaRevision: loaded.schema.fingerprint,
      diagnostics: [...definition.diagnostics, ...table.diagnostics],
      editable: Boolean(table.identityRule),
    };
  }
  async resolve(
    definition: ProjectionDefinition,
    treePath: string,
    ref: { path: string; stableKey: string | null },
    tableName?: string,
  ): Promise<{ row: ProviderChildRecord; page: LoadedProjectionSlice } | null> {
    if (!tableName) return null;
    const loaded = await this.load(definition);
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
  async prepareWrite(
    definition: ProjectionDefinition,
    target: ProjectionWriteTarget,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    mutation: { scope: string; id: string },
  ): Promise<PreparedProviderPropertyWrite> {
    const tableName = target.table;
    if (!tableName || !definition.storePath) {
      throw new ProjectionProviderError("invalid-write", `${target.parentPath} is not a writable SQLite table`);
    }
    const loaded = await this.load(definition);
    const relation = loaded.schema.relations[tableName];
    if (!relation || relation.source !== "sqlite") throw new ProjectionProviderError("invalid-write", `Unknown SQLite table ${tableName}`);
    if (!relation.primaryKey.length || !target.stableKey) {
      throw new ProjectionProviderError("invalid-write", `SQLite table ${tableName} requires a primary key for direct property writes`);
    }
    const keyPairs = parseCanonicalStableKey(target.stableKey);
    if (!keyPairs || keyPairs.length !== relation.primaryKey.length || keyPairs.some((pair, index) => pair[0] !== relation.primaryKey[index])) {
      throw new ProjectionProviderError("invalid-write", "The supplied stable key does not match the table primary key");
    }
    const columns = Object.keys(relation.fields);
    const supplied = Object.keys(properties).sort();
    const sortedColumns = [...columns].sort();
    if (supplied.length !== sortedColumns.length || supplied.some((column, index) => column !== sortedColumns[index])) {
      throw new ProjectionProviderError("invalid-write", `writeProperties requires exactly these fields: ${columns.join(", ")}`);
    }
    for (const [name, keyValue] of keyPairs) {
      if (properties[name] !== keyValue) throw new ProjectionProviderError("invalid-write", `Identity property ${name} is immutable`);
    }
    const stableKey = target.stableKey;
    let completed = false;
    return {
      durability: "provider-transaction",
      path: target.path,
      stableKey,
      properties,
      commit: async () => {
        const saved = this.commitWrite(
          definition,
          loaded,
          relation,
          tableName,
          stableKey,
          basePropertiesRevision,
          properties,
          mutation,
        );
        completed = true;
        return { path: target.path, stableKey: saved.stableKey!, revision: saved.revision!, properties: saved.values as Record<string, JSONValue> };
      },
      abort: async () => { completed = true; },
    };
  }
  private commitWrite(
    definition: ProjectionDefinition,
    loaded: LoadedSQLiteStore,
    relation: StoreSchema["relations"][string],
    tableName: string,
    stableKey: string,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    mutation: { scope: string; id: string },
  ): ProviderChildRecord {
    const keyPairs = parseCanonicalStableKey(stableKey)!;
    const columns = Object.keys(relation.fields);
    const requestHash = sha256(stableJSONString({ tableName, stableKey, basePropertiesRevision, properties }));
    const database = new Database(definition.storePath!, { strict: true });
    database.exec("pragma foreign_keys = on");
    database.exec("begin immediate");
    try {
      const currentSchemaVersion = database.query("pragma schema_version").get() as { schema_version: number };
      if (currentSchemaVersion.schema_version !== loaded.schemaVersion) {
        throw new ProjectionProviderError("invalid-write", "The SQLite schema changed while the row write was being prepared");
      }
      database.exec(`create table if not exists __arbor_property_receipts (
        scope text not null, mutation_id text not null, request_hash text not null, result_json text not null,
        primary key (scope, mutation_id)
      )`);
      const receipt = database.query("select request_hash, result_json from __arbor_property_receipts where scope = ? and mutation_id = ?")
        .get(mutation.scope, mutation.id) as { request_hash: string; result_json: string } | null;
      if (receipt) {
        if (receipt.request_hash !== requestHash) {
          throw new ProjectionProviderError("mutation-mismatch", "This mutation ID was already used for a different row write");
        }
        database.exec("commit");
        return JSON.parse(receipt.result_json) as ProviderChildRecord;
      }
      const where = relation.primaryKey.map((name) => `${identifier(name)} = ?`).join(" and ");
      const keyValues = keyPairs.map(([name, value]) => writeValue(relation.fields[name]!, value));
      const projection = columns.map(identifier).join(", ");
      const currentRaw = database.query(`select ${projection} from ${identifier(tableName)} where ${where}`).get(...keyValues) as Record<string, unknown> | null;
      if (!currentRaw) throw new ProjectionProviderError("invalid-write", "No SQLite row owns the supplied stable key");
      const current = sqliteRow(loaded.schema, relation, currentRaw);
      if (current.revision !== basePropertiesRevision) {
        throw new ProjectionProviderError("stale-properties", "The row properties changed since they were read", current);
      }
      const mutable = columns.filter((column) => !relation.primaryKey.includes(column));
      if (mutable.length) {
        const assignments = mutable.map((column) => `${identifier(column)} = ?`).join(", ");
        const values = mutable.map((column) => writeValue(relation.fields[column]!, properties[column]!));
        database.query(`update ${identifier(tableName)} set ${assignments} where ${where}`).run(...values, ...keyValues);
      }
      const savedRaw = database.query(`select ${projection} from ${identifier(tableName)} where ${where}`).get(...keyValues) as Record<string, unknown> | null;
      if (!savedRaw) throw new ProjectionProviderError("invalid-write", "The SQLite row disappeared while it was being written");
      const saved = sqliteRow(loaded.schema, relation, savedRaw);
      database.query("insert into __arbor_property_receipts (scope, mutation_id, request_hash, result_json) values (?, ?, ?, ?)")
        .run(mutation.scope, mutation.id, requestHash, stableJSONString(saved));
      database.exec("commit");
      return saved;
    } catch (error) {
      try { database.exec("rollback"); } catch {}
      if (error instanceof ProjectionProviderError) throw error;
      if (error instanceof Error && /constraint/i.test(error.message)) {
        throw new ProjectionProviderError("constraint", error.message);
      }
      throw error;
    } finally { database.close(); }
  }
  private async load(definition: ProjectionDefinition): Promise<LoadedSQLiteStore> {
    const directory = dirname(definition.storePath!);
    const database = new Database(definition.storePath!, { readonly: true, strict: true });
    database.exec("begin");
    try {
      let schema: StoreSchema;
      try {
        schema = await introspectStoreSchema({
          databasePath: definition.storePath!, schemaPath: join(directory, "schema.sql"),
          relationshipsPath: join(directory, "relationships.json"),
        }, database);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
        schema = introspectSQLiteDatabase(database);
      }
      const schemaVersion = (database.query("pragma schema_version").get() as { schema_version: number }).schema_version;
      const tables: Record<string, LoadedSQLiteTable> = {};
      for (const relation of Object.values(schema.relations).filter((candidate) => candidate.source === "sqlite")) {
        const columns = Object.keys(relation.fields);
        const rawRows = database.query(`select ${columns.map(identifier).join(", ")} from ${identifier(relation.name)}`).all() as Record<string, unknown>[];
        const identityRule = relation.primaryKey.length ? { properties: relation.primaryKey } : undefined;
        const diagnostics: Diagnostic[] = identityRule ? [] : [{
          code: "missing-primary-key", message: `SQLite table ${relation.name} has no declared primary key, so its rows do not have stable identity.`,
          path: definition.storePath!, severity: "warning",
        }];
        const rows = rawRows.map((raw, index) => {
          const values = Object.fromEntries(columns.map((column) => [column, propertyValue(relation.fields[column]!, raw[column])])) as Record<string, JSONValue>;
          const stableKey = identityRule ? stableKeyFromProperties(identityRule.properties, values) : null;
          return {
            key: stableKey ?? `row:${index}`,
            path: stableKey ? rowPathSegment(stableKey) : `~row-${index + 1}`,
            stableKey,
            revision: revisionOf(stableJSONString({ schema: schema.fingerprint, relation: relation.name, values })),
            values,
            diagnostics: identityRule && !stableKey ? [{
              code: "invalid-row-key", message: `SQLite row does not have a valid ${identityRule.properties.join(", ")} stable key.`,
              path: definition.storePath!, row: index, severity: "error" as const,
            }] : [],
          } satisfies ProviderChildRecord;
        });
        const logicalRows = [...rows]
          .sort((left, right) => (left.stableKey ?? left.path).localeCompare(right.stableKey ?? right.path))
          .map((row) => ({ key: row.stableKey, properties: row.values }));
        const modelHash = canonicalCBORHash(logicalRows);
        tables[relation.name] = {
          columns, rows, modelHash,
          revision: revisionOf(stableJSONString({ schema: schema.fingerprint, relation: relation.name, rows: logicalRows })),
          diagnostics, ...(identityRule ? { identityRule } : {}),
        };
      }
      const logicalStore = Object.fromEntries(Object.entries(tables).sort(([left], [right]) => left.localeCompare(right)).map(([name, table]) => [name, table.modelHash]));
      const modelHash = canonicalCBORHash(logicalStore);
      return { schema, tables, schemaVersion, modelHash, revision: revisionOf(stableJSONString({ schema: schema.fingerprint, tables: logicalStore })) };
    } finally {
      database.exec("rollback");
      database.close();
    }
  }
}
function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function propertyValue(field: FieldMetadata, value: unknown): unknown {
  if (value === null) return null;
  if (field.type === "boolean") return Boolean(value);
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function writeValue(field: FieldMetadata, value: JSONValue): string | number | bigint | boolean | Uint8Array | null {
  if (value === null) return null;
  if (field.type === "string") {
    if (typeof value !== "string") throw new ProjectionProviderError("invalid-write", `${field.name} must be a string`);
    return value;
  }
  if (field.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return BigInt(value);
    throw new ProjectionProviderError("invalid-write", `${field.name} must be a finite number or exact integer string`);
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new ProjectionProviderError("invalid-write", `${field.name} must be a boolean`);
    return value ? 1 : 0;
  }
  if (field.type === "bytes") {
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 1 || typeof value.$bytes !== "string") {
      throw new ProjectionProviderError("invalid-write", `${field.name} must be a {$bytes: base64} value`);
    }
    return new Uint8Array(Buffer.from(value.$bytes, "base64"));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new ProjectionProviderError("invalid-write", `${field.name} cannot be bound to this SQLite column`);
}

function sqliteRow(schema: StoreSchema, relation: StoreSchema["relations"][string], raw: Record<string, unknown>): ProviderChildRecord {
  const columns = Object.keys(relation.fields);
  const values = Object.fromEntries(columns.map((column) => [column, propertyValue(relation.fields[column]!, raw[column])])) as Record<string, JSONValue>;
  const stableKey = stableKeyFromProperties(relation.primaryKey, values);
  if (!stableKey) throw new ProjectionProviderError("invalid-write", `SQLite row does not have a valid ${relation.primaryKey.join(", ")} stable key`);
  return {
    key: stableKey, path: rowPathSegment(stableKey), stableKey,
    revision: revisionOf(stableJSONString({ schema: schema.fingerprint, relation: relation.name, values })),
    values, diagnostics: [],
  };
}
