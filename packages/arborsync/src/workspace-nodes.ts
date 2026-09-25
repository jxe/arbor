import type {
  ChildrenPage,
  LocalTreeDescriptor,
  NodeRef,
  NodeResponse,
  TreeID,
} from "@overstory/protocol";
import { canonicalNodePath, isPageID, markdownStableKey, ProtocolError } from "@overstory/protocol";
import type { WorkspaceDiscovery, WorkspaceFS } from "@overstory/fs";
import { ProjectionProviderError } from "@overstory/apps-runtime/collections";
import { basename } from "node:path";
import { EventBus } from "./events.ts";
import { FilesystemNodeSurface } from "./filesystem-node-surface.ts";
import { generateTreeTypes, generatedTypeDeclarationPath } from "./generated-types.ts";
import { NodeProviderRouter } from "./node-provider-router.ts";
import type { ExpandedNode } from "./node-sampling.ts";

/**
 * Node projection, stable-key resolution, and generated types over the folder's shared filesystem.
 * Read-only. `snapshot` and `children` have no production caller; they stay as the folder node
 * provider that `generic-node-query.test.ts` exercises until Apps 005 decides how the apps runtime
 * reads a folder.
 */
export class WorkspaceNodes implements AsyncDisposable {
  private surface: FilesystemNodeSurface;
  private provider: NodeProviderRouter;
  /** First discovered owner of each stable key, every owner of it, and each uniquely owned path's key. */
  private ownerByStableKey = new Map<string, string>();
  private ownersByStableKey = new Map<string, readonly string[]>();
  private stableKeyByPath = new Map<string, string>();
  constructor(readonly root: string, private readonly stateDirectory: string,
    readonly fs: WorkspaceFS, readonly tree: TreeID, readonly events: EventBus,
    private readonly descriptor: () => LocalTreeDescriptor) {
    this.surface = new FilesystemNodeSurface({
      tree: this.tree,
      enclosingTree: () => this.descriptor(),
      fs: () => this.fs,
      resolveRef: (ref) => this.resolveRef(ref),
      rootName: basename(this.root),
      writable: async (path) => {
        const resolved = await this.fs.resolve(path);
        return resolved.writable && this.descriptor().access !== "read";
      },
      writableNode: (node) => node.writable && this.descriptor().access !== "read",
      inspectDocument: ({ path, document }) => {
        const stableKey = this.registerStableKey(path, document.frontmatter.id);
        return this.duplicateKeyDiagnostics(path, stableKey);
      },
      notFound: (path) => new ProtocolError("not-found", `Node not found: ${path}`, 404, { path }),
      invalidChildren: (path) => new ProtocolError("invalid-reference", `${path} does not have children`, 400, { path }),
    });
    this.provider = new NodeProviderRouter(this.surface);
  }
  async initialize(discovery: WorkspaceDiscovery, recursive: boolean): Promise<void> {
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    if (recursive) await this.generateTypes(discovery);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.provider[Symbol.asyncDispose]();
  }
  mutationRef(path: string): NodeRef {
    return { tree: this.tree, path, stableKey: this.stableKeyByPath.get(path) ?? null };
  }

  describeProtocolCollectionFile(directory: string, sourceName: string) {
    return this.provider.collectionFileDescriptor(directory, sourceName);
  }

  async snapshot(ref: NodeRef): Promise<NodeResponse> {
    const observedThrough = this.events.currentCursor();
    return this.provider.snapshot(ref, observedThrough);
  }

  async children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    const observedThrough = this.events.currentCursor();
    try {
      return await this.provider.children(ref, cursor ?? null, observedThrough);
    } catch (error) {
      if (error instanceof ProjectionProviderError && error.code === "invalid-cursor") {
        throw new ProtocolError("invalid-reference", error.message, 400, { path: ref.path });
      }
      throw error;
    }
  }

  private async resolveRef(ref: NodeRef): Promise<string> {
    if (!ref.stableKey) return canonicalNodePath(ref.path);
    const owners = this.ownersByStableKey.get(ref.stableKey) ?? [];
    if (owners.length > 1) {
      throw new ProtocolError("duplicate-page-id", `Stable key ${ref.stableKey} has multiple owners`, 409, {
        owners: [...owners],
      });
    }
    const owner = owners[0] ?? this.ownerByStableKey.get(ref.stableKey);
    if (!owner) {
      throw new ProtocolError("not-found", `No node owns stable key ${ref.stableKey}`, 404, {
        path: ref.path,
      });
    }
    return owner;
  }

  async generateTypes(discovery?: WorkspaceDiscovery): Promise<void> {
    return generateTreeTypes({ root: this.root, stateDirectory: this.stateDirectory, fs: this.fs, provider: this.provider, discovery });
  }

  generatedTypeDeclarationPath(): string {
    return generatedTypeDeclarationPath(this.stateDirectory);
  }

  /** Record a document's frontmatter `id`, the only stable key a Markdown folder declares. */
  private registerStableKey(path: string, id: unknown): string | null {
    if (!isPageID(id)) return null;
    const stableKey = markdownStableKey(id);
    const owners = [...(this.ownersByStableKey.get(stableKey) ?? [])];
    if (!owners.includes(path)) owners.push(path);
    owners.sort();
    this.ownersByStableKey.set(stableKey, owners);
    if (!this.ownerByStableKey.has(stableKey)) this.ownerByStableKey.set(stableKey, path);
    if (owners.length === 1) this.stableKeyByPath.set(path, stableKey);
    else for (const owner of owners) if (this.stableKeyByPath.get(owner) === stableKey) this.stableKeyByPath.delete(owner);
    return stableKey;
  }

  /** Adopt discovery's Markdown-private ID maps as stable-key owner maps. */
  adoptIDMaps(pagePathsByID: ReadonlyMap<string, string>, pageIDOwners: ReadonlyMap<string, readonly string[]>): void {
    this.ownerByStableKey = new Map([...pagePathsByID].map(([id, path]) => [markdownStableKey(id), path]));
    this.ownersByStableKey = new Map([...pageIDOwners].map(([id, owners]) => [markdownStableKey(id), owners]));
    this.stableKeyByPath = new Map();
    for (const [stableKey, path] of this.ownerByStableKey) {
      if ((this.ownersByStableKey.get(stableKey)?.length ?? 1) <= 1) this.stableKeyByPath.set(path, stableKey);
    }
  }

  private duplicateKeyDiagnostics(path: string, stableKey: string | null): ExpandedNode["diagnostics"] {
    const owner = stableKey ? this.ownerByStableKey.get(stableKey) : undefined;
    return stableKey && owner !== path
      ? [{ code: "duplicate-page-id", message: `Stable key ${stableKey} is also used by ${owner}`, path, severity: "error" }]
      : [];
  }
}
