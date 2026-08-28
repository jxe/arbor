import { homedir, hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  TreeDescriptor,
  TreeRef,
  WorkspaceOperation,
} from "@arbor/core";
import type { TreeNode } from "@arbor/core/internal";
import { LOCAL_TREE, SYSTEM_TREE, canonicalNodePath, generateArborID, pageIDFromStableKey, revisionOf, sha256, siblingMarkdownTreePath } from "@arbor/core";
import { directoryPlacementDiagnostics, parseMarkdown } from "@arbor/editor";
import { FsConflictError } from "@arbor/fs";
import { CommunityConfigStore, VisitedTreeStore, arborDataRoot, arborPrivateRoot, saveCurrentDeviceID } from "@arbor/stores";
import { WireClient, WireUpdateConflict, decodeWireObject, encodeWireObject, hashObject, materializeTree, resolveWireLogicalNode, snapshotDirectory, type FilePatch, type ObjectHash, type RemoteTreeDescriptor } from "@arbor/wire";
import { EventBus } from "./events.ts";
import { fsErrorCode } from "./fs-errors.ts";
import { FilesystemService, realOsPath } from "./fs-service.ts";
import { TreeManager } from "./tree-manager.ts";

interface PendingClaimBootstrap {
  version: 1;
  origin: string;
  handle: string;
  path: string;
  label: string;
  profileTree: string;
  configurationTree: string;
  deviceID: string;
  credentialDigest: `sha256:${string}`;
  files: { account: string; trees: string; device: string };
  profile: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
  configuration: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: string }> };
}

function bootstrapSnapshot(value: PendingClaimBootstrap["profile"]): import("@arbor/wire").TreeSnapshot {
  return {
    root: value.root,
    objects: new Map(value.objects.map(({ hash, bytes }) => [hash, new Uint8Array(Buffer.from(bytes, "base64"))])),
  };
}

function persistableBootstrapSnapshot(value: import("@arbor/wire").TreeSnapshot): PendingClaimBootstrap["profile"] {
  return {
    root: value.root,
    objects: [...value.objects].map(([hash, bytes]) => ({ hash, bytes: Buffer.from(bytes).toString("base64") })),
  };
}
import { ProtocolError, RevisionConflictError, Workspace, type WorkspaceOptions } from "./workspace.ts";
import {
  acceptedTreeObjects,
  clearPendingTreeUpdate,
  clearTreeConflict,
  filePatchesFromPending,
  pendingFromSnapshot,
  pendingTreeUpdate,
  savePendingTreeUpdate,
  saveAcceptedTreeObjectHashes,
  saveAcceptedTreeObjects,
  saveTreeConflict,
  snapshotFromPending,
  snapshotFromConflictDraft,
  treeConflict,
  withFilePatch,
} from "./sync-state.ts";
import type { ConfirmedSourcePatch } from "./workspace.ts";
import { sampleTreeNode, summarizeSample, summarizeTreeNode } from "./node-sampling.ts";


const SYSTEM_REMOTE_TIMEOUT_MS = 1_000;

type ResolvedScope =
  | { kind: "root"; workspace: Workspace; ref: NodeRef }
  | { kind: "local"; path: string; ref: NodeRef }
  | { kind: "system"; path: string };

interface SystemTreeSegment {
  readonly segment: string;
  readonly tree: LocalTreeDescriptor;
  readonly source: string;
}

interface SystemTreeProjection {
  readonly revision: number;
  readonly expiresAt: number;
  readonly segments: readonly SystemTreeSegment[];
}

interface SystemTreeProjectionBuild {
  readonly revision: number;
  readonly segments: readonly SystemTreeSegment[];
}

interface ArborSyncDaemonOptions {
  autoSync?: boolean;
  monotonicNow?: () => number;
}

