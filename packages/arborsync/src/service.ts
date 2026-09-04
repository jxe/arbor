import { performance } from "node:perf_hooks";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  BacklinksPage,
  ChildrenPage,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeResponse,
  NodeSummary,
  RecoveryPage,
  SearchPage,
  LocalTreeDescriptor,
  LocatorResolution,
  SnapshotEnvelope,
  TreeRef,
  SourceEdit,
  WorkspaceOperation,
} from "@arbor/core";
import { LOCAL_TREE, SYSTEM_TREE, canonicalArborLocator, canonicalNodePath, pageIDFromStableKey, revisionOf, siblingMarkdownTreePath } from "@arbor/core";
import { FsConflictError, materializeTree, snapshotDirectory } from "@arbor/fs";
import {
  CanopyAccountStore,
  CommunityConfigStore,
  VisitedTreeStore,
  loadCanopyAccountConfigurations,
  loadLocalPlacements,
  replaceLocalPlacement,
  type LocalPlacement,
  type SharedTreePlacement,
} from "@arbor/stores";
import { WireClient, encodeObjectDeltaJSON, encodeWireObject, hashObject, objectDelta, type ObjectDelta, type RemoteTreeDescriptor } from "@arbor/wire";
import { WireProjection } from "@arbor/wire-projection";
import { claimCanopyAccountBootstrap, claimProfileBootstrap, createPairingBootstrap, forgetLocalAccount, resolveUserPath } from "./account-bootstrap.ts";
import { EventBus } from "./events.ts";
import { fsErrorCode } from "./fs-errors.ts";
import { FilesystemService, realOsPath } from "./fs-service.ts";
import { summarizeExpandedNode } from "./node-sampling.ts";
import {
  acceptedTreeObjects,
  clearPendingEditorAdmissions,
  clearPendingTreeUpdate,
  clearTreeConflict,
  pendingFromSnapshot,
  pendingTreeUpdate,
  savePendingEditorAdmission,
  savePendingTreeUpdate,
  saveAcceptedTreeObjects,
  snapshotFromConflictDraft,
  treeConflict,
  withDelta,
} from "./sync-state.ts";
import { SystemTreeProjection } from "./system-tree.ts";
import { TreeManager } from "./tree-manager.ts";
import { TreeSynchronizer } from "./tree-sync.ts";
import { ProtocolError, RevisionConflictError, Workspace, type ConfirmedSourcePatch, type WorkspaceOptions } from "./workspace.ts";
import { documentAdmissionBasis, freezeEditorAdmission } from "./editor-admission.ts";

export { resolveUserPath } from "./account-bootstrap.ts";

type ResolvedScope =
  | { kind: "root"; workspace: Workspace; ref: NodeRef }
  | { kind: "local"; path: string; ref: NodeRef }
  | { kind: "system"; path: string };

export interface ArborSyncDaemonOptions {
  autoSync?: boolean;
  monotonicNow?: () => number;
  /**
   * Fallback reconciliation interval. Live Wire watches drive synchronization;
   * this pass only covers a placement whose watch is disconnected.
   */
  syncIntervalMs?: number;
}

const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const WIRE_SYNC_TIMEOUT_MS = 60_000;

/**
 * The daemon's top-level coordinator: one process-wide event bus, a root
 * manager owning N per-root Workspaces, and a filesystem service for the
 * untracked `local` scope. Requests resolve here by tree scope — with
 * `local` references canonicalized into an owning live root when their
 * real path falls inside one — before dispatch.
 */
export class ArborSyncDaemon implements AsyncDisposable {
  readonly events: EventBus;
  readonly trees: TreeManager;
  readonly localFs: FilesystemService;
  readonly communityConfig = new CommunityConfigStore();
  readonly visitedTrees = new VisitedTreeStore();
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncStartupTimer?: ReturnType<typeof setTimeout>;
  private placementMoving = false;
  private placementMoveWaiters: Array<() => void> = [];
  private syncing = false;
  private syncRequested = false;
  private syncWaiters: Array<() => void> = [];
  private workspaceIOTails = new Map<string, Promise<void>>();
  private readonly treeSync: TreeSynchronizer;
  private remoteAuthorities = new Map<string, { locator: string; endpoint: string }>();
  private readonly systemTree: SystemTreeProjection;

  private constructor(events: EventBus, trees: TreeManager, options: ArborSyncDaemonOptions = {}) {
    this.events = events;
    this.trees = trees;
    this.localFs = new FilesystemService(events);
    this.systemTree = new SystemTreeProjection({
      trees,
      events,
      communityConfig: this.communityConfig,
      visitedTrees: this.visitedTrees,
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
    });
    this.treeSync = new TreeSynchronizer({
      trees,
      events,
      accountToken: (placement) => this.accountToken(placement),
      withWorkspaceIO: (workspace, run) => this.withWorkspaceIO(workspace, run),
      snapshotWorkspace: (workspace, client, remoteTrees) => this.snapshotWorkspace(workspace, client, remoteTrees),
      requestSync: () => this.syncAll(),
    });
    if (options.autoSync !== false) this.startAutoSync(options.syncIntervalMs);
  }

