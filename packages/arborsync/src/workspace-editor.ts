import type {
  ArborBlock,
  ChildrenPage,
  LocalTreeDescriptor,
  NodeRef,
  NodeResponse,
  NodeWriteRequest,
  TreeID,
} from "@overstory/protocol";
import {
  canonicalNodePath,
  isPageID,
  pageIDFromStableKey,
  pageIDStableKey,
  resolveLogicalURL,
  rewriteLocalLinkPath,
} from "@overstory/protocol";
import { serializeMarkdown, ProtocolError } from "@overstory/protocol";
import {
  FsConflictError,
  type WorkspaceDiscovery,
  WorkspaceFS,
} from "@overstory/fs";
import { ProjectionProviderError } from "@overstory/apps-runtime/collections";
import { basename, posix } from "node:path";
import { EventBus } from "./events.ts";
import { FilesystemNodeSurface } from "./filesystem-node-surface.ts";
import { generateTreeTypes, generatedTypeDeclarationPath } from "./generated-types.ts";
import { NodeProviderRouter } from "./node-provider-router.ts";
import type { ExpandedNode } from "./node-sampling.ts";
import { RevisionConflictError } from "./node-sampling.ts";

/** Node projection, stable-key resolution, link healing, and generated types over the folder's shared filesystem. */
export class WorkspaceEditor implements AsyncDisposable {
  private surface: FilesystemNodeSurface;
  private provider: NodeProviderRouter;
  private idOwners = new Map<string, string>();
  private idOwnerSets = new Map<string, readonly string[]>();
  private pathPageIDs = new Map<string, string>();
  private healingTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
      inspectDocument: ({ path, revision, document }) => {
        const pageID = this.registerPageID(path, document.frontmatter.id);
        this.scheduleLinkHealing(path, revision, document);
        return this.pageIDDiagnostics(path, pageID);
      },
      childPageID: (path, discovered) => discovered ?? this.pathPageIDs.get(path),
      notFound: (path) => new ProtocolError("not-found", `Node not found: ${path}`, 404, { path }),
      invalidChildren: (path) => new ProtocolError("invalid-reference", `${path} does not have children`, 400, { path }),
    });
    this.provider = new NodeProviderRouter(this.surface);
  }
  async initialize(discovery: WorkspaceDiscovery, recursive: boolean): Promise<void> {
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    if (recursive) await this.generateTypes(discovery);
  }
  /** Stop delayed authored writes before the folder drains its object audit. */
  cancelPendingHealing(): void {
    for (const timer of this.healingTimers.values()) clearTimeout(timer);
    this.healingTimers.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.cancelPendingHealing();
    await this.provider[Symbol.asyncDispose]();
  }
  mutationRef(path: string, pageID?: string, stableKey?: string | null): NodeRef {
    return {
      tree: this.tree,
      path,
      stableKey: stableKey ?? (pageID ? pageIDStableKey(pageID) : this.pathPageIDs.get(path) ? pageIDStableKey(this.pathPageIDs.get(path)!) : null),
    };
  }

  describeWireCollectionFile(directory: string, sourceName: string) {
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

  private async expandedNode(inputPath: string): Promise<ExpandedNode> {
    return this.surface.expandedNode(inputPath);
  }

  private async write(
    inputPath: string,
    request: NodeWriteRequest,
    options: Parameters<WorkspaceFS["writeMarkdown"]>[2] = {},
  ): Promise<ExpandedNode> {
    try {
      await this.fs.writeMarkdown(inputPath, request, options);
      return this.expandedNode(inputPath);
    } catch (error) {
      if (error instanceof FsConflictError && error.details.code === "stale-revision") {
        throw new RevisionConflictError(await this.expandedNode(inputPath));
      }
      throw error;
    }
  }

  private async resolveRef(ref: NodeRef): Promise<string> {
    const pageID = pageIDFromStableKey(ref.stableKey);
    if (!ref.stableKey) return canonicalNodePath(ref.path);
    if (!pageID) {
      throw new ProtocolError("invalid-reference", "This workspace cannot resolve the supplied stable key", 400);
    }
    const owners = this.idOwnerSets.get(pageID) ?? [];
    if (owners.length > 1) {
      throw new ProtocolError("duplicate-page-id", `Stable key ${ref.stableKey} has multiple owners`, 409, {
        owners: [...owners],
      });
    }
    const owner = owners[0] ?? this.idOwners.get(pageID);
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

  private registerPageID(path: string, candidate: unknown): string | null {
    if (!isPageID(candidate)) return null;
    const owners = [...(this.idOwnerSets.get(candidate) ?? [])];
    if (!owners.includes(path)) owners.push(path);
    owners.sort();
    this.idOwnerSets.set(candidate, owners);
    if (!this.idOwners.has(candidate)) this.idOwners.set(candidate, path);
    if (owners.length === 1) this.pathPageIDs.set(path, candidate);
    else for (const owner of owners) if (this.pathPageIDs.get(owner) === candidate) this.pathPageIDs.delete(owner);
    return candidate;
  }

  adoptIDMaps(pagePathsByID: ReadonlyMap<string, string>, pageIDOwners: ReadonlyMap<string, readonly string[]>): void {
    this.idOwners = new Map(pagePathsByID);
    this.idOwnerSets = new Map(pageIDOwners);
    this.pathPageIDs = new Map();
    for (const [pageID, path] of this.idOwners) {
      if ((this.idOwnerSets.get(pageID)?.length ?? 1) <= 1) this.pathPageIDs.set(path, pageID);
    }
  }

  private pageIDDiagnostics(path: string, pageID: string | null): ExpandedNode["diagnostics"] {
    return pageID && this.idOwners.get(pageID) !== path
      ? [{ code: "duplicate-page-id", message: `Page ID ${pageID} is also used by ${this.idOwners.get(pageID)}`, path, severity: "error" }]
      : [];
  }

  private scheduleLinkHealing(treePath: string, revision: string, document: NonNullable<ExpandedNode["document"]>): void {
    const base = posix.dirname(treePath);
    const healTarget = (target: string): string => {
      const resolved = resolveLogicalURL(base, target);
      if (resolved?.kind !== "local") return target;
      let id = pageIDFromStableKey(resolved.stableKey) ?? resolved.legacyStableKeyCandidate;
      if (!id) return target;
      try { id = decodeURIComponent(id); } catch { return target; }
      const owner = this.idOwners.get(id);
      if (!owner) return target;
      return rewriteLocalLinkPath(base, target, owner) ?? target;
    };
    const healBlock = (block: ArborBlock): ArborBlock => {
      let changed = false;
      const content = (block.content ?? "").replace(/\]\(([^)]+)\)/g, (match, target: string) => {
        const healed = healTarget(target);
        if (healed === target) return match;
        changed = true;
        return `](${healed})`;
      });
      let props = block.props;
      if (block.type === "standaloneLink" && typeof block.props?.path === "string") {
        const originalPath = block.props.path;
        const path = healTarget(originalPath);
        if (path !== originalPath) {
          changed = true;
          props = { ...block.props, path };
        }
      }
      const children = block.children.map(healBlock);
      if (children.some((child, index) => child !== block.children[index])) changed = true;
      return changed ? { ...block, content, props, children } : block;
    };
    const blocks = document.blocks.map(healBlock);
    if (!blocks.some((block, index) => block !== document.blocks[index])) return;
    const pending = this.healingTimers.get(treePath);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(async () => {
      this.healingTimers.delete(treePath);
      try { await this.write(treePath, { baseRevision: revision, source: serializeMarkdown(document, blocks) }); } catch {}
    }, 750);
    this.healingTimers.set(treePath, timer);
  }
}
