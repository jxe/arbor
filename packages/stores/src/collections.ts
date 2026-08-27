import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "csv-parse";
import { parseDocument } from "yaml";
import type { Diagnostic } from "@arbor/core";
import type { CollectionBacking, CollectionPage, CollectionRow, CollectionSummary } from "@arbor/core/internal";
import { canonicalJSONString, revisionOf, rowPathSegment, stableKeyFromProperties } from "@arbor/core";
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
  identityRule?: { scope: "parent"; properties: string[] };
  editable: boolean;
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
  const stores = ["_store.csv", "_store.json", "_store.jsonl", "_store.postgres"].filter((name) => names.includes(name));
  const markdownPaths = schemaPath
    ? names.filter((name) => name.endsWith(".md") && name !== "_index.md").map((name) => join(directory, name))
    : [];
  if (!schemaPath && !stores.includes("_store.postgres")) return null;
  const diagnostics: Diagnostic[] = [];
  const shapes = stores.length + (markdownPaths.length ? 1 : 0);
  if (shapes > 1) diagnostics.push({
    code: "mixed-collection-backing",
    message: "A collection must use exactly one of _store.csv, _store.json, _store.jsonl, _store.postgres, or Markdown records.",
    path: directory,
    severity: "error",
  });
  if (stores[0] === "_store.postgres") return { backing: "postgres", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.csv") return { backing: "csv", storePath: join(directory, stores[0]), schemaPath, diagnostics };
  if (stores[0] === "_store.json") return { backing: "json", storePath: join(directory, stores[0]), schemaPath, diagnostics };
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

  async page(directory: string, treePath: string, cursor: string | null = null, limit = 100, postgresTable?: string): Promise<CollectionPage> {
    const definition = await detectCollection(directory);
    if (!definition) throw new Error(`${treePath} is not a collection`);
    const safeLimit = Math.max(1, Math.min(limit, 500));
    if (definition.diagnostics.some((item) => item.severity === "error")) {
      return { path: treePath, backing: definition.backing, columns: [], rows: [], nextCursor: null, revision: revisionOf(JSON.stringify(definition.diagnostics)), schemaRevision: revisionOf("invalid-collection-schema"), diagnostics: definition.diagnostics, editable: false };
    }
    if (definition.backing === "postgres") {
      const query = `postgres:${treePath}:${postgresTable ?? ""}`;
      const decoded = decodeCursor(cursor, query, "external:postgres", "offset");
      const offset = decoded?.offset ?? 0;
      const { rows, hasMore } = await this.postgresRows(definition, postgresTable, offset, safeLimit);
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

  async row(
    directory: string,
    treePath: string,
    ref: { path: string; stableKey: string | null },
  ): Promise<{ row: CollectionRow; page: CollectionPage } | null> {
    const definition = await detectCollection(directory);
    if (!definition || definition.backing === "postgres" || definition.diagnostics.some((item) => item.severity === "error")) return null;
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
    const identityRule = identityProperties ? { scope: "parent" as const, properties: identityProperties } : undefined;
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
}

function postgresType(type: string): string {
  if (["smallint", "integer", "bigint", "decimal", "numeric", "real", "double precision"].includes(type)) return "number";
  if (type === "boolean") return "boolean";
  if (["json", "jsonb"].includes(type)) return "unknown";
  if (["bytea"].includes(type)) return "Uint8Array";
  if (type.endsWith(" without time zone") || type.endsWith(" with time zone") || type === "date") return "Date";
  return "string";
}
