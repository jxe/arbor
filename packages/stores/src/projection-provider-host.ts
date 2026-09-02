import { semanticRequestDigest } from "@arbor/core";
import { toJSONValue } from "@arbor/core";
import type { ChildrenPage, Hash, JSONValue, NodeRef, NodeSnapshot, NodeSummary } from "@arbor/core";
import { revisionOf } from "@arbor/core";
import { ConnectionStore } from "./connections.ts";
import { detectProjection } from "./providers/discovery.ts";
import { FileProjectionDriver } from "./providers/file-provider.ts";
import { PostgresProjectionDriver } from "./providers/postgres-provider.ts";
import { SQLiteProjectionDriver } from "./providers/sqlite-provider.ts";
import {
  invalidDescriptor,
  ProjectionProviderError,
  type LoadedProjectionSlice,
  type ProjectionDefinition,
  type ProjectionDescriptor,
  type ProjectionPropertyPreparation,
  type ProjectionProvider,
  type ProjectionProviderContext,
  type ProjectionProviderKind,
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
  const properties = (toJSONValue(row.values) ?? {}) as Record<string, JSONValue>;
  const revision = row.revision ?? semanticRequestDigest({ key: row.key, properties });
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
    private provider: ProjectionProvider,
  ) {}
  private get invalid(): boolean {
    return this.definition.diagnostics.some((item) => item.severity === "error");
  }
  async descriptor(): Promise<ProjectionDescriptor> {
    if (this.invalid) return invalidDescriptor(this.definition);
    return this.provider.describe(this.definition);
  }
  /** Whether this projection presents table subtrees rather than a flat row set. */
  async hasTables(): Promise<boolean> {
    if (!this.provider.describeTable) return false;
    return (await this.descriptor()).tables !== undefined;
  }
  /** The table segment when `relative` names a table or a row within one. */
  async tableFor(relative: readonly string[]): Promise<string | undefined> {
    if (!relative.length || !this.provider.describeTable) return undefined;
    const descriptor = await this.descriptor();
    return descriptor.tables?.includes(relative[0]!) ? relative[0] : undefined;
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
    return this.provider.describeTable ? this.provider.describeTable(this.definition, table) : null;
  }
  async tableSnapshot(treePath: string, table: string, context: ProjectionProviderContext): Promise<NodeSnapshot | null> {
    const descriptor = await this.tableDescriptor(table);
    if (!descriptor) return null;
    const revision = descriptor.revision ?? `external:${this.definition.provider}:${table}`;
    const schema = (descriptor.schemaRevision ?? semanticRequestDigest({ columns: descriptor.columns, identityRule: descriptor.identityRule })) as Hash;
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
  private async resolveRow(parentPath: string, ref: { path: string; stableKey: string | null }, table?: string) {
    return this.provider.resolve ? this.provider.resolve(this.definition, parentPath, ref, table) : null;
  }
  async resolveChild(
    parentPath: string,
    ref: { path: string; stableKey: string | null },
    context: ProjectionProviderContext,
    table?: string,
  ): Promise<NodeSnapshot | null> {
    const result = await this.resolveRow(parentPath, ref, table);
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
    const result = await this.resolveRow(parentPath, ref, table);
    if (!result) return null;
    return {
      directory: this.directory,
      parentPath,
      storage: this.provider.rowStorage?.(this.definition) ?? "provider",
      ...(table ? { table } : {}),
      path: `${parentPath === "/" ? "" : parentPath}/${result.row.path}`,
      stableKey: result.row.stableKey,
      revision: result.row.revision ?? semanticRequestDigest({ key: result.row.key, properties: result.row.values }),
      ...(result.page.sourceRevision ? { sourceRevision: result.page.sourceRevision } : {}),
      properties: (toJSONValue(result.row.values) ?? {}) as Record<string, JSONValue>,
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
    if (this.provider.rowStorage?.(this.definition) === "physical") {
      if (!this.provider.prepareMarkdown) throw new ProjectionProviderError("read-only", "This provider is read-only");
      return { storage: "physical", ...(await this.provider.prepareMarkdown(this.definition, properties)) };
    }
    if (!this.provider.prepareWrite) throw new ProjectionProviderError("read-only", "This provider is read-only");
    return {
      storage: "provider",
      write: await this.provider.prepareWrite(this.definition, target, basePropertiesRevision, properties, mutation),
    };
  }
  async schemaTypes(): Promise<
    | { kind: "collection" }
    | { kind: "database"; tables: Record<string, Record<string, string>> | null }
  > {
    if (!this.provider.schema) return { kind: "collection" };
    try { return { kind: "database", tables: await this.provider.schema(this.definition) }; }
    catch { return { kind: "database", tables: null }; }
  }
  private async page(treePath: string, cursor: string | null, limit: number, table?: string): Promise<LoadedProjectionSlice> {
    if (this.invalid) {
      return {
        path: treePath, columns: [], rows: [], nextCursor: null,
        revision: revisionOf(JSON.stringify(this.definition.diagnostics)), schemaRevision: revisionOf("invalid-collection-schema"),
        diagnostics: this.definition.diagnostics, editable: false,
      };
    }
    return this.provider.page(this.definition, treePath, cursor, limit, table);
  }
}
/** Durable owner of projection discovery, the provider registry, and driver lifecycles. */
export class ProjectionProviderHost implements AsyncDisposable {
  private readonly drivers: ProjectionProvider[];
  private readonly providers = new Map<ProjectionProviderKind, ProjectionProvider>();
  constructor(schemas = new SchemaSandbox(), connections = new ConnectionStore()) {
    this.drivers = [
      new FileProjectionDriver(schemas),
      new SQLiteProjectionDriver(),
      new PostgresProjectionDriver(connections),
    ];
    for (const driver of this.drivers) {
      for (const kind of driver.kinds) this.providers.set(kind, driver);
    }
  }
  private provider(kind: ProjectionProviderKind): ProjectionProvider {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`No projection provider is registered for ${kind}`);
    return provider;
  }
  async open(directory: string): Promise<ProjectionReadSession | null> {
    const definition = await detectProjection(directory);
    return definition ? new ProjectionReadSession(directory, definition, this.provider(definition.provider)) : null;
  }
  async descriptor(directory: string): Promise<ProjectionDescriptor | null> {
    return (await this.open(directory))?.descriptor() ?? null;
  }
  async fileRollupDescriptor(directory: string, sourceName: string) {
    const definition = await detectProjection(directory);
    if (!definition) return null;
    const provider = this.provider(definition.provider);
    return provider.fileRollupDescriptor ? provider.fileRollupDescriptor(definition, sourceName) : null;
  }
  async schemaTypes(directory: string) {
    return (await this.open(directory))?.schemaTypes() ?? null;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const driver of this.drivers) await driver[Symbol.asyncDispose]?.();
  }
}
