import type { ChildrenPage, Hash, JSONValue, NodeRef, NodeSnapshot, NodeSummary } from "@arbor/core";
import { revisionOf } from "@arbor/core";
import { ConnectionStore } from "./connections.ts";
import { detectProjection } from "./providers/discovery.ts";
import { FileProjectionDriver } from "./providers/file-provider.ts";
import { PostgresProjectionDriver } from "./providers/postgres-provider.ts";
import { SQLiteProjectionDriver } from "./providers/sqlite-provider.ts";
import {
  invalidDescriptor,
  jsonValue,
  ProjectionProviderError,
  providerDigest,
  type LoadedProjectionSlice,
  type ProjectionDefinition,
  type ProjectionDescriptor,
  type ProjectionPropertyPreparation,
  type ProjectionProviderContext,
  type ProjectionWriteTarget,
  type ProviderChildRecord,
} from "./providers/types.ts";
import { SchemaSandbox } from "./schema.ts";
function rowSummary(
  row: ProviderChildRecord,
  page: LoadedProjectionSlice,
  parentPath: string,
  context: ProjectionProviderContext,
): NodeSummary {
  const properties = (jsonValue(row.values) ?? {}) as Record<string, JSONValue>;
  const revision = row.revision ?? providerDigest({ key: row.key, properties });
  const editable = page.editable && (!page.identityRule || row.stableKey !== null) && context.writable;
  return {
    ref: {
      tree: context.tree,
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
      properties: { revision, schema: page.schemaRevision as Hash, writable: editable },
      ...(page.rowContent === "markdown" ? {
        content: { revision, mediaType: "text/markdown", format: "markdown" as const, writable: editable },
      } : {}),
    },
    materialization: "available",
    diagnostics: row.diagnostics,
  };
}
/** One coherent, short-lived view of a discovered projection mount. */
export class ProjectionReadSession {
  constructor(
    readonly directory: string,
    private definition: ProjectionDefinition,
    private files: FileProjectionDriver,
    private sqlite: SQLiteProjectionDriver,
    private postgres: PostgresProjectionDriver,
  ) {}
  async descriptor(): Promise<ProjectionDescriptor> {
    if (this.definition.diagnostics.some((item) => item.severity === "error")) return invalidDescriptor(this.definition);
    if (this.definition.provider === "sqlite") return this.sqlite.describe(this.definition);
    if (this.definition.provider === "postgres") return this.postgres.describe(this.definition);
    return this.files.describe(this.definition);
  }
  /** Providers own direct rows; database providers additionally own table/row subtrees. */
  async owns(relative: readonly string[]): Promise<boolean> {
    if (relative.length === 0) return true;
    const descriptor = await this.descriptor();
    if (descriptor.diagnostics?.some((item) => item.severity === "error")) return false;
    if (descriptor.tables) return relative.length <= 2 && descriptor.tables.includes(relative[0]!);
    return relative.length === 1;
  }
  async tableDescriptor(table: string): Promise<ProjectionDescriptor | null> {
    if (this.definition.provider === "sqlite") return this.sqlite.describeTable(this.definition, table);
    if (this.definition.provider === "postgres") return this.postgres.describeTable(this.definition, table);
    return null;
  }
  async tableSnapshot(treePath: string, table: string, context: ProjectionProviderContext): Promise<NodeSnapshot | null> {
    const descriptor = await this.tableDescriptor(table);
    if (!descriptor) return null;
    const revision = descriptor.revision ?? `external:${this.definition.provider}:${table}`;
    const schema = (descriptor.schemaRevision ?? providerDigest({ columns: descriptor.columns, identityRule: descriptor.identityRule })) as Hash;
    return {
      ref: { tree: context.tree, path: treePath, stableKey: null },
      name: table,
      revision,
      properties: {},
      capabilities: {
        children: {
          revision,
          schema,
          representation: descriptor.representation,
          ...(descriptor.total === undefined ? {} : { total: descriptor.total }),
          writable: descriptor.editable && context.writable,
        },
      },
      materialization: "available",
      diagnostics: descriptor.diagnostics ?? [],
      observedThrough: context.observedThrough,
    };
  }
  async tableItems(parentPath: string, context: ProjectionProviderContext): Promise<NodeSummary[]> {
    const descriptor = await this.descriptor();
    const snapshots = await Promise.all((descriptor.tables ?? []).map((table) => this.tableSnapshot(
      `${parentPath === "/" ? "" : parentPath}/${table}`,
      table,
      context,
    )));
    return snapshots.filter((item): item is NodeSnapshot => item !== null).map(({ observedThrough: _, content: _content, ...item }) => item);
  }
  async children(
    treePath: string,
    parent: NodeRef,
    context: ProjectionProviderContext,
    cursor: string | null,
    table?: string,
    limit = 100,
  ): Promise<ChildrenPage> {
    const page = await this.page(treePath, cursor, limit, table);
    return {
      parent,
      items: page.rows.map((row) => rowSummary(row, page, treePath, context)),
      nextCursor: page.nextCursor,
      observedThrough: context.observedThrough,
    };
  }
  async resolveChild(
    parentPath: string,
    ref: { path: string; stableKey: string | null },
    context: ProjectionProviderContext,
    table?: string,
  ): Promise<NodeSnapshot | null> {
    if (this.definition.provider === "postgres") return null;
    const result = this.definition.provider === "sqlite"
      ? table ? await this.sqlite.resolve(this.definition, parentPath, table, ref) : null
      : await this.files.resolve(this.definition, parentPath, ref);
    if (!result) return null;
    const summary = rowSummary(result.row, result.page, parentPath, context);
    if (result.page.rowContent !== "markdown") return { ...summary, observedThrough: context.observedThrough };
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
    parentPath: string,
    ref: { path: string; stableKey: string | null },
    table?: string,
  ): Promise<ProjectionWriteTarget | null> {
    if (this.definition.provider === "postgres") return null;
    const result = this.definition.provider === "sqlite"
      ? table ? await this.sqlite.resolve(this.definition, parentPath, table, ref) : null
      : await this.files.resolve(this.definition, parentPath, ref);
    if (!result) return null;
    return {
      directory: this.directory,
      parentPath,
      storage: this.definition.provider === "markdown" ? "physical" : "provider",
      ...(table ? { table } : {}),
      path: `${parentPath === "/" ? "" : parentPath}/${result.row.path}`,
      stableKey: result.row.stableKey,
      revision: result.row.revision ?? providerDigest({ key: result.row.key, properties: result.row.values }),
      ...(result.page.sourceRevision ? { sourceRevision: result.page.sourceRevision } : {}),
      properties: (jsonValue(result.row.values) ?? {}) as Record<string, JSONValue>,
      ...(result.page.identityRule ? { identityRule: result.page.identityRule } : {}),
      writable: result.page.editable && (!result.page.identityRule || result.row.stableKey !== null),
    };
  }
  async preparePropertyWrite(
    target: ProjectionWriteTarget,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    mutation: { scope: string; id: string },
  ): Promise<ProjectionPropertyPreparation> {
    if (this.definition.provider === "markdown") {
      return { storage: "physical", ...(await this.files.prepareMarkdown(this.definition, properties)) };
    }
    if (this.definition.provider === "sqlite") {
      return { storage: "provider", write: await this.sqlite.prepareWrite(this.definition, target, basePropertiesRevision, properties, mutation) };
    }
    if (this.definition.provider === "csv" || this.definition.provider === "json" || this.definition.provider === "jsonl") {
      return { storage: "provider", write: await this.files.prepareWrite(this.definition, target, basePropertiesRevision, properties) };
    }
    throw new ProjectionProviderError("read-only", "This provider is read-only");
  }
  async schemaTypes(): Promise<
    | { kind: "collection" }
    | { kind: "database"; tables: Record<string, Record<string, string>> | null }
  > {
    if (this.definition.provider !== "postgres") return { kind: "collection" };
    try { return { kind: "database", tables: await this.postgres.schema(this.definition) }; }
    catch { return { kind: "database", tables: null }; }
  }
  private async page(treePath: string, cursor: string | null, limit: number, table?: string): Promise<LoadedProjectionSlice> {
    if (this.definition.diagnostics.some((item) => item.severity === "error")) {
      return {
        path: treePath, columns: [], rows: [], nextCursor: null,
        revision: revisionOf(JSON.stringify(this.definition.diagnostics)), schemaRevision: revisionOf("invalid-collection-schema"),
        diagnostics: this.definition.diagnostics, editable: false,
      };
    }
    if (this.definition.provider === "sqlite") {
      if (!table) throw new Error("A SQLite table is required");
      return this.sqlite.page(this.definition, treePath, table, cursor, limit);
    }
    if (this.definition.provider === "postgres") {
      if (!table) throw new Error("A Postgres table is required");
      return this.postgres.page(this.definition, treePath, table, cursor, limit);
    }
    return this.files.page(this.definition, treePath, cursor, limit);
  }
}
/** Durable owner of projection discovery, driver resources, and driver lifecycles. */
export class ProjectionProviderHost implements AsyncDisposable {
  private files: FileProjectionDriver;
  private sqlite = new SQLiteProjectionDriver();
  private postgres: PostgresProjectionDriver;
  constructor(schemas = new SchemaSandbox(), connections = new ConnectionStore()) {
    this.files = new FileProjectionDriver(schemas);
    this.postgres = new PostgresProjectionDriver(connections);
  }
  async open(directory: string): Promise<ProjectionReadSession | null> {
    const definition = await detectProjection(directory);
    return definition ? new ProjectionReadSession(directory, definition, this.files, this.sqlite, this.postgres) : null;
  }
  async descriptor(directory: string): Promise<ProjectionDescriptor | null> {
    return (await this.open(directory))?.descriptor() ?? null;
  }
  async fileRollupDescriptor(directory: string, sourceName: string) {
    const definition = await detectProjection(directory);
    if (!definition || definition.provider === "sqlite" || definition.provider === "postgres") return null;
    return this.files.fileRollupDescriptor(definition, sourceName);
  }
  async schemaTypes(directory: string) {
    return (await this.open(directory))?.schemaTypes() ?? null;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.files[Symbol.asyncDispose]();
  }
}
