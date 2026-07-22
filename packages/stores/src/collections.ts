import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "csv-parse";
import { parseDocument } from "yaml";
import type { CollectionBacking, CollectionPage, CollectionRow, CollectionSummary, Diagnostic } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import { ConnectionStore, connectionName } from "./connections.ts";
import { SchemaSandbox } from "./schema.ts";

interface CollectionDefinition {
  backing: CollectionBacking;
  schemaPath?: string;
  storePath?: string;
  markdownPaths?: string[];
  diagnostics: Diagnostic[];
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function detectCollection(directory: string): Promise<CollectionDefinition | null> {
  const names = await readdir(directory);
  const schemaPath = names.includes("schema.ts") ? join(directory, "schema.ts") : undefined;
  const stores = ["_store.csv", "_store.jsonl", "_store.postgres"].filter((name) => names.includes(name));
  const markdownPaths = schemaPath
    ? names.filter((name) => name.endsWith(".md") && name !== "_index.md").map((name) => join(directory, name))
    : [];
  if (!schemaPath && !stores.includes("_store.postgres")) return null;
  const diagnostics: Diagnostic[] = [];
  const shapes = stores.length + (markdownPaths.length ? 1 : 0);
  if (shapes > 1) diagnostics.push({
    code: "mixed-collection-backing",
    message: "A collection must use exactly one of _store.csv, _store.jsonl, _store.postgres, or Markdown records.",
    path: directory,
    severity: "error",
  });
  if (stores[0] === "_store.postgres") return { backing: "postgres", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.csv") return { backing: "csv", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.jsonl") return { backing: "jsonl", storePath: join(directory, stores[0]), schemaPath, diagnostics };
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
    const description = definition.schemaPath ? await this.schemas.compile(definition.schemaPath) : { columns: [] };
    return { backing: definition.backing, columns: description.columns, editable: definition.backing === "markdown" };
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

  async page(directory: string, treePath: string, cursor = 0, limit = 100, postgresTable?: string): Promise<CollectionPage> {
    const definition = await detectCollection(directory);
    if (!definition) throw new Error(`${treePath} is not a collection`);
    const safeLimit = Math.max(1, Math.min(limit, 500));
    if (definition.diagnostics.some((item) => item.severity === "error")) {
      return { path: treePath, backing: definition.backing, columns: [], rows: [], nextCursor: null, diagnostics: definition.diagnostics, editable: false };
    }
    const description = definition.schemaPath ? await this.schemas.compile(definition.schemaPath) : { columns: [] };
    let rows: CollectionRow[] = [];
    let hasMore = false;
    if (definition.backing === "csv") ({ rows, hasMore } = await this.csvRows(definition, cursor, safeLimit));
    else if (definition.backing === "jsonl") ({ rows, hasMore } = await this.jsonlRows(definition, cursor, safeLimit));
    else if (definition.backing === "markdown") ({ rows, hasMore } = await this.markdownRows(definition, cursor, safeLimit));
    else ({ rows, hasMore } = await this.postgresRows(definition, postgresTable, cursor, safeLimit));
    const validated = await Promise.all(rows.map(async (row) => {
      if (!definition.schemaPath) return row;
      const result = await this.schemas.validate(definition.schemaPath, row.values);
      return { ...row, values: (result.value as Record<string, unknown> | undefined) ?? row.values, diagnostics: [...row.diagnostics, ...result.diagnostics] };
    }));
    const columns = description.columns.length ? description.columns : [...new Set(validated.flatMap((row) => Object.keys(row.values)))];
    return {
      path: treePath,
      backing: definition.backing,
      columns,
      rows: validated,
      nextCursor: hasMore ? String(cursor + safeLimit) : null,
      diagnostics: definition.diagnostics,
      editable: definition.backing === "markdown",
    };
  }

  private async csvRows(definition: CollectionDefinition, cursor: number, limit: number): Promise<{ rows: CollectionRow[]; hasMore: boolean }> {
    const parser = createReadStream(definition.storePath!).pipe(parse({ columns: true, bom: true, relax_column_count: true }));
    const rows: CollectionRow[] = [];
    let index = 0;
    for await (const record of parser) {
      if (index >= cursor && rows.length <= limit) rows.push({ key: `row:${index + 2}`, values: record as Record<string, unknown>, diagnostics: [] });
      index += 1;
      if (rows.length > limit) break;
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
  }

  private async jsonlRows(definition: CollectionDefinition, cursor: number, limit: number): Promise<{ rows: CollectionRow[]; hasMore: boolean }> {
    const input = createReadStream(definition.storePath!, "utf8");
    const reader = createInterface({ input, crlfDelay: Infinity });
    const rows: CollectionRow[] = [];
    let index = 0;
    for await (const line of reader) {
      if (!line.trim()) continue;
      if (index >= cursor && rows.length <= limit) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          rows.push({ key: `line:${index + 1}`, values: value, diagnostics: [] });
        } catch (error) {
          rows.push({
            key: `line:${index + 1}`,
            values: {},
            diagnostics: [{ code: "invalid-jsonl", message: error instanceof Error ? error.message : String(error), path: definition.storePath!, row: index + 1, severity: "error" }],
          });
        }
      }
      index += 1;
      if (rows.length > limit) break;
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
  }

  private async markdownRows(definition: CollectionDefinition, cursor: number, limit: number): Promise<{ rows: CollectionRow[]; hasMore: boolean }> {
    const paths = (definition.markdownPaths ?? []).sort();
    const selected = paths.slice(cursor, cursor + limit + 1);
    const rows = await Promise.all(selected.slice(0, limit).map(async (path) => {
      const document = parseMarkdown(await readFile(path, "utf8"));
      const { id: _id, ...values } = document.frontmatter;
      return { key: String(document.frontmatter.id ?? basename(path, ".md")), path: basename(path, ".md"), values, diagnostics: [] } satisfies CollectionRow;
    }));
    return { rows, hasMore: selected.length > limit };
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
      const rows = result.slice(0, limit).map((values: Record<string, unknown>, index: number) => ({ key: `row:${cursor + index}`, values, diagnostics: [] }));
      return { rows, hasMore: result.length > limit };
    } finally { await sql.close(); }
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