export function resolveUserPath(input: string, home = homedir()): string {
  const value = input.trim();
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return resolve(value);
}

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
  private remoteChildren = new Map<string, NodeSummary[]>();
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncing = false;
  private syncRequested = false;
  private syncWaiters: Array<() => void> = [];
  private syncConflicts = new Set<string>();
  private remoteAuthorities = new Map<string, { locator: string; endpoint: string }>();
  private systemTreeProjection?: SystemTreeProjection;
  private systemTreeProjectionInFlight?: { revision: number; promise: Promise<readonly SystemTreeSegment[]> };
  private readonly monotonicNow: () => number;

  private constructor(events: EventBus, trees: TreeManager, options: ArborSyncDaemonOptions = {}) {
    this.events = events;
    this.trees = trees;
    this.localFs = new FilesystemService(events);
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (options.autoSync !== false) {
      this.syncTimer = setInterval(() => { void this.syncAll(); }, 2_000);
      this.syncTimer.unref?.();
      setTimeout(() => { void this.syncAll(); }, 0);
    }
  }

  static async open(
    sessionPath: string,
    options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {},
  ): Promise<ArborSyncDaemon> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    await trees.openSession(sessionPath, options);
    const service = new ArborSyncDaemon(events, trees);
    await service.migrateLegacyCommunityConfig();
    await trees.refreshConfiguration();
    return service;
  }

  /** Open system/account services without attaching Arbor to a filesystem session. */
  static async openControl(options: ArborSyncDaemonOptions = {}): Promise<ArborSyncDaemon> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    const service = new ArborSyncDaemon(events, trees, { ...options, autoSync: options.autoSync ?? false });
    await service.migrateLegacyCommunityConfig();
    await trees.refreshConfiguration();
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
      return this.remoteSnapshot(locator);
    }
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") return scope.workspace.snapshot(scope.ref);
    if (scope.kind === "local") return this.localFs.snapshot(scope.ref);
    return this.systemSnapshot(scope.path);
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
        return { ref: scope.ref as import("@arbor/core").ResolvedNodeRef, ...(enclosingTree ? { enclosingTree } : {}), historical: false, observedThrough: this.events.currentCursor() };
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
      this.remoteAuthorities.set(resolution.enclosingTree.id, { locator: resolution.enclosingTree.canonical.locator, endpoint: origin });
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
      const snapshot = await this.fetchRemoteSnapshot(locatorInput);
      await this.visitedTrees.remember(locator, snapshot);
      this.events.emit({ tree: SYSTEM_TREE, kind: "updated", path: "/visited", origin: "external" });
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
  private async fetchRemoteSnapshot(locatorInput: string): Promise<NodeResponse> {
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
      if (!resolution.enclosingTree || !("ref" in resolution.enclosingTree) || !("update" in resolution.enclosingTree)) {
        throw new Error("Server resolution omitted its enclosing tree");
      }
      remote = resolution.enclosingTree as RemoteTreeDescriptor;
      remotePath = resolution.ref.path;
    }
    catch (error) {
      if (error instanceof TypeError) throw error;
      throw new ProtocolError("not-found", `The Arbor page is unavailable: ${origin}${canonicalPath}`, 404);
    }

    const logical = await resolveWireLogicalNode(remote.ref, remotePath!, (hash) => client.object(remote.id, hash));
    if (!logical) throw new ProtocolError("not-found", "The remote path is unavailable", 404);
    const object = logical.object;
    const canonical = remote.canonical!;
    const objectName = logical.objectName || canonical.path.split("/").filter(Boolean).at(-1) || "community";
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
    const diagnostics = logical.duplicateBody ? [{
        code: "duplicate-body-representation",
        message: `${canonicalNodePath(remotePath!)} has both a sibling Markdown body and _index.md; keep only one.`,
        path: canonicalNodePath(remotePath!),
        severity: "error" as const,
      }] : [];
    const context = { tree: remote.id, enclosingTree, observedThrough, writable: false };
    if (object.type === "file") {
      const markdown = objectName.endsWith(".md");
      const source = new TextDecoder().decode(object.bytes);
      const document = markdown ? parseMarkdown(source) : undefined;
      const authoredTitle = document?.blocks.find((block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1)?.content;
      return sampleTreeNode({
        path: canonicalNodePath(remotePath!),
        name: authoredTitle || (markdown ? objectName.slice(0, -3) : objectName),
        kind: markdown ? "markdown" : "file",
        revision: revisionOf(object.bytes),
        writable: false,
        materialization: "available",
        ...(document ? { document, bodyOrigin: "sibling" as const } : {}),
        diagnostics,
      }, context);
    }

    const source = logical.body ? new TextDecoder().decode(logical.body.bytes) : "";
    const currentCanonicalPath = `${canonical.path === "/" ? "" : canonical.path}${remotePath! === "/" ? "" : remotePath!}` || "/";
    const children = (await Promise.all(object.entries
      .filter((entry) => entry.name !== "_index.md")
      .map(async (entry) => {
        const childObject = entry.hash ? decodeWireObject(await client.object(remote.id, entry.hash)) : null;
        const markdown = childObject?.type === "file" && entry.name.endsWith(".md");
        const name = markdown ? entry.name.slice(0, -3) : entry.name;
        if (entry.tree) {
          const accessible = await client.resolve(`${currentCanonicalPath.replace(/\/$/, "")}/${name}`).then(() => true).catch(() => false);
          if (!accessible) return null;
        }
        const path = canonicalNodePath(`${remotePath! === "/" ? "" : remotePath!}/${name}`);
        const childDocument = markdown && childObject?.type === "file"
          ? parseMarkdown(new TextDecoder().decode(childObject.bytes))
          : null;
        const pageID = childDocument && typeof childDocument.frontmatter.id === "string" ? childDocument.frontmatter.id : undefined;
        const node: TreeNode = {
          name,
          path,
          kind: entry.tree || childObject?.type === "directory" ? "directory" as const : markdown ? "markdown" as const : "file" as const,
          revision: entry.hash ?? entry.tree ?? revisionOf(path),
          writable: false,
          materialization: "available" as const,
          ...(childDocument ? { document: childDocument, bodyOrigin: "sibling" as const } : {}),
          diagnostics: [],
        };
        const summary = summarizeTreeNode(node, remote.id, false);
        if (pageID) summary.ref.stableKey = `[["id",${JSON.stringify(pageID)}]]`;
        return { summary, treeChild: {
          tree: remote.id,
          name,
          path,
          kind: node.kind,
          materialization: "available" as const,
          ...(pageID ? { pageID } : {}),
        } };
      }))).filter((child): child is NonNullable<typeof child> => child !== null);
    const document = parseMarkdown(source);
    const authoredTitle = document.blocks.find((block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1)?.content;
    const descriptors = children
      .map(({ treeChild: child }) => ({ path: canonicalNodePath(child.path), kind: child.kind, pageID: child.pageID ?? null }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
    const path = canonicalNodePath(remotePath!);
    this.remoteChildren.set(`${remote.id}\0${path}`, children.map((child) => child.summary));
    return sampleTreeNode({
      path,
      name: authoredTitle || objectName,
      kind: "directory",
      revision: revisionOf(`${source}\0${JSON.stringify(descriptors)}`),
      writable: false,
      materialization: "available",
      ...(logical.bodyOrigin ? { bodyOrigin: logical.bodyOrigin } : {}),
      document,
      children: children.map((child) => child.treeChild),
      diagnostics: [...diagnostics, ...directoryPlacementDiagnostics(path, document)],
    }, context);
  }

  async children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    if (ref.tree !== LOCAL_TREE && ref.tree !== SYSTEM_TREE && this.remoteAuthorities.has(ref.tree) && !await this.trees.workspaceByTree(ref.tree)) {
      const snapshot = await this.snapshot(ref);
      return {
        parent: snapshot.ref,
        items: this.remoteChildren.get(`${snapshot.ref.tree}\0${snapshot.ref.path}`) ?? [],
        nextCursor: null,
        observedThrough: snapshot.observedThrough,
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
          ...mounted.filter((item) => !existing.has(item.path)).map((item) => summarizeTreeNode({
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
    return this.systemChildren(scope.path);
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

  /** Safe diagnostic projections. Account configuration is ordinary tree content. */
  private async systemSnapshot(path: string): Promise<NodeResponse> {
    await this.trees.descriptors();
    const observedThrough = this.events.currentCursor();
    if (path === "/") {
      return sampleTreeNode({
        path: "/",
        name: "system",
        kind: "directory",
        revision: revisionOf(""),
        writable: false,
        materialization: "available",
        document: parseMarkdown(""),
        diagnostics: [],
      }, { tree: SYSTEM_TREE, observedThrough, writable: false });
    }
    if (path === "/visited") {
      const listing = (await this.visitedTrees.list()).map((visit) => visit.id);
      const revision = revisionOf(listing.join("\n"));
      return sampleTreeNode({
        path,
        name: path.slice(1),
        kind: "directory",
        revision,
        writable: false,
        materialization: "available",
        document: parseMarkdown(""),
        diagnostics: this.trees.diagnostics(),
      }, { tree: SYSTEM_TREE, observedThrough, writable: false });
    }
    const record = await this.systemRecordAt(path);
    if (!record) {
      throw new ProtocolError("not-found", `Node not found: system:${path.slice(1)}`, 404, { path });
    }
    return sampleTreeNode({
      path,
      name: record.segment,
      kind: "markdown",
      revision: revisionOf(record.record.source),
      writable: false,
      materialization: "available",
      bodyOrigin: "sibling",
      document: parseMarkdown(record.record.source),
      diagnostics: [],
    }, { tree: SYSTEM_TREE, observedThrough, writable: false });
  }

  private async systemChildren(path: string): Promise<ChildrenPage> {
    await this.trees.descriptors();
    const observedThrough = this.events.currentCursor();
    if (path === "/") {
      const items = await Promise.all(["/credentials", "/visited", "/diagnostics"].map(async (childPath) =>
        summarizeSample(await this.systemSnapshot(childPath))
      ));
      return {
        parent: { tree: SYSTEM_TREE, path: "/", stableKey: null },
        items,
        nextCursor: null,
        observedThrough,
      };
    }
    if (path === "/visited") {
      const visits = await this.visitedTrees.list();
      return {
        parent: { tree: SYSTEM_TREE, path: "/visited", stableKey: null },
        items: await Promise.all(visits.map(async (visit) => summarizeSample(await this.systemSnapshot(`/visited/${visit.id}`)))),
        nextCursor: null,
        observedThrough,
      };
    }
    throw new ProtocolError("invalid-reference", `system:${path.slice(1)} does not have children`, 400, { path });
  }

  private async buildSystemTreeSegments(): Promise<SystemTreeProjectionBuild> {
    const configured = await this.communityConfig.get();
    let remote: RemoteTreeDescriptor[] = [];
    let writable = new Set<string>();
    const remoteAccess = new Map<string, import("@arbor/wire").RemoteAccessEntry[]>();
    if (configured) {
      const client = new WireClient(configured.record.origin, configured.accountToken, {
        timeoutMs: SYSTEM_REMOTE_TIMEOUT_MS,
      });
      const [listed, account] = await Promise.allSettled([client.list(), client.account()]);
      if (listed.status === "fulfilled") remote = listed.value.snapshot;
      if (account.status === "fulfilled") {
        writable = new Set(account.value.account.writableProfiles.map((tree) => tree.id));
      }
      if (
        (listed.status === "rejected" && listed.reason instanceof TypeError)
        || (account.status === "rejected" && account.reason instanceof TypeError)
      ) {
        for (const placement of this.trees.sharedPlacements()) {
          if (placement.endpoint === configured.record.origin) this.trees.setSyncState(placement.tree, "offline");
        }
      }
      await Promise.all(remote.map(async (tree) => {
        const entries = await client.access(tree.id).then((value) => value.snapshot).catch(() => []);
        remoteAccess.set(tree.id, entries);
      }));
    }
    // Read local descriptors after the bounded remote refresh so any transport
    // failure above is visible immediately as `sync: offline`.
    const local = await this.trees.descriptors();
    const byID = new Map<string, LocalTreeDescriptor>(local.map((tree) => [tree.id, tree]));
    for (const tree of remote) {
      const current = byID.get(tree.id);
      byID.set(tree.id, {
        id: tree.id,
        name: current?.name ?? tree.canonical?.path.split("/").filter(Boolean).at(-1) ?? "community",
        osPath: current?.osPath,
        kind: tree.kind,
        canonical: tree.canonical,
        access: current?.access ?? tree.access ?? (writable.has(tree.id) ? "write" : "read"),
        placement: current?.placement ?? "remote",
        sync: current?.sync,
      });
    }
    const segments = await Promise.all([...byID.values()].map(async (tree) => ({
      segment: tree.id,
      tree,
      source: this.treeRecordSource(
        tree,
        tree.placement !== "remote" ? await treeConflict(tree.id) : undefined,
      ),
    })));
    return { revision: this.trees.descriptorRevision, segments };
  }

  private async systemTreeSegments(): Promise<readonly SystemTreeSegment[]> {
    const revision = this.trees.descriptorRevision;
    const now = this.monotonicNow();
    const cached = this.systemTreeProjection;
    if (cached && cached.revision === revision && cached.expiresAt > now) return cached.segments;
    const inFlight = this.systemTreeProjectionInFlight;
    if (inFlight) return inFlight.promise;

    const promise = (async () => {
      const build = await this.buildSystemTreeSegments();
      if (this.trees.descriptorRevision === build.revision) {
        this.systemTreeProjection = {
          revision: build.revision,
          expiresAt: this.monotonicNow() + 1_000,
          segments: build.segments,
        };
      }
      return build.segments;
    })();
    this.systemTreeProjectionInFlight = { revision, promise };
    try {
      return await promise;
    } finally {
      if (this.systemTreeProjectionInFlight?.promise === promise) {
        this.systemTreeProjectionInFlight = undefined;
      }
    }
  }

  private async systemTreeChildren() {
    return (await this.systemTreeSegments())
      .map(({ segment, tree }) => ({
        tree: SYSTEM_TREE,
        name: tree.name,
        path: `/trees/${segment}`,
        kind: "markdown" as const,
        materialization: "available" as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private treeRecordSource(
    tree: LocalTreeDescriptor,
    conflict?: Awaited<ReturnType<typeof treeConflict>>,
  ): string {
    return [
      "---",
      `id: ${tree.id}`,
      `name: ${JSON.stringify(tree.name)}`,
      `placement: ${tree.placement}`,
      ...(tree.osPath ? [`path: ${JSON.stringify(tree.osPath)}`] : []),
      ...(tree.canonical ? [`canonical: ${JSON.stringify(tree.canonical.locator)}`] : []),
      ...(tree.canonical ? [`http: ${JSON.stringify(tree.canonical.httpURL)}`] : []),
      ...(tree.canonical ? [`endpoint: ${JSON.stringify(tree.canonical.endpoint)}`] : []),
      ...(tree.canonical ? [`canonicalPath: ${JSON.stringify(tree.canonical.path)}`] : []),
      `access: ${tree.access}`,
      ...(tree.sync ? [`sync: ${tree.sync}`] : []),
      ...(conflict ? [
        `conflictCurrent: ${JSON.stringify({ update: conflict.current.id, root: conflict.current.root })}`,
        `conflictBase: ${JSON.stringify(conflict.base)}`,
        `conflictCandidate: ${JSON.stringify(conflict.candidate)}`,
        `conflictDraft: ${JSON.stringify(conflict.draft.root)}`,
        `conflicts: ${JSON.stringify(conflict.conflicts)}`,
      ] : []),
      "---",
      "",
      `# ${tree.name}`,
      "",
    ].join("\n");
  }

  private async systemRecordAt(path: string) {
    if (path === "/diagnostics") {
      return {
        segment: "diagnostics",
        record: {
          source: `---\ncount: ${this.trees.diagnostics().length}\n---\n\n# Diagnostics\n\n${this.trees.diagnostics().map((item) => `- ${item.message}`).join("\n")}\n`,
        },
      };
    }
    if (path === "/credentials") {
      const status = await this.communityConfig.status();
      return {
        segment: "credentials",
        record: {
          source: status
            ? `---\ncommunityAccount: connected\ncredential: ${JSON.stringify(status.record.credential)}\ncredentialAvailable: ${status.credentialAvailable}\n---\n\n# Credentials\n\nSecrets are held by the operating system.\n`
            : "---\ncommunityAccount: missing\n---\n\n# Credentials\n",
        },
      };
    }
    const visitedMatch = /^\/visited\/([^/]+)$/.exec(path);
    if (visitedMatch) {
      const visit = (await this.visitedTrees.list()).find((candidate) => candidate.id === visitedMatch[1]);
      if (!visit) return null;
      return {
        segment: visit.name,
        record: {
          source: [
            "---",
            `id: ${JSON.stringify(visit.id)}`,
            `tree: ${JSON.stringify(visit.tree)}`,
            `locator: ${JSON.stringify(visit.locator)}`,
            ...(visit.canonical ? [`canonical: ${JSON.stringify(visit.canonical)}`] : []),
            `visitedAt: ${JSON.stringify(visit.visitedAt)}`,
            "---",
            "",
            `# ${visit.name}`,
            "",
          ].join("\n"),
        },
      };
    }
    return null;
  }

  private async configuredWire(): Promise<{ client: WireClient; origin: string }> {
    const configured = await this.communityConfig.get();
    if (!configured) {
      const record = await this.communityConfig.safe();
      if (record) {
        throw new ProtocolError(
          "credential-unavailable",
          `The credential for ~${record.handle} is unavailable. Run arbor connect ${record.origin} to restore it.`,
          409,
          { path: "system:credentials" },
        );
      }
      throw new ProtocolError("not-found", "Connect to an Arbor community first", 409, { path: "system:community" });
    }
    return {
      client: new WireClient(configured.record.origin, configured.accountToken),
      origin: configured.record.origin,
    };
  }

  private accountMetadata(account: import("@arbor/wire").RemoteAccountDescriptor) {
    return {
      id: account.id,
      handle: account.handle,
      profileTree: account.profileTree,
      profileURL: account.profileURL,
      communityTree: account.community.id,
      communityURL: account.community.canonical!.locator,
      configurationTree: account.configuration.id,
      configurationRef: account.configuration.ref,
      configurationUpdate: account.configuration.update,
    };
  }

  private async migrateLegacyCommunityConfig(): Promise<void> {
    if (await this.communityConfig.safe()) return;
    const legacy = await this.communityConfig.legacy();
    if (!legacy) return;
    try {
      const { account } = await new WireClient(legacy.origin, legacy.accountToken).account();
      await this.communityConfig.set(legacy.origin, legacy.accountToken, this.accountMetadata(account));
      await this.communityConfig.finishLegacyMigration();
    } catch {
      // Keep the recoverable legacy record and credential until its server is reachable.
    }
  }

  async claimProfileBootstrap(
    originInput: string,
    handle: string,
    inputPath: string,
    displayName?: string,
  ): Promise<MutationReceipt["effects"]> {
    const origin = new URL(originInput).origin;
    const requested = resolveUserPath(inputPath);
    await mkdir(requested, { recursive: true });
    const path = await realpath(requested);
    const index = join(path, "_index.md");
    const exists = await stat(index).then(() => true).catch(() => false);
    if (!exists) {
      await writeFile(index, `---\ntype: person\n---\n\n# ${displayName?.trim() || handle}\n`);
    } else if (!/^type:\s*person\s*$/m.test(await readFile(index, "utf8"))) {
      throw new ProtocolError("invalid-reference", "Profile _index.md must declare type: person", 409, { path });
    }
    const dataHome = arborDataRoot();
    const accountPath = join(dataHome, "account.yaml");
    const treesPath = join(dataHome, "trees.yaml");
    const devicesPath = join(dataHome, "devices");
    const pendingPath = join(arborPrivateRoot(), "bootstrap-claim.json");
    let pending: PendingClaimBootstrap | undefined;
    try { pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingClaimBootstrap; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let credential = await this.communityConfig.provisionalCredential();
    if (pending) {
      if (pending.version !== 1 || pending.origin !== origin || pending.handle !== handle || pending.path !== path) {
        throw new ProtocolError("conflict", "A different profile bootstrap is already pending in this data home", 409);
      }
      if (!credential || `sha256:${sha256(credential)}` !== pending.credentialDigest) {
        throw new ProtocolError("conflict", "The pending bootstrap credential is unavailable", 409);
      }
    } else {
      if (await Promise.any([accountPath, treesPath, devicesPath].map((candidate) => stat(candidate).then(() => true))).catch(() => false)) {
        throw new ProtocolError("conflict", "Account configuration already exists; bootstrap will not rewrite authored YAML", 409);
      }
      const profileTree = generateArborID("tr");
      const configurationTree = generateArborID("tr");
      const deviceID = generateArborID("dv");
      credential = `arb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
      const label = hostname() || "Initial device";
      const files = {
        account: [
          "version: 1", `community: ${JSON.stringify(origin)}`, "profile:", `  tree: ${JSON.stringify(profileTree)}`,
          `  handle: ${JSON.stringify(handle)}`, "admins:", `  - ${JSON.stringify(deviceID)}`, "",
        ].join("\n"),
        trees: [
          "version: 1", "trees:", `  ${JSON.stringify(profileTree)}:`, "    kind: person-profile",
          `    canonicalPath: ${JSON.stringify(`/~${handle}`)}`, "    access:", "      - subject:",
          "          kind: everyone", "        access: read", "",
        ].join("\n"),
        device: [
          "version: 1", `label: ${JSON.stringify(label)}`, "placements:", `  ${JSON.stringify(profileTree)}:`,
          `    server: ${JSON.stringify(origin)}`, `    path: ${JSON.stringify(path)}`, "",
        ].join("\n"),
      };
      const staging = join(arborPrivateRoot(), `bootstrap-config-${crypto.randomUUID()}`);
      await mkdir(join(staging, "devices"), { recursive: true, mode: 0o700 });
      try {
        await writeFile(join(staging, "account.yaml"), files.account, { mode: 0o600 });
        await writeFile(join(staging, "trees.yaml"), files.trees, { mode: 0o600 });
        await writeFile(join(staging, "devices", `${deviceID}.yaml`), files.device, { mode: 0o600 });
        pending = {
          version: 1, origin, handle, path, label, profileTree, configurationTree, deviceID,
          credentialDigest: `sha256:${sha256(credential)}`,
          files,
          profile: persistableBootstrapSnapshot(await snapshotDirectory(path)),
          configuration: persistableBootstrapSnapshot(await snapshotDirectory(staging)),
        };
        await this.communityConfig.storeProvisionalCredential(credential);
        const temporary = `${pendingPath}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
        await rename(temporary, pendingPath);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    const install = async (destination: string, source: string) => {
      const existing = await readFile(destination, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (existing !== null && existing !== source) throw new ProtocolError("conflict", `Bootstrap will not overwrite ${destination}`, 409);
      if (existing === null) await writeFile(destination, source, { mode: 0o600, flag: "wx" });
    };
    await mkdir(devicesPath, { recursive: true, mode: 0o700 });
    await install(accountPath, pending.files.account);
    await install(treesPath, pending.files.trees);
    await install(join(devicesPath, `${pending.deviceID}.yaml`), pending.files.device);
    await saveCurrentDeviceID(pending.deviceID);
    if (!credential) throw new ProtocolError("conflict", "The bootstrap credential is unavailable", 409);
    const result = await new WireClient(origin).claim(handle, {
      profileTree: pending.profileTree,
      configurationTree: pending.configurationTree,
      device: { id: pending.deviceID, label: pending.label, credentialDigest: pending.credentialDigest },
      profile: bootstrapSnapshot(pending.profile),
      configuration: bootstrapSnapshot(pending.configuration),
    });
    await this.communityConfig.set(origin, credential, this.accountMetadata(result.account));
    await rm(pendingPath, { force: true });
    await this.trees.refreshConfiguration();
    return [
      { kind: "updated", tree: result.configuration.id, path: "/account.yaml" },
      { kind: "created", tree: result.configuration.id, path: "/trees.yaml" },
      { kind: "created", tree: result.tree.id, path: "/" },
    ];
  }

  async forgetLocalAccount(): Promise<void> {
    await this.communityConfig.remove();
    this.trees.invalidateDescriptors();
    this.events.emit({ tree: SYSTEM_TREE, kind: "updated", path: "/credentials", origin: "api" });
  }

  /** Flush a valid file-edited configuration and its resulting tree work before a CLI process exits. */
  async synchronizeNow(): Promise<void> {
    await this.trees.refreshConfiguration();
    await this.syncAll(true);
  }

  async createPairingBootstrap() {
    const { client } = await this.configuredWire();
    return client.createPairing();
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
    const configured = await this.communityConfig.get();
    const client = new WireClient(
      placement.endpoint,
      configured?.record.origin === placement.endpoint ? configured.accountToken : undefined,
    );
    if (choice === "remote") {
      const remote = (await client.ref(tree)).snapshot;
      if (!remote.update) throw new Error("Server does not advertise accepted updates for this tree");
      await materializeTree(
        workspace.root,
        remote.ref,
        (hash) => client.object(tree, hash),
        undefined,
        this.trees.excludedMountsWithin(workspace.root),
      );
      await this.trees.updateSyncMetadata({
        ...placement,
        ref: remote.ref,
        update: remote.update,
        access: remote.access === "none" ? "read" : remote.access,
      });
      const acceptedLocal = await this.snapshotWorkspace(workspace, client);
      if (acceptedLocal.root !== remote.ref) throw new Error("Materialized remote tree does not match its server root");
      await saveAcceptedTreeObjects(tree, acceptedLocal);
      await clearPendingTreeUpdate(tree);
      await clearTreeConflict(tree);
      this.trees.setSyncState(tree, "idle");
      this.syncConflicts.delete(tree);
      return [{ kind: "updated", tree: SYSTEM_TREE, path: `/conflicts/${tree}` }];
    }

    let candidate: import("@arbor/wire").TreeSnapshot;
    if (choice === "draft") {
      const local = await this.snapshotWorkspace(workspace, client);
      if (local.root !== conflict.candidate) {
        throw new ProtocolError(
          "stale-content-revision",
          "Local files changed after the conflict; keep the current local version or review those edits before choosing the older draft",
          409,
          { path: `/trees/${tree}` },
        );
      }
      candidate = snapshotFromConflictDraft(conflict);
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
    await savePendingTreeUpdate(
      tree,
      pendingFromSnapshot(
        { root: conflict.current.root, update: conflict.current.id },
        candidate,
      ),
    );
    await clearTreeConflict(tree);
    this.syncConflicts.delete(tree);
    await this.updateWorkspace(workspace, placement, client, (await client.list()).snapshot);
    return [{ kind: "updated", tree: SYSTEM_TREE, path: `/trees/${tree}` }];
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
    );
    if (snapshot.root === placement.ref) return;
    const retainedHashes = new Set(retained.hashes);
    let pending = pendingFromSnapshot(
      { root: placement.ref, update: placement.update },
      snapshot,
      retainedHashes,
    );

    const baseBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(admission.baseSource) });
    const resultBytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(admission.resultSource) });
    const base = hashObject(baseBytes);
    const result = hashObject(resultBytes);
    const patch: FilePatch = {
      base,
      result,
      edits: admission.edits.map((edit) => ({
        offset: edit.offset,
        length: edit.length,
        bytes: new TextEncoder().encode(edit.replacement),
      })),
    };
    const patchSize = Buffer.byteLength(JSON.stringify({
      base,
      result,
      edits: patch.edits.map((edit) => ({ ...edit, bytes: Buffer.from(edit.bytes).toString("base64") })),
    }));
    const completeSize = Buffer.byteLength(JSON.stringify({ hash: result, bytes: Buffer.from(resultBytes).toString("base64") }));
    if (
      admission.edits.length > 0
      && retainedHashes.has(base)
      && snapshot.objects.has(result)
      && patchSize < completeSize
    ) {
      pending = withFilePatch(pending, patch);
    }
    await savePendingTreeUpdate(workspace.tree, pending);
  }

  private async updateWorkspace(
    workspace: Workspace,
    initialPlacement: import("@arbor/stores").SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
  ): Promise<void> {
    this.trees.setSyncState(workspace.tree, "syncing");
    let placement = initialPlacement;
    const remote = (await client.ref(workspace.tree)).snapshot;
    if (!remote.update) throw new Error("Server does not advertise accepted updates for this tree");
    if (
      placement.access !== remote.access
      || (placement.ref === remote.ref && placement.update !== remote.update)
    ) {
      placement = {
        ...placement,
        access: remote.access === "none" ? "read" : remote.access,
        ...(placement.ref === remote.ref ? { update: remote.update } : {}),
      };
      await this.trees.updateSyncMetadata(placement);
    }
    if (await treeConflict(workspace.tree)) {
      this.trees.setSyncState(workspace.tree, "conflict");
      this.syncConflicts.add(workspace.tree);
      return;
    }
    let pending = await pendingTreeUpdate(workspace.tree);
    let local = await this.snapshotWorkspace(workspace, client, remoteTrees);
    if (!placement.ref || !placement.update) {
      if (local.root === remote.ref) {
        await this.trees.updateSyncMetadata({ ...placement, ref: remote.ref, update: remote.update });
        await saveAcceptedTreeObjects(workspace.tree, local);
        this.trees.setSyncState(workspace.tree, "idle");
        this.syncConflicts.delete(workspace.tree);
        return;
      }
      const root = decodeWireObject(local.objects.get(local.root)!);
      if (root.type !== "directory" || root.entries.length) {
        throw new ProtocolError("conflict", "A new placement contains local content but has no accepted-update base", 409, {
          tree: workspace.tree,
          path: "/",
          details: { kind: "workspace-revision" },
        });
      }
      await materializeTree(
        workspace.root,
        remote.ref,
        (hash) => client.object(workspace.tree, hash),
        undefined,
        this.trees.excludedMountsWithin(workspace.root),
      );
      await this.trees.updateSyncMetadata({ ...placement, ref: remote.ref, update: remote.update });
      const acceptedLocal = await this.snapshotWorkspace(workspace, client, remoteTrees);
      if (acceptedLocal.root !== remote.ref) throw new Error("Materialized placement does not match its server root");
      await saveAcceptedTreeObjects(workspace.tree, acceptedLocal);
      this.trees.setSyncState(workspace.tree, "idle");
      return;
    }
    if (!pending && local.root === remote.ref) {
      await this.trees.updateSyncMetadata({ ...placement, ref: remote.ref, update: remote.update });
      this.trees.setSyncState(workspace.tree, "idle");
      this.syncConflicts.delete(workspace.tree);
      await saveAcceptedTreeObjects(workspace.tree, local);
      return;
    }
    if (placement.access !== "write") {
      this.trees.setSyncState(workspace.tree, "conflict");
      return;
    }
    if (!pending) {
      if (!placement.ref || !placement.update) throw new Error("Shared placement has no accepted-update base");
      const retained = await acceptedTreeObjects(workspace.tree);
      const retainedHashes = retained?.root === placement.ref ? new Set(retained.hashes) : new Set<ObjectHash>();
      pending = pendingFromSnapshot({ root: placement.ref, update: placement.update }, local, retainedHashes);
      await savePendingTreeUpdate(workspace.tree, pending);
    }

    for (let generation = 0; generation < 4; generation++) {
      try {
        const result = await client.submitUpdate(
          workspace.tree,
          pending.base,
          snapshotFromPending(pending),
          {
            returnSnapshot: "if-result-differs",
            filePatches: filePatchesFromPending(pending),
          },
        );
        const accepted = result.outcome === "current" ? result.current : result.update;
        local = await this.snapshotWorkspace(workspace, client, remoteTrees);
        if (local.root !== pending.candidate) {
          if (accepted.root === pending.candidate) {
            // The server accepted this local generation while a later local
            // save was already durable. Advance that later generation's base
            // to the just-accepted update; resubmitting it against the older
            // base would manufacture a same-device three-way merge and can
            // rematerialize the editor's own tree underneath its session.
            const retained = await acceptedTreeObjects(workspace.tree);
            const retainedHashes = new Set<ObjectHash>(retained?.hashes ?? []);
            retainedHashes.add(accepted.root);
            for (const object of pending.objects) retainedHashes.add(object.hash);
            for (const patch of pending.filePatches ?? []) retainedHashes.add(patch.result);
            placement = {
              ...placement,
              ref: accepted.root,
              update: accepted.id,
            };
            await this.trees.updateSyncMetadata(placement);
            await saveAcceptedTreeObjectHashes(workspace.tree, {
              root: accepted.root,
              hashes: [...retainedHashes],
            });
            pending = pendingFromSnapshot(
              { root: accepted.root, update: accepted.id },
              local,
              retainedHashes,
            );
          } else {
            const retained = await acceptedTreeObjects(workspace.tree);
            const retainedHashes = retained?.root === pending.base.root
              ? new Set(retained.hashes)
              : new Set<ObjectHash>();
            pending = pendingFromSnapshot(pending.base, local, retainedHashes);
          }
          await savePendingTreeUpdate(workspace.tree, pending);
          continue;
        }
        if (accepted.root !== pending.candidate) {
          if (!result.snapshot) throw new Error("Server omitted a required accepted snapshot");
          await materializeTree(
            workspace.root,
            accepted.root,
            (hash) => {
              const bytes = result.snapshot!.objects.find((object) => object.hash === hash)?.bytes;
              if (!bytes) throw new Error(`Accepted snapshot is missing object: ${hash}`);
              return Promise.resolve(bytes);
            },
            undefined,
            this.trees.excludedMountsWithin(workspace.root),
          );
        }
        await this.trees.updateSyncMetadata({
          ...placement,
          ref: accepted.root,
          update: accepted.id,
        });
        const acceptedLocal = await this.snapshotWorkspace(workspace, client, remoteTrees);
        if (acceptedLocal.root !== accepted.root) throw new Error("Materialized accepted tree does not match its server root");
        await saveAcceptedTreeObjects(workspace.tree, acceptedLocal);
        await clearPendingTreeUpdate(workspace.tree);
        await clearTreeConflict(workspace.tree);
        this.trees.setSyncState(workspace.tree, "idle");
        this.syncConflicts.delete(workspace.tree);
        return;
      } catch (error) {
        if (error instanceof WireUpdateConflict) {
          await saveTreeConflict(workspace.tree, error.result);
          await clearPendingTreeUpdate(workspace.tree);
          this.trees.setSyncState(workspace.tree, "conflict");
          const firstConflict = !this.syncConflicts.has(workspace.tree);
          this.syncConflicts.add(workspace.tree);
          if (firstConflict) {
            this.events.emit({ tree: workspace.tree, kind: "diagnostic", path: "/", origin: "sync" });
          }
          return;
        }
        throw error;
      }
    }
    throw new Error("Local tree kept changing while an accepted update was being applied");
  }

  private async syncAll(throwErrors = false): Promise<void> {
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
        const configured = await this.communityConfig.get();
        const remoteTreesByOrigin = new Map<string, Promise<RemoteTreeDescriptor[]>>();
        const placements = this.trees.sharedPlacements().sort((left, right) =>
          Number(right.kind === "account-configuration") - Number(left.kind === "account-configuration")
        );
        for (const placement of placements) {
          try {
            const client = new WireClient(
              placement.endpoint,
              configured?.record.origin === placement.endpoint ? configured.accountToken : undefined,
            );
            const workspace = await this.trees.workspaceByTree(placement.tree);
            if (!workspace) continue;
            let listed = remoteTreesByOrigin.get(placement.endpoint);
            if (!listed) {
              listed = client.list().then((value) => value.snapshot);
              remoteTreesByOrigin.set(placement.endpoint, listed);
            }
            const remoteTrees = await listed;
            if (!remoteTrees.some((tree) => tree.id === placement.tree)) {
              const initial = await this.snapshotWorkspace(workspace, client, remoteTrees);
              const activated = await client.activateTree(placement.tree, initial);
              await this.trees.updateSyncMetadata({
                ...placement,
                ref: activated.snapshot.ref,
                update: activated.snapshot.update,
                access: activated.snapshot.access === "none" ? "write" : activated.snapshot.access,
              });
              await saveAcceptedTreeObjects(placement.tree, initial);
              this.trees.setSyncState(placement.tree, "idle");
              continue;
            }
            await this.updateWorkspace(workspace, placement, client, remoteTrees);
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
    await this.localFs[Symbol.asyncDispose]();
    await this.trees[Symbol.asyncDispose]();
  }
}
