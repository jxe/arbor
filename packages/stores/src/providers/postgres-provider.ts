import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { revisionOf } from "@arbor/core";
import { ConnectionStore, connectionName } from "../connections.ts";
import {
  type ProjectionProvider,
  decodeProviderCursor,
  encodeProviderCursor,
  representationFor,
  type LoadedProjectionSlice,
  type ProjectionDefinition,
  type ProjectionDescriptor,
} from "./types.ts";
export class PostgresProjectionDriver implements ProjectionProvider {
  readonly kinds = ["postgres"] as const;
  constructor(private connections = new ConnectionStore()) {}
  async describe(definition: ProjectionDefinition): Promise<ProjectionDescriptor> {
    const reference = await this.reference(definition.storePath!);
    const connection = await this.connections.get(connectionName(reference.connection));
    if (!connection) return {
      columns: [], editable: false, tables: [], representation: representationFor("postgres"),
    };
    const sql = new Bun.SQL(connection.dsn);
    try {
      const rows = await sql`select table_name from information_schema.tables where table_schema = ${reference.schema} and table_type = 'BASE TABLE' order by table_name`;
      return {
        columns: [], editable: false,
        tables: rows.map((row: Record<string, unknown>) => String(row.table_name)),
        representation: representationFor("postgres"),
      };
    } finally { await sql.close(); }
  }
  async describeTable(definition: ProjectionDefinition, table: string): Promise<ProjectionDescriptor | null> {
    const summary = await this.describe(definition);
    return summary.tables?.includes(table) ? { ...summary, tables: undefined } : null;
  }
  async schema(definition: ProjectionDefinition): Promise<Record<string, Record<string, string>>> {
    const reference = await this.reference(definition.storePath!);
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
  async page(
    definition: ProjectionDefinition,
    treePath: string,
    cursor: string | null,
    limit: number,
    table?: string,
  ): Promise<LoadedProjectionSlice> {
    if (!table) throw new Error("A Postgres table is required");
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const query = `postgres:${treePath}:${table}`;
    const decoded = decodeProviderCursor(cursor, query, "external:postgres", "offset");
    const offset = decoded?.offset ?? 0;
    const { rows, hasMore } = await this.rows(definition, table, offset, safeLimit);
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row.values)))];
    return {
      path: treePath,
      columns,
      rows,
      nextCursor: hasMore
        ? encodeProviderCursor({ version: 1, query, revision: "external:postgres", mode: "offset", offset: offset + rows.length })
        : null,
      revision: "external:postgres",
      schemaRevision: revisionOf(JSON.stringify(columns)),
      diagnostics: definition.diagnostics,
      editable: false,
    };
  }
  private async reference(path: string): Promise<{ connection: string; schema: string }> {
    const value = parseDocument(await readFile(path, "utf8")).toJS() as { connection?: string; schema?: string; driver?: string };
    if (value.driver !== "postgres" || !value.connection) throw new Error("Invalid _store.postgres reference");
    return { connection: value.connection, schema: value.schema ?? "public" };
  }
  private async rows(definition: ProjectionDefinition, table: string, cursor: number, limit: number): Promise<{
    rows: Array<{ key: string; path: string; stableKey: null; values: Record<string, unknown>; diagnostics: never[] }>;
    hasMore: boolean;
  }> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(table)) throw new Error("A valid Postgres table is required");
    const reference = await this.reference(definition.storePath!);
    const connection = await this.connections.get(connectionName(reference.connection));
    if (!connection) throw new Error(`Connection ${reference.connection} is unavailable`);
    const sql = new Bun.SQL(connection.dsn);
    const schema = reference.schema.replaceAll('"', '""');
    const safeTable = table.replaceAll('"', '""');
    try {
      const result = await sql.unsafe(`select * from "${schema}"."${safeTable}" offset $1 limit $2`, [cursor, limit + 1]) as Array<Record<string, unknown>>;
      return {
        rows: result.slice(0, limit).map((values: Record<string, unknown>, index: number) => ({
          key: `row:${cursor + index}`, path: `~row-${cursor + index + 1}`, stableKey: null, values, diagnostics: [],
        })),
        hasMore: result.length > limit,
      };
    } finally { await sql.close(); }
  }
}
function postgresType(type: string): string {
  if (["smallint", "integer", "bigint", "decimal", "numeric", "real", "double precision"].includes(type)) return "number";
  if (type === "boolean") return "boolean";
  if (["json", "jsonb"].includes(type)) return "unknown";
  if (type === "bytea") return "Uint8Array";
  if (type.endsWith(" without time zone") || type.endsWith(" with time zone") || type === "date") return "Date";
  return "string";
}
