import type { ChildrenPage, Hash, JSONValue, LocalTreeDescriptor, NodeRef, NodeResponse, NodeSummary, TreeRef } from "@arbor/core";
import { canonicalNodePath, revisionOf } from "@arbor/core";
import {
  ProjectionProviderHost,
  type ProjectionPropertyPreparation,
  type ProjectionReadSession,
  type ProjectionWriteTarget,
} from "@arbor/stores";
export interface PhysicalNodeSurface {
  readonly tree: TreeRef;
  enclosingTree?(): LocalTreeDescriptor | undefined;
  resolve(path: string): Promise<{ directoryPath?: string; writable: boolean }>;
  snapshot(ref: NodeRef, observedThrough: string): Promise<NodeResponse>;
  children(
    ref: NodeRef,
    cursor: string | null,
    observedThrough: string,
    additionalItems?: readonly NodeSummary[],
  ): Promise<ChildrenPage>;
  writable(path: string): Promise<boolean>;
}
interface ProviderMount {
  session: ProjectionReadSession;
  mountPath: string;
  relative: string[];
}
/** Routes logical node operations to the nearest owning projection or the physical surface. */
export class NodeProviderRouter implements AsyncDisposable {
  constructor(
    private readonly physical: PhysicalNodeSurface,
    private readonly providers = new ProjectionProviderHost(),
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
  private response(response: NodeResponse): NodeResponse {
    const enclosingTree = this.physical.enclosingTree?.();
    return {
      ...response,
      ...(enclosingTree ? { enclosingTree } : {}),
    };
  }
  private async mount(path: string): Promise<ProviderMount | null> {
    const canonical = canonicalNodePath(path);
    const segments = canonical === "/" ? [] : canonical.slice(1).split("/");
    for (let length = segments.length; length >= 0; length -= 1) {
      const mountPath = length === 0 ? "/" : `/${segments.slice(0, length).join("/")}`;
      const resolved = await this.physical.resolve(mountPath).catch(() => null);
      if (!resolved?.directoryPath) continue;
      const session = await this.providers.open(resolved.directoryPath).catch(() => null);
      if (!session) continue;
      const relative = segments.slice(length);
      if (await session.owns(relative)) return { session, mountPath, relative };
    }
    return null;
  }
  private async decorateRoot(response: NodeResponse, mount: ProviderMount): Promise<NodeResponse> {
    const descriptor = await mount.session.descriptor();
    if (descriptor.diagnostics?.some((item) => item.severity === "error")) {
      return this.response({ ...response, diagnostics: [...response.diagnostics, ...descriptor.diagnostics] });
    }
    const providerRevision = descriptor.revision;
    const revision = providerRevision ? revisionOf(`${response.revision}\0${providerRevision}`) : response.revision;
    const childrenRevision = providerRevision ?? response.capabilities.children?.revision ?? response.revision;
    return this.response({
      ...response,
      revision,
      capabilities: {
        ...response.capabilities,
        children: {
          revision: childrenRevision,
          ...(descriptor.schemaRevision ? { schema: descriptor.schemaRevision as Hash } : {}),
          representation: descriptor.representation,
          ...(descriptor.total === undefined ? {} : { total: descriptor.total }),
          writable: descriptor.editable && await this.physical.writable(mount.mountPath),
        },
      },
      diagnostics: [...response.diagnostics, ...(descriptor.diagnostics ?? [])],
    });
  }
  async snapshot(ref: NodeRef, observedThrough: string): Promise<NodeResponse> {
    const path = canonicalNodePath(ref.path);
    const mount = await this.mount(path);
    if (!mount) return this.physical.snapshot({ ...ref, path }, observedThrough);
    if (mount.relative.length === 0) {
      return this.decorateRoot(await this.physical.snapshot({ ...ref, path }, observedThrough), mount);
    }
    const descriptor = await mount.session.descriptor();
    if (descriptor.tables?.includes(mount.relative[0]!) && mount.relative.length === 1 && ref.stableKey === null) {
      const table = await mount.session.tableSnapshot(path, mount.relative[0]!, await this.context(mount.mountPath, observedThrough));
      if (table) return this.response(table);
    }
    const table = descriptor.tables?.includes(mount.relative[0]!) ? mount.relative[0] : undefined;
    const parentPath = table ? `${mount.mountPath === "/" ? "" : mount.mountPath}/${table}` : mount.mountPath;
    const result = await mount.session.resolveChild(
      parentPath,
      { path, stableKey: ref.stableKey },
      await this.context(parentPath, observedThrough),
      table,
    );
    return result ? this.response(result) : this.physical.snapshot({ ...ref, path }, observedThrough);
  }
  async children(ref: NodeRef, cursor: string | null, observedThrough: string): Promise<ChildrenPage> {
    const path = canonicalNodePath(ref.path);
    const mount = await this.mount(path);
    if (!mount) return this.physical.children({ ...ref, path }, cursor, observedThrough);
    const descriptor = await mount.session.descriptor();
    if (mount.relative.length === 0) {
      if (descriptor.diagnostics?.some((item) => item.severity === "error")) {
        return this.physical.children({ ...ref, path }, cursor, observedThrough);
      }
      const context = await this.context(path, observedThrough);
      if (!descriptor.tables?.length) {
        const parent = (await this.snapshot({ ...ref, path }, observedThrough)).ref;
        return mount.session.children(path, parent, context, cursor);
      }
      const tables = await mount.session.tableItems(path, context);
      return this.physical.children({ ...ref, path }, cursor, observedThrough, tables);
    }
    const table = mount.relative.length === 1 && descriptor.tables?.includes(mount.relative[0]!)
      ? mount.relative[0] : undefined;
    if (table) {
      const parent = (await this.snapshot({ ...ref, path }, observedThrough)).ref;
      return mount.session.children(path, parent, await this.context(path, observedThrough), cursor, table);
    }
    return this.physical.children({ ...ref, path }, cursor, observedThrough);
  }
  async writeTarget(ref: NodeRef): Promise<ProjectionWriteTarget | null> {
    const path = canonicalNodePath(ref.path);
    const mount = await this.mount(path);
    if (!mount || mount.relative.length === 0) return null;
    const descriptor = await mount.session.descriptor();
    const table = descriptor.tables?.includes(mount.relative[0]!) ? mount.relative[0] : undefined;
    const parentPath = table ? `${mount.mountPath === "/" ? "" : mount.mountPath}/${table}` : mount.mountPath;
    const target = await mount.session.writeTarget(parentPath, { path, stableKey: ref.stableKey }, table);
    if (!target) return null;
    return { ...target, writable: target.writable && await this.physical.writable(parentPath) };
  }
  async preparePropertyWrite(
    target: ProjectionWriteTarget,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    mutation: { scope: string; id: string },
  ): Promise<ProjectionPropertyPreparation> {
    const session = await this.providers.open(target.directory);
    if (!session) throw new Error("The projection provider disappeared while the write was being prepared");
    return session.preparePropertyWrite(target, basePropertiesRevision, properties, mutation);
  }
  fileRollupDescriptor(directory: string, sourceName: string) {
    return this.providers.fileRollupDescriptor(directory, sourceName);
  }
  schemaTypes(directory: string) { return this.providers.schemaTypes(directory); }
  async [Symbol.asyncDispose](): Promise<void> { await this.providers[Symbol.asyncDispose](); }
}