  private startAutoSync(syncIntervalMs?: number): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => { void this.syncAll(); }, syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
    this.syncStartupTimer = setTimeout(() => {
      this.syncStartupTimer = undefined;
      void this.syncAll();
    }, 0);
  }

  private async accountToken(placement: SharedTreePlacement): Promise<string | undefined> {
    if (placement.configurationTree) {
      return (await new CanopyAccountStore(placement.configurationTree).get())?.accountToken;
    }
    const configured = await this.communityConfig.get();
    return configured?.record.origin === placement.endpoint ? configured.accountToken : undefined;
  }

  private async accountClient(placement: SharedTreePlacement): Promise<WireClient> {
    return new WireClient(placement.endpoint, await this.accountToken(placement), { timeoutMs: WIRE_SYNC_TIMEOUT_MS });
  }

  static async open(
    sessionPath: string,
    options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {},
    daemon: ArborSyncDaemonOptions = {},
  ): Promise<ArborSyncDaemon> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    await trees.openSession(sessionPath, options);
    const service = new ArborSyncDaemon(events, trees, { ...daemon, autoSync: false });
    await trees.refreshConfiguration();
    if (daemon.autoSync !== false) service.startAutoSync(daemon.syncIntervalMs);
    return service;
  }

  /** Open system/account services without attaching Arbor to a filesystem session. */
  static async openControl(options: ArborSyncDaemonOptions = {}): Promise<ArborSyncDaemon> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    const autoSync = options.autoSync ?? false;
    const service = new ArborSyncDaemon(events, trees, { ...options, autoSync: false });
    await trees.refreshConfiguration();
    if (autoSync) service.startAutoSync(options.syncIntervalMs);
    return service;
  }

  get session(): Workspace {
    try {
      return this.trees.session;
    } catch {
      throw new ProtocolError("not-found", "No local browsing session is active", 409);
    }
  }

  /** Activates filesystem watching and durable identity for a client's browsing root. */
  async openSession(path: string): Promise<NodeResponse> {
    await this.trees.openSession(path);
    return this.snapshot({ tree: LOCAL_TREE, path, stableKey: null });
  }

  /** Resolve a reference's scope, canonicalizing placed refs into owning trees. */
  async resolveScope(ref: NodeRef): Promise<ResolvedScope> {
    const tree = ref.tree;
    const workspace = await this.trees.workspaceByTree(tree);
    if (workspace) {
      const mounted = this.trees.reservedBoundary(tree, canonicalNodePath(ref.path))
        ?? this.trees.localMountBoundary(tree, canonicalNodePath(ref.path));
      if (mounted) {
        const mountedWorkspace = await this.trees.workspaceByTree(mounted.tree);
        if (mountedWorkspace) {
          return {
            kind: "root",
            workspace: mountedWorkspace,
            ref: { tree: mounted.tree, path: mounted.treePath, stableKey: ref.stableKey },
          };
        }
      }
      return { kind: "root", workspace, ref };
    }
    if (tree === SYSTEM_TREE) {
      if (ref.stableKey !== null) throw new ProtocolError("invalid-reference", "System nodes do not have stable keys", 400);
      return { kind: "system", path: canonicalNodePath(ref.path) };
    }
    if (tree === LOCAL_TREE) {
      const canonical = canonicalNodePath(ref.path);
      const real = await realOsPath(canonical);
      const owner = await this.trees.ownerOf(real);
      if (owner) {
        const mounted = this.trees.reservedBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath))
          ?? this.trees.localMountBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath));
        if (mounted) {
          const mountedWorkspace = await this.trees.workspaceByTree(mounted.tree);
          if (mountedWorkspace) {
          return {
            kind: "root",
            workspace: mountedWorkspace,
            ref: { tree: mounted.tree, path: mounted.treePath, stableKey: ref.stableKey },
          };
          }
        }
        return {
          kind: "root",
          workspace: owner.workspace,
          ref: { tree: owner.workspace.tree, path: canonicalNodePath(owner.treePath), stableKey: ref.stableKey },
        };
      }
      // A Markdown node's physical representation is its `.md` sibling; a
      // symlinked sibling can land the logical node inside a live root.
      if (canonical !== "/") {
        const realSibling = await realOsPath(siblingMarkdownTreePath(canonical)).catch(() => null);
        const siblingOwner = realSibling ? await this.trees.ownerOf(realSibling) : null;
        if (siblingOwner && siblingOwner.treePath.endsWith(".md")) {
          return {
            kind: "root",
            workspace: siblingOwner.workspace,
            ref: { tree: siblingOwner.workspace.tree, path: canonicalNodePath(siblingOwner.treePath), stableKey: ref.stableKey },
          };
        }
      }
      return { kind: "local", path: real, ref: { tree: LOCAL_TREE, path: real, stableKey: ref.stableKey } };
    }
    throw new ProtocolError("not-found", `Unknown tree scope: ${tree}`, 404);
  }

  async snapshot(ref: NodeRef): Promise<NodeResponse> {
    if (ref.tree !== LOCAL_TREE && ref.tree !== SYSTEM_TREE && this.remoteAuthorities.has(ref.tree) && !await this.trees.workspaceByTree(ref.tree)) {
      const remote = this.remoteAuthorities.get(ref.tree)!;
      const locator = `${remote.locator.replace(/\/$/, "")}${ref.path === "/" ? "" : ref.path}`;
      return (await this.fetchRemoteProjection(locator, ref.stableKey)).snapshot;
    }
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") {
      return this.withWorkspaceIO(scope.workspace, async () => {
        const response = await scope.workspace.snapshot(scope.ref);
        const placement = this.trees.placementFor(scope.workspace.tree);
        if (
          !response.content
          || !response.capabilities.content?.writable
          || !placement?.update
          || !placement.ref
          || placement.access !== "write"
        ) return response;
        const wirePath = await scope.workspace.wireDocumentPath(scope.ref.path);
        const accepted = await snapshotDirectory(
          scope.workspace.root,
          this.trees.sharedBoundariesWithin(scope.workspace.root),
          this.trees.excludedMountsWithin(scope.workspace.root),
          (directory, sourceName) => scope.workspace.describeWireCollectionFile(directory, sourceName),
        );
        // Never attach an accepted basis to unsubmitted local filesystem state.
        if (accepted.root !== placement.ref) return response;
        return {
          ...response,
          admissionBasis: documentAdmissionBasis({
            ref: scope.ref,
            update: placement.update,
            snapshot: accepted,
            wirePath,
            contentRevision: response.capabilities.content.revision,
          }),
        };
      });
    }
    if (scope.kind === "local") return this.localFs.snapshot(scope.ref);
    return this.systemTree.systemSnapshot(scope.path);
  }

  async treeList(): Promise<SnapshotEnvelope<LocalTreeDescriptor[]>> {
    return { snapshot: await this.trees.descriptors(), observedThrough: this.events.currentCursor() };
  }

  async resolveLocator(locator: string): Promise<LocatorResolution> {
    if (locator.startsWith("system:")) {
      return { ref: { tree: SYSTEM_TREE, path: canonicalNodePath(`/${locator.slice("system:".length)}`), stableKey: null }, historical: false, observedThrough: this.events.currentCursor() };
    }
    if (!/^(?:https?|arbor):\/\//.test(locator)) {
      const absolute = resolveUserPath(locator);
      const scope = await this.resolveScope({ tree: LOCAL_TREE, path: absolute, stableKey: null });
      if (scope.kind === "root") {
        const enclosingTree = (await this.trees.descriptors()).find((tree) => tree.id === scope.workspace.tree);
        return { ref: scope.ref as import("@arbor/core").NodeRef, ...(enclosingTree ? { enclosingTree } : {}), historical: false, observedThrough: this.events.currentCursor() };
      }
      return { ref: { tree: LOCAL_TREE, path: absolute, stableKey: null }, historical: false, observedThrough: this.events.currentCursor() };
    }
    const parsed = new URL(locator);
    if (parsed.protocol === "arbor:" && parsed.hostname === "tree") {
      const [tree, ...segments] = parsed.pathname.split("/").filter(Boolean);
      if (!tree) throw new ProtocolError("invalid-request", "Raw tree locator requires a TreeID", 400);
      const descriptor = (await this.trees.descriptors()).find((candidate) => candidate.id === tree);
      if (!descriptor) throw new ProtocolError("not-found", `Unknown tree scope: ${tree}`, 404);
      return { ref: { tree, path: canonicalNodePath(`/${segments.map(decodeURIComponent).join("/")}`), stableKey: null }, enclosingTree: descriptor, historical: false, observedThrough: this.events.currentCursor() };
    }
    const origin = parsed.protocol === "arbor:"
      ? `${parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ? "http" : "https"}://${parsed.host}`
      : parsed.origin;
    const path = `/${parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/")}`;
    const configured = await this.communityConfig.get();
    const resolution = await new WireClient(origin, configured?.record.origin === origin ? configured.accountToken : undefined).resolve(path || "/");
    if (resolution.enclosingTree?.canonical) {
      this.remoteAuthorities.set(resolution.enclosingTree.id, { locator: canonicalArborLocator(resolution.enclosingTree.canonical), endpoint: origin });
    }
    const local = (await this.trees.descriptors()).find((tree) => tree.id === resolution.ref.tree);
    return { ...resolution, ...(local ? { enclosingTree: local } : {}) };
  }

  async remoteSnapshot(locatorInput: string): Promise<NodeResponse> {
    const locator = (() => {
      try { return new URL(locatorInput).href; }
      catch { return locatorInput; }
    })();
    try {
      const { snapshot } = await this.fetchRemoteProjection(locatorInput, null);
      await this.visitedTrees.remember(locator, snapshot);
      this.events.emit({ tree: SYSTEM_TREE, kind: "updated", ref: { tree: SYSTEM_TREE, path: "/visited", stableKey: null }, origin: "external" });
      return snapshot;
    } catch (error) {
      const cached = await this.visitedTrees.get(locator);
      if (cached && (error instanceof TypeError || (error instanceof ProtocolError && error.code === "not-found"))) {
        return {
          ...cached.snapshot,
          diagnostics: [
            ...cached.snapshot.diagnostics,
            {
              code: "cached-remote-visit",
              message: `Showing the copy visited on ${cached.visitedAt}; the community is currently unavailable.`,
              path: cached.snapshot.ref.path,
              severity: "warning",
            },
          ],
        };
      }
      throw error;
    }
  }

  /** Resolve one unplaced canonical URL into a read-only, in-memory node. */
  private async fetchRemoteProjection(
    locatorInput: string,
    stableKey: string | null,
  ): Promise<{ snapshot: NodeResponse; children: NodeSummary[] }> {
    let locator: URL;
    try { locator = new URL(locatorInput); }
    catch { throw new ProtocolError("invalid-reference", "Remote browsing requires an HTTP or Arbor URL", 400); }
    if (!["http:", "https:", "arbor:"].includes(locator.protocol) || (locator.protocol === "arbor:" && locator.hostname === "tree")) {
      throw new ProtocolError("invalid-reference", "Remote browsing requires a canonical community URL", 400);
    }
    const origin = locator.protocol === "arbor:"
      ? `${locator.hostname === "localhost" || locator.hostname === "127.0.0.1" ? "http" : "https"}://${locator.host}`
      : locator.origin;
    const canonicalPath = `/${locator.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/")}`;
    const configured = await this.communityConfig.get();
    const client = new WireClient(origin, configured?.record.origin === origin ? configured.accountToken : undefined);
    let remote: RemoteTreeDescriptor;
    let remotePath: string;
    try {
      const resolution = await client.resolve(canonicalPath || "/");
      if (!resolution.enclosingTree || !("root" in resolution.enclosingTree) || !("update" in resolution.enclosingTree)) {
        throw new Error("Server resolution omitted its enclosing tree");
      }
      remote = resolution.enclosingTree as RemoteTreeDescriptor;
      remotePath = resolution.ref.path;
      this.remoteAuthorities.set(remote.id, { locator: canonicalArborLocator(remote.canonical!), endpoint: origin });
    }
    catch (error) {
      if (error instanceof TypeError) throw error;
      throw new ProtocolError("not-found", `The Arbor page is unavailable: ${origin}${canonicalPath}`, 404);
    }

    const canonical = remote.canonical!;
    const observedThrough = this.events.currentCursor();
    const enclosingTree: LocalTreeDescriptor = {
      id: remote.id,
      name: canonical.path.split("/").filter(Boolean).at(-1) ?? "community",
      kind: remote.kind,
      canonical,
      access: "read",
      placement: "remote",
      sync: "idle",
    };
    const projection = await new WireProjection({
      tree: remote.id,
      root: remote.root,
      load: (hash) => client.object(remote.id, hash),
      rootName: canonical.path.split("/").filter(Boolean).at(-1) ?? "community",
      observedThrough,
      enclosingTree,
      includeBoundary: async (path) => {
        const currentCanonicalPath = `${canonical.path === "/" ? "" : canonical.path}${path === "/" ? "" : path}` || "/";
        return client.resolve(currentCanonicalPath).then(() => true).catch(() => false);
      },
    }).project(remotePath!, stableKey);
    if (!projection) throw new ProtocolError("not-found", "The remote path is unavailable", 404);
    return projection;
  }

  async children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    if (ref.tree !== LOCAL_TREE && ref.tree !== SYSTEM_TREE && this.remoteAuthorities.has(ref.tree) && !await this.trees.workspaceByTree(ref.tree)) {
      const remote = this.remoteAuthorities.get(ref.tree)!;
      const locator = `${remote.locator.replace(/\/$/, "")}${ref.path === "/" ? "" : ref.path}`;
      const projection = await this.fetchRemoteProjection(locator, ref.stableKey);
      const sourceRevision = projection.snapshot.capabilities.children?.revision ?? projection.snapshot.revision;
      let offset = 0;
      if (cursor) {
        try {
          const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { version?: unknown; source?: unknown; offset?: unknown };
          if (value.version !== 1 || value.source !== sourceRevision || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) throw new Error();
          offset = value.offset as number;
        } catch {
          throw new ProtocolError("invalid-cursor", "Remote child cursor is invalid or belongs to another collection-file revision", 400);
        }
      }
      const items = projection.children.slice(offset, offset + 100);
      const nextOffset = offset + items.length;
      return {
        parent: projection.snapshot.ref,
        items,
        nextCursor: nextOffset < projection.children.length
          ? Buffer.from(JSON.stringify({ version: 1, source: sourceRevision, offset: nextOffset })).toString("base64url")
          : null,
        observedThrough: projection.snapshot.observedThrough,
      };
    }
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") {
      const page = await scope.workspace.children(scope.ref, cursor);
      if (!("path" in scope.ref)) return page;
      const mounted = [
        ...this.trees.mountedChildren(scope.workspace.tree, canonicalNodePath(scope.ref.path)),
        ...this.trees.localMountedChildren(scope.workspace.tree, canonicalNodePath(scope.ref.path)),
      ];
      if (!mounted.length) return page;
      const existing = new Set(page.items.map((item) => item.ref.path));
      return {
        ...page,
        items: [
          ...page.items,
          ...mounted.filter((item) => !existing.has(item.path)).map((item) => summarizeExpandedNode({
            name: item.name,
            path: item.path,
            kind: "directory" as const,
            revision: revisionOf(`${item.tree}\0${item.path}`),
            writable: false,
            materialization: "available" as const,
            diagnostics: [],
          }, item.tree, false)),
        ].sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    if (scope.kind === "local") return this.localFs.children(scope.path, cursor);
    return this.systemTree.systemChildren(scope.path);
  }

  async backlinksPage(ref: NodeRef, cursor?: string | null): Promise<BacklinksPage> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") {
      const primary = await scope.workspace.backlinksPage(scope.ref, cursor);
      if (cursor) return primary;
      const target = primary.target;
      if (!target.tree) return primary;
      const crossTree = (await this.trees.openAll())
        .filter((workspace) => workspace.tree !== scope.workspace.tree)
        .flatMap((workspace) => workspace.backlinksTo({
          tree: target.tree!,
          path: target.path,
          ...(pageIDFromStableKey(target.stableKey) ? { pageID: pageIDFromStableKey(target.stableKey)! } : {}),
        }));
      const seen = new Set<string>();
      const entries = [...primary.entries, ...crossTree].filter((entry) => {
        const key = `${entry.ref.tree}:${entry.ref.path}:${entry.context}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 30);
      return { ...primary, entries };
    }
    throw new ProtocolError(
      "unsupported-operation",
      "Backlinks are unavailable outside a managed workspace",
      422,
    );
  }

  async recoveryPage(ref: NodeRef, recursive = false, cursor?: string | null): Promise<RecoveryPage> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") return scope.workspace.recoveryPage(scope.ref, recursive, cursor);
    throw new ProtocolError(
      "unsupported-operation",
      "Recovery is unavailable outside a managed workspace",
      422,
    );
  }

  async searchPage(tree: TreeRef, query: string, cursor?: string | null): Promise<SearchPage> {
    const workspace = await this.trees.workspaceByTree(tree);
    if (workspace) return workspace.searchPage(query, cursor);
    if (tree === LOCAL_TREE || tree === SYSTEM_TREE) {
      throw new ProtocolError(
        "unsupported-operation",
        "Search is unavailable outside a managed workspace",
        422,
      );
    }
    throw new ProtocolError("not-found", `Unknown tree scope: ${tree}`, 404);
  }

  /**
   * Execute a mutation in its single scope. Every reference is resolved
   * (canonicalizing placed refs into owning trees) and the batch must land
   * entirely in one scope.
   */
  async executeMutation(request: MutationRequest): Promise<MutationReceipt> {
    const { scopeKey, request: translated } = await this.translateMutation(request);
    if (scopeKey === LOCAL_TREE) return this.localFs.executeMutation(translated);
    if (scopeKey === SYSTEM_TREE) {
      throw new ProtocolError("unsupported-operation", "The system scope is read-only", 422);
    }
    const workspace = (scopeKey === undefined ? undefined : await this.trees.workspaceByTree(scopeKey)) ?? this.session;
    return this.inWorkspace(workspace, async () => {
      const sourcePatch = await workspace.prepareSourcePatch(translated.operations);
      const receipt = await workspace.executeMutation(translated);
      if (sourcePatch) await this.freezeImmediateUpdate(workspace, sourcePatch).catch(() => {});
      void this.syncAll();
      await workspace.protocolFault("protocol:response-delivery");
      return receipt;
    });
  }

  /** Submit a stale editor generation from its accepted Canopy base without first overwriting current disk state. */
  async admitDocumentCandidate(input: {
    ref: NodeRef;
    admissionBasis: string;
    baseContentRevision: string;
    source: string;
    sourceEdits?: SourceEdit[];
  }): Promise<NodeResponse> {
    const scope = await this.resolveScope(input.ref);
    if (scope.kind !== "root") {
      throw new ProtocolError("unsupported-operation", "Authority admission requires a Canopy-backed tree", 422);
    }
    const placement = this.trees.placementFor(scope.workspace.tree);
    if (!placement?.update || placement.access !== "write") {
      throw new ProtocolError("unsupported-operation", "Authority admission requires a writable Canopy placement", 422);
    }
    const frozen = freezeEditorAdmission(input);
    await savePendingEditorAdmission(scope.workspace.tree, frozen);
    void this.syncAll();
    const current = await this.withWorkspaceIO(scope.workspace, () => scope.workspace.snapshot(scope.ref));
    if (!current.content || !current.capabilities.content) throw new Error("Document admission target no longer has content");
    return {
      ...current,
      content: { ...current.content, source: frozen.source },
      capabilities: {
        ...current.capabilities,
        content: { ...current.capabilities.content, revision: frozen.contentRevision },
      },
      admissionBasis: frozen.admissionBasis,
    };
  }

  async assetV1(mutationID: string, directory: NodeRef, filename: string, bytes: Uint8Array) {
    const scope = await this.resolveScope(directory);
    if (scope.kind !== "root") {
      throw new ProtocolError(
        "unsupported-operation",
        "Assets are unavailable outside a managed workspace",
        422,
      );
    }
    return this.inWorkspace(scope.workspace, async () => {
      const result = await scope.workspace.assetV1(mutationID, scope.ref, filename, bytes);
      await scope.workspace.protocolFault("protocol:response-delivery");
      return result;
    });
  }

  /** Read the exact current bytes of one ordinary file in its explicit scope. */
  async file(ref: NodeRef): Promise<{ bytes: Uint8Array; revision: string; path: string }> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "system") {
      throw new ProtocolError("unsupported-operation", "Files are unavailable in the system scope", 422);
    }
    const path = scope.kind === "root"
      ? ("path" in scope.ref ? scope.ref.path : (await scope.workspace.snapshot(scope.ref)).ref.path)
      : scope.path;
    const surface = await this.scopedFileSurface(scope, path, false);
    if (!surface) {
      throw new ProtocolError("not-found", "Reference is not a readable ordinary file", 404);
    }
    return surface;
  }

  async importV1(mutationID: string, destination: NodeRef, entries: Parameters<Workspace["importV1"]>[2]) {
    const scope = await this.resolveScope(destination);
    if (scope.kind !== "root") {
      throw new ProtocolError(
        "unsupported-operation",
        "Imports are unavailable outside a managed workspace",
        422,
      );
    }
    return this.inWorkspace(scope.workspace, async () => {
      const result = await scope.workspace.importV1(mutationID, scope.ref, entries);
      await scope.workspace.protocolFault("protocol:response-delivery");
      return result;
    });
  }

  /** Enrich workspace conflicts with the owning root's current snapshot. */
  private async inWorkspace<T>(workspace: Workspace, run: () => Promise<T>): Promise<T> {
    return this.withWorkspaceIO(workspace, async () => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          const current = await workspace.snapshot({ tree: workspace.tree, path: error.current.path, stableKey: null }).catch(() => undefined);
          throw new ProtocolError("stale-content-revision", error.message, 409, {
            path: error.current.path,
            current,
          });
        }
        if (error instanceof FsConflictError) {
          const mapped = fsErrorCode(error);
          const current = error.details.current
            ? await workspace.snapshot({ tree: workspace.tree, path: error.details.current.node.path, stableKey: null }).catch(() => undefined)
            : undefined;
          throw new ProtocolError(mapped.code, error.message, mapped.status, {
            path: error.details.path,
            retryable: mapped.retryable ?? false,
            current,
          });
        }
        throw error;
      }
    });
  }

  /** One tree's local write/snapshot/materialization boundary; Wire requests must remain outside. */
  private async withWorkspaceIO<T>(workspace: Workspace, run: () => Promise<T>): Promise<T> {
    const key = workspace.tree;
    const previous = this.workspaceIOTails.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(() => undefined, () => undefined);
    this.workspaceIOTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.workspaceIOTails.get(key) === tail) this.workspaceIOTails.delete(key);
    }
  }

  /**
   * The byte surface for a URL path: OS-shaped paths dispatch into the
   * owning root or the local filesystem service.
   */
  /**
   * Resolve a tree-rooted byte path in the scope of the referring
   * document. The DOM resolves authored tree-rooted spellings (assets)
   * against the origin; the referrer's enclosing root supplies the tree.
   */
  async fileSurfaceInScopeOf(
    referrerUrlPath: string,
    treeRootedPath: string,
    raw: boolean,
  ): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    try {
      const scope = await this.resolveScope({ tree: LOCAL_TREE, path: referrerUrlPath, stableKey: null });
      if (scope.kind !== "root") return null;
      return await this.scopedFileSurface(scope, treeRootedPath, raw);
    } catch {
      return null;
    }
  }

  async fileSurface(urlPath: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    let scope: ResolvedScope;
    try {
      scope = await this.resolveScope({ tree: LOCAL_TREE, path: urlPath, stableKey: null });
    } catch {
      return null;
    }
    const path = scope.kind === "root" && "path" in scope.ref ? scope.ref.path
      : scope.kind === "local" ? scope.path
      : "/";
    return this.scopedFileSurface(scope, path, raw);
  }

  /** The only ordinary-file/document byte dispatcher; URL surfaces are adapters. */
  private async scopedFileSurface(
    scope: ResolvedScope,
    path: string,
    raw: boolean,
  ): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    if (scope.kind === "root") return scope.workspace.fileSurface(path, raw).catch(() => null);
    if (scope.kind === "local") return this.localFs.fileSurface(path, raw).catch(() => null);
    return null;
  }

  async claimProfileBootstrap(
    originInput: string,
    handle: string,
    inputPath: string,
    displayName?: string,
    layout: "legacy" | "accounts" = "legacy",
  ): Promise<MutationReceipt["effects"]> {
    return claimProfileBootstrap(this, originInput, handle, inputPath, displayName, layout);
  }

  async claimCanopyAccount(account: string, inputPath: string, displayName?: string): Promise<MutationReceipt["effects"]> {
    return claimCanopyAccountBootstrap(this, account, inputPath, displayName);
  }

  async forgetLocalAccount(): Promise<void> {
    return forgetLocalAccount(this);
  }

  /** Flush a valid file-edited configuration and its resulting tree work before a CLI process exits. */
  async synchronizeNow(): Promise<void> {
    if (this.placementMoving) await new Promise<void>((resolve) => this.placementMoveWaiters.push(resolve));
    await this.trees.refreshConfiguration();
    await this.syncAll(true);
  }

  async moveLocalPlacement(input: { source: string; destination: string; check?: boolean }): Promise<{
    tree: string;
    configurationTree: string;
    source: string;
    destination: string;
    check: boolean;
  }> {
    if (!isAbsolute(input.source) || normalize(input.source) !== input.source) {
      throw new ProtocolError("invalid-request", "Placement move source must be canonical and absolute", 400);
    }
    if (!isAbsolute(input.destination) || normalize(input.destination) !== input.destination) {
      throw new ProtocolError("invalid-request", "Placement move destination must be normalized and absolute", 400);
    }
    await this.synchronizeNow();
    if (this.placementMoving) throw new ProtocolError("conflict", "Another placement move is already running", 409);
    this.placementMoving = true;
    let result: {
      tree: string;
      configurationTree: string;
      source: string;
      destination: string;
      check: boolean;
    } | undefined;
    try {
      const source = await realpath(input.source);
      if (source !== input.source) {
        throw new ProtocolError("invalid-request", `Placement move source resolves to ${source}`, 400);
      }
      const parent = await realpath(dirname(input.destination));
      const destination = join(parent, basename(input.destination));
      if (destination !== input.destination) {
        throw new ProtocolError("invalid-request", `Placement move destination resolves beneath ${parent}`, 400);
      }
      if (source === destination) throw new ProtocolError("invalid-request", "Placement move source and destination are the same", 400);
      if (destination.startsWith(`${source}/`)) {
        throw new ProtocolError("invalid-request", "A placed root cannot be moved inside itself", 400);
      }
      const destinationExists = await lstat(destination).then(() => true).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
      if (destinationExists) throw new ProtocolError("conflict", `Move destination already exists: ${destination}`, 409);

      const [sourceInfo, parentInfo, local] = await Promise.all([
        stat(source),
        stat(parent),
        loadLocalPlacements(),
      ]);
      if (!sourceInfo.isDirectory()) throw new ProtocolError("invalid-request", "A placement root must be a directory", 400);
      if (!parentInfo.isDirectory()) throw new ProtocolError("invalid-request", "Move destination parent must be a directory", 400);
      if (sourceInfo.dev !== parentInfo.dev) {
        throw new ProtocolError("unsupported-operation", "Cross-filesystem placement moves are not supported", 422);
      }
      if (local.diagnostics.length) {
        throw new ProtocolError("conflict", `placements.yaml is invalid: ${local.diagnostics[0]!.message}`, 409);
      }
      const placement = local.placements.find((candidate) => candidate.path === source);
      if (!placement) throw new ProtocolError("not-found", `No exact tree placement exists at ${source}`, 404);
      const overlaps = local.placements.find((candidate) =>
        candidate !== placement && (
          candidate.path.startsWith(`${source}/`)
          || source.startsWith(`${candidate.path}/`)
          || candidate.path.startsWith(`${destination}/`)
          || destination.startsWith(`${candidate.path}/`)
        )
      );
      if (overlaps) {
        throw new ProtocolError("unsupported-operation", `Placement move overlaps another placed root: ${overlaps.path}`, 422);
      }
      const descriptor = (await this.trees.descriptors()).find((candidate) =>
        candidate.id === placement.tree && candidate.configurationTree === placement.configurationTree
      );
      if (!descriptor || descriptor.missing || descriptor.access !== "write" || descriptor.sync !== "idle") {
        throw new ProtocolError(
          "conflict",
          `Placed root must be present, writable, and idle before moving; current state is ${descriptor?.sync ?? "unavailable"}`,
          409,
        );
      }
      result = {
        tree: placement.tree,
        configurationTree: placement.configurationTree,
        source,
        destination,
        check: input.check === true,
      };
      if (!input.check) {
        await this.trees.relocatePlacedRoot(result, async (direction) => {
          const from: LocalPlacement = direction === "forward"
            ? placement
            : { ...placement, path: destination };
          const to = direction === "forward"
            ? { configurationTree: placement.configurationTree, path: destination }
            : { configurationTree: placement.configurationTree, path: source };
          await replaceLocalPlacement(from, to);
        });
      }
    } finally {
      this.placementMoving = false;
      for (const resolve of this.placementMoveWaiters.splice(0)) resolve();
    }
    if (!result) throw new Error("Placement move did not produce a result");
    if (!result.check) {
      await this.synchronizeNow();
      const descriptor = (await this.trees.descriptors()).find((candidate) =>
        candidate.id === result!.tree && candidate.configurationTree === result!.configurationTree
      );
      if (!descriptor || descriptor.missing || descriptor.osPath !== result.destination || descriptor.sync !== "idle") {
        throw new Error(`Moved placement did not become idle at ${result.destination}`);
      }
    }
    return result;
  }

  async accountList() {
    const configurations = await loadCanopyAccountConfigurations();
    if (configurations.length) {
      return Promise.all(configurations.map(async (configuration) => {
        const stored = await new CanopyAccountStore(configuration.configurationTree).safe();
        return {
          configurationTree: configuration.configurationTree,
          canopy: configuration.account?.canopy ?? stored?.origin ?? null,
          handle: stored?.handle ?? null,
          profileTree: configuration.account?.profile ?? stored?.profileTree ?? null,
          deviceID: configuration.currentDevice?.id ?? stored?.deviceID ?? null,
          credentialAvailable: Boolean(await new CanopyAccountStore(configuration.configurationTree).get()),
          diagnostics: configuration.diagnostics,
        };
      }));
    }
    const legacy = await this.communityConfig.status();
    return legacy ? [{
      configurationTree: legacy.record.configurationTree,
      canopy: legacy.record.origin,
      handle: legacy.record.handle,
      profileTree: legacy.record.profileTree,
      deviceID: null,
      credentialAvailable: legacy.credentialAvailable,
      diagnostics: [],
    }] : [];
  }

  async createPairingBootstrap(configurationTree?: string) {
    return createPairingBootstrap(this, configurationTree);
  }

  async resolveTreeConflict(
    tree: string,
    choice: "local" | "draft" | "remote",
  ): Promise<MutationReceipt["effects"]> {
    const conflict = await treeConflict(tree);
    if (!conflict) throw new ProtocolError("not-found", `Tree has no stored synchronization conflict: ${tree}`, 404);
    const placement = this.trees.placementFor(tree);
    const workspace = await this.trees.workspaceByTree(tree);
    if (!placement || !workspace) {
      throw new ProtocolError("not-found", `Shared tree placement is unavailable: ${tree}`, 404);
    }
    const client = await this.accountClient(placement);
    if (choice === "remote") {
      const remote = (await client.descriptor(tree)).tree;
      if (!remote.update) throw new Error("Server does not advertise accepted updates for this tree");
      await materializeTree(
        workspace.root,
        remote.root,
        (hash) => client.object(tree, hash),
        undefined,
        this.trees.excludedMountsWithin(workspace.root),
      );
      await this.trees.updateSyncMetadata({
        ...placement,
        ref: remote.root,
        update: remote.update,
        access: remote.access === "none" ? "read" : remote.access,
      });
      const acceptedLocal = await this.snapshotWorkspace(workspace, client);
      if (acceptedLocal.root !== remote.root) throw new Error("Materialized remote tree does not match its server root");
      await saveAcceptedTreeObjects(tree, acceptedLocal);
      await clearPendingEditorAdmissions(tree);
      await clearPendingTreeUpdate(tree);
      await clearTreeConflict(tree);
      this.trees.setSyncState(tree, "idle");
      this.treeSync.conflicts.delete(tree);
      return [{ kind: "updated", ref: { tree: SYSTEM_TREE, path: `/conflicts/${tree}`, stableKey: null } }];
    }

    let candidate: import("@arbor/wire").TreeSnapshot;
    if (choice === "draft") {
      const local = await this.snapshotWorkspace(workspace, client);
      if (local.root !== conflict.details.candidate) {
        throw new ProtocolError(
          "stale-content-revision",
          "Local files changed after the conflict; keep the current local version or review those edits before choosing the older draft",
          409,
          { path: `/trees/${tree}` },
        );
      }
      candidate = snapshotFromConflictDraft(conflict, local);
      await materializeTree(
        workspace.root,
        candidate.root,
        (hash) => {
          const bytes = candidate.objects.get(hash);
          if (!bytes) throw new Error(`Conflict draft is missing object: ${hash}`);
          return Promise.resolve(bytes);
        },
        undefined,
        this.trees.excludedMountsWithin(workspace.root),
      );
    } else {
      candidate = await this.snapshotWorkspace(workspace, client);
    }
    await clearPendingEditorAdmissions(tree);
    await savePendingTreeUpdate(
      tree,
      pendingFromSnapshot(
        conflict.details.current.id,
        candidate,
      ),
    );
    await clearTreeConflict(tree);
    this.treeSync.conflicts.delete(tree);
    await this.treeSync.updateWorkspace(workspace, placement, client, (await client.list()).snapshot);
    return [{ kind: "updated", ref: { tree: SYSTEM_TREE, path: `/trees/${tree}`, stableKey: null } }];
  }

  private canonicalBoundariesFor(
    workspace: Workspace,
    remoteTrees: readonly RemoteTreeDescriptor[],
  ): Map<string, string> {
    const boundaries = this.trees.sharedBoundariesWithin(workspace.root);
    const parent = remoteTrees.find((tree) => tree.id === workspace.tree);
    if (!parent) return boundaries;
    const parentPath = parent.canonical?.path.replace(/\/$/, "") || "/";
    for (const child of remoteTrees) {
      if (child.canonical?.parentTree !== workspace.tree) continue;
      const relativeCanonical = parentPath === "/"
        ? child.canonical!.path.slice(1)
        : child.canonical!.path.slice(parentPath.length + 1);
      if (!relativeCanonical || relativeCanonical.startsWith("../")) continue;
      boundaries.set(join(workspace.root, ...relativeCanonical.split("/").map(decodeURIComponent)), child.id);
    }
    return boundaries;
  }

  private async snapshotWorkspace(
    workspace: Workspace,
    client: WireClient,
    remoteTrees?: readonly RemoteTreeDescriptor[],
  ) {
    const listed = remoteTrees ?? (await client.list()).snapshot;
    return snapshotDirectory(
      workspace.root,
      this.canonicalBoundariesFor(workspace, listed),
      this.trees.excludedMountsWithin(workspace.root),
      (directory, sourceName) => workspace.describeWireCollectionFile(directory, sourceName),
    );
  }

  /** Freeze the just-admitted candidate locally; server I/O remains background work. */
  private async freezeImmediateUpdate(workspace: Workspace, admission: ConfirmedSourcePatch): Promise<void> {
    const placement = this.trees.placementFor(workspace.tree);
    if (!placement || placement.access !== "write" || !placement.update) return;
    if (await pendingTreeUpdate(workspace.tree) || await treeConflict(workspace.tree)) return;
    const retained = await acceptedTreeObjects(workspace.tree);
    if (!retained || retained.root !== placement.ref) return;

    const snapshot = await snapshotDirectory(
      workspace.root,
      this.trees.sharedBoundariesWithin(workspace.root),
      this.trees.excludedMountsWithin(workspace.root),
      (directory, sourceName) => workspace.describeWireCollectionFile(directory, sourceName),
    );
    if (snapshot.root === placement.ref) return;
    const retainedHashes = new Set(retained.hashes);
    let pending = pendingFromSnapshot(placement.update, snapshot, retainedHashes);

    const baseBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(admission.baseSource) });
    const resultBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(admission.resultSource) });
    const base = hashObject(baseBytes);
    const result = hashObject(resultBytes);
    if (base !== result && retainedHashes.has(base) && snapshot.objects.has(result)) {
      const delta: ObjectDelta = { base, result, instructions: objectDelta(baseBytes, resultBytes) };
      const deltaSize = Buffer.byteLength(JSON.stringify(encodeObjectDeltaJSON(delta)));
      const completeSize = Buffer.byteLength(JSON.stringify({ hash: result, bytes: Buffer.from(resultBytes).toString("base64") }));
      if (deltaSize < completeSize) pending = withDelta(pending, delta);
    }
    await savePendingTreeUpdate(workspace.tree, pending);
  }

  private async syncAll(throwErrors = false): Promise<void> {
    if (this.placementMoving) {
      this.syncRequested = true;
      if (throwErrors) {
        await new Promise<void>((resolve) => this.placementMoveWaiters.push(resolve));
        await this.syncAll(true);
      }
      return;
    }
    if (this.syncing) {
      this.syncRequested = true;
      await new Promise<void>((resolve) => this.syncWaiters.push(resolve));
      if (throwErrors) await this.syncAll(true);
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncRequested = false;
        const remoteTreesByAccount = new Map<string, Promise<RemoteTreeDescriptor[]>>();
        const placements = this.trees.sharedPlacements().sort((left, right) =>
          Number(right.kind === "account-configuration") - Number(left.kind === "account-configuration")
        );
        for (const placement of placements) {
          try {
            const client = await this.accountClient(placement);
            const workspace = await this.trees.workspaceByTree(placement.tree);
            if (!workspace) continue;
            const accountKey = placement.configurationTree ?? `legacy:${placement.endpoint}`;
            let listed = remoteTreesByAccount.get(accountKey);
            if (!listed) {
              listed = client.list().then((value) => value.snapshot);
              remoteTreesByAccount.set(accountKey, listed);
            }
            const remoteTrees = await listed;
            if (!remoteTrees.some((tree) => tree.id === placement.tree)) {
              const initial = await this.withWorkspaceIO(
                workspace,
                () => this.snapshotWorkspace(workspace, client, remoteTrees),
              );
              const activated = await client.submitUpdate(placement.tree, null, initial);
              await this.trees.updateSyncMetadata({
                ...placement,
                ref: activated.update.root,
                update: activated.update.id,
                access: "write",
              });
              await saveAcceptedTreeObjects(placement.tree, initial);
              this.trees.setSyncState(placement.tree, "idle");
              continue;
            }
            this.treeSync.ensureWatch(placement);
            await this.treeSync.updateWorkspace(workspace, placement, client, remoteTrees);
          } catch (error) {
            this.trees.setSyncState(placement.tree, error instanceof TypeError ? "offline" : "error");
            if (throwErrors) throw error;
          }
        }
      } while (this.syncRequested);
    } finally {
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
    }
  }

  private async translateMutation(
    request: MutationRequest,
  ): Promise<{ scopeKey: TreeRef | undefined; request: MutationRequest }> {
    let scopeKey: TreeRef | undefined;
    let sawScoped = false;
    const claim = (tree: TreeRef | undefined) => {
      if (!sawScoped) {
        scopeKey = tree;
        sawScoped = true;
        return;
      }
      if (scopeKey !== tree) {
        throw new ProtocolError(
          "unsupported-operation",
          "A mutation resolves in exactly one scope; cross-scope batches are not supported",
          422,
        );
      }
    };
    const translateRef = async (ref: NodeRef): Promise<NodeRef> => {
      const scope = await this.resolveScope(ref);
      if (scope.kind === "root") {
        claim(scope.workspace.tree);
        return scope.ref;
      }
      if (scope.kind === "local") {
        claim(LOCAL_TREE);
        return scope.ref;
      }
      claim(SYSTEM_TREE);
      return ref;
    };
    const rejectReservedMount = async (ref: NodeRef): Promise<void> => {
      if (ref.tree && ref.tree !== LOCAL_TREE && ref.tree !== SYSTEM_TREE) {
        const mounted = this.trees.reservedBoundary(ref.tree, canonicalNodePath(ref.path));
        if (mounted?.exact) {
          throw new ProtocolError("reserved-boundary", `Canonical mount is reserved: ${mounted.path}`, 409, {
            path: ref.path,
          });
        }
        const localMount = this.trees.localMountBoundary(ref.tree, canonicalNodePath(ref.path));
        if (localMount?.exact) {
          throw new ProtocolError("reserved-boundary", "Reader-local tree mounts are managed from Home", 409, {
            path: ref.path,
          });
        }
        return;
      }
      if (ref.tree === LOCAL_TREE) {
        const real = await realOsPath(canonicalNodePath(ref.path));
        const owner = await this.trees.ownerOf(real);
        if (!owner) return;
        const mounted = this.trees.reservedBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath));
        if (mounted?.exact) {
          throw new ProtocolError("reserved-boundary", `Canonical mount is reserved: ${mounted.path}`, 409, {
            path: ref.path,
          });
        }
        const localMount = this.trees.localMountBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath));
        if (localMount?.exact) {
          throw new ProtocolError("reserved-boundary", "Reader-local tree mounts are managed from Home", 409, {
            path: ref.path,
          });
        }
      }
    };
    const operations = await Promise.all(request.operations.map(async (operation) => {
      const translated: WorkspaceOperation = { ...operation };
      if (["rename", "move", "copy", "trash", "restore"].includes(translated.op)) {
        if ("ref" in translated && translated.ref) await rejectReservedMount(translated.ref);
        if ("refs" in translated && Array.isArray(translated.refs)) {
          await Promise.all(translated.refs.map(rejectReservedMount));
        }
      }
      if ("ref" in translated && translated.ref) translated.ref = await translateRef(translated.ref);
      if ("refs" in translated && Array.isArray(translated.refs)) {
        translated.refs = await Promise.all(translated.refs.map(translateRef));
      }
      if ("destination" in translated && translated.destination) {
        translated.destination = await translateRef(translated.destination);
      }
      if (translated.op === "createMarkdown" || translated.op === "createDirectory") {
        await rejectReservedMount({ tree: translated.tree, path: translated.path, stableKey: null });
        const scope = await this.resolveScope({ tree: translated.tree, path: translated.path, stableKey: null });
        if (scope.kind === "root") {
          claim(scope.workspace.tree);
          if ("path" in scope.ref) translated.path = scope.ref.path;
        } else if (scope.kind === "local") {
          claim(LOCAL_TREE);
          translated.path = scope.path;
        } else {
          claim(SYSTEM_TREE);
        }
      }
      return translated;
    }));
    return { scopeKey, request: { ...request, operations } as MutationRequest };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.syncStartupTimer) clearTimeout(this.syncStartupTimer);
    if (this.syncing) await new Promise<void>((resolve) => this.syncWaiters.push(resolve));
    await this.treeSync.close();
    await this.localFs[Symbol.asyncDispose]();
    await this.trees[Symbol.asyncDispose]();
  }
}
