import type { ChildrenPage, JSONValue, LocalTreeDescriptor, NodeRef, NodeResponse, NodeSnapshot, NodeSummary, TreeRef } from "@arbor/core";
import { canonicalNodePath } from "@arbor/core";
import {
  CollectionStore,
  type ChildSetDescriptor,
  type CollectionWriteTarget,
  type PreparedFilePropertyWrite,
} from "@arbor/stores";

export interface PhysicalChildAdapter {
  readonly tree: TreeRef;
  enclosingTree?(): LocalTreeDescriptor;
  resolve(path: string): Promise<{
    directoryPath?: string;
    writable: boolean;
  }>;
  snapshot(ref: NodeRef, observedThrough: string): Promise<NodeResponse>;
  children(
    ref: NodeRef,
    cursor: string | null,
    observedThrough: string,
    additionalItems?: readonly NodeSummary[],
  ): Promise<ChildrenPage>;
  writable(path: string): Promise<boolean>;
}

interface CollectionLocation {
  directory: string;
  parentPath: string;
  summary: ChildSetDescriptor;
  table?: string;
}

/**
 * Provider-neutral logical child boundary shared by managed and untracked
 * filesystem scopes. CollectionStore owns backing semantics; the injected
 * adapter owns expanded filesystem nodes, PageID healing, and access ceilings.
 */
export class ChildProvider {
  constructor(
    private readonly physical: PhysicalChildAdapter,
    private readonly collections = new CollectionStore(),
  ) {}

  private async context(path: string, observedThrough: string) {
    return {
      tree: this.physical.tree,
      observedThrough,
      writable: await this.physical.writable(path),
      readPhysical: (physicalPath: string) => this.physical.snapshot({
        tree: this.physical.tree,
        path: physicalPath,
        stableKey: null,
      }, observedThrough),
    };
  }

  private response(snapshot: NodeSnapshot): NodeResponse {
    return {
      ...snapshot,
      ...(this.physical.enclosingTree ? { enclosingTree: this.physical.enclosingTree() } : {}),
    };
  }

  private async directCollection(path: string): Promise<CollectionLocation | null> {
    const resolved = await this.physical.resolve(path);
    if (!resolved.directoryPath) return null;
    const summary = await this.collections.summary(resolved.directoryPath).catch(() => null);
    return summary ? { directory: resolved.directoryPath, parentPath: path, summary } : null;
  }

  private async table(path: string): Promise<CollectionLocation | null> {
    if (path === "/") return null;
    const slash = path.lastIndexOf("/");
    const parentPath = path.slice(0, slash) || "/";
    const table = path.slice(slash + 1);
    const parent = await this.physical.resolve(parentPath);
    if (!parent.directoryPath) return null;
    const summary = await this.collections.summary(parent.directoryPath).catch(() => null);
    if (!summary?.tables?.includes(table)) return null;
    return { directory: parent.directoryPath, parentPath: path, summary, table };
  }

  private async row(ref: NodeRef): Promise<CollectionLocation | null> {
    const path = canonicalNodePath(ref.path);
    if (path === "/") return null;
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const direct = await this.directCollection(parentPath);
    if (direct && direct.summary.backing !== "postgres" && direct.summary.backing !== "sqlite") return direct;
    return this.table(parentPath);
  }

  async snapshot(ref: NodeRef, observedThrough: string): Promise<NodeResponse> {
    const path = canonicalNodePath(ref.path);
    const row = await this.row({ ...ref, path });
    if (row) {
      const result = await this.collections.resolveChild(
        row.directory,
        row.parentPath,
        { path, stableKey: ref.stableKey },
        await this.context(row.parentPath, observedThrough),
        row.table,
      );
      if (result) return this.response(result);
    }
    const table = await this.table(path);
    if (table && ref.stableKey === null) {
      const result = await this.collections.tableSnapshot(
        table.directory,
        path,
        table.table!,
        await this.context(table.parentPath, observedThrough),
      );
      if (result) return this.response(result);
    }
    return this.physical.snapshot({ ...ref, path }, observedThrough);
  }

  async children(ref: NodeRef, cursor: string | null, observedThrough: string): Promise<ChildrenPage> {
    const path = canonicalNodePath(ref.path);
    const direct = await this.directCollection(path);
    if (direct) {
      const context = await this.context(path, observedThrough);
      if (!direct.summary.tables?.length) {
        const parent = (await this.snapshot({ ...ref, path }, observedThrough)).ref;
        return this.collections.children(direct.directory, path, parent, context, cursor);
      }
      const tables = await this.collections.tableItems(direct.directory, path, context);
      return this.physical.children({ ...ref, path }, cursor, observedThrough, tables);
    }
    const table = await this.table(path);
    if (table) {
      const parent = (await this.snapshot({ ...ref, path }, observedThrough)).ref;
      return this.collections.children(
        table.directory,
        path,
        parent,
        await this.context(table.parentPath, observedThrough),
        cursor,
        100,
        table.table,
      );
    }
    return this.physical.children({ ...ref, path }, cursor, observedThrough);
  }

  async writeTarget(ref: NodeRef): Promise<CollectionWriteTarget | null> {
    const path = canonicalNodePath(ref.path);
    const location = await this.row({ ...ref, path });
    if (!location) return null;
    const target = await this.collections.writeTarget(
      location.directory,
      location.parentPath,
      { path, stableKey: ref.stableKey },
      location.table,
    );
    if (!target) return null;
    return { ...target, writable: target.writable && await this.physical.writable(location.parentPath) };
  }

  prepareMarkdownProperties(directory: string, properties: Record<string, JSONValue>) {
    return this.collections.prepareMarkdownProperties(directory, properties);
  }

  prepareFileProperties(
    target: CollectionWriteTarget,
    ref: NodeRef,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
  ): Promise<PreparedFilePropertyWrite> {
    return this.collections.prepareFileProperties(target, ref, basePropertiesRevision, properties);
  }

  commitFileProperties(prepared: PreparedFilePropertyWrite) {
    return this.collections.commitFileProperties(prepared);
  }

  writeSQLiteProperties(
    target: CollectionWriteTarget,
    ref: NodeRef,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    mutation: { scope: string; id: string },
  ) {
    if (target.backing !== "sqlite" || !target.table) throw new Error("The provider target is not a SQLite row");
    return this.collections.writeProperties(
      target.directory,
      target.parentPath,
      ref,
      basePropertiesRevision,
      properties,
      target.table,
      mutation,
    );
  }

  summary(directory: string) { return this.collections.summary(directory); }
  fileRollupDescriptor(directory: string, sourceName: string) {
    return this.collections.fileRollupDescriptor(directory, sourceName);
  }
  postgresSchema(directory: string) { return this.collections.postgresSchema(directory); }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.collections[Symbol.asyncDispose]();
  }
}
