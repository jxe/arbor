import { homedir } from "node:os";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
  BacklinksPage,
  ChildrenPage,
  CollectionResultPage,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeSnapshot,
  RecoveryPage,
  SearchPage,
  SystemOperation,
  TreeDescriptor,
  TreeRef,
  WorkspaceOperation,
} from "@arbor/core";
import { LOCAL_TREE, SYSTEM_TREE, canonicalJSONString, canonicalNodePath, revisionOf, sha256, siblingMarkdownTreePath } from "@arbor/core";
import { completeDirectoryDocument, parseMarkdown } from "@arbor/editor";
import { FsConflictError, MutationJournal } from "@arbor/fs";
import { CommunityConfigStore, VisitedTreeStore, arborDataRoot } from "@arbor/stores";
import { WireClient, WireUpdateConflict, decodeWireObject, encodeWireObject, hashObject, materializeTree, resolveWireLogicalNode, snapshotDirectory, type AuthorityDevice, type FilePatch, type ObjectHash, type PairingOffer, type RemoteTreeDescriptor } from "@arbor/wire";
import { EventBus } from "./events.ts";
import { fsErrorCode } from "./fs-errors.ts";
import { FilesystemService, realOsPath } from "./fs-service.ts";
import { TreeManager } from "./tree-manager.ts";
import { ProtocolError, RevisionConflictError, Workspace, type WorkspaceOptions } from "./workspace.ts";
import {
  acceptedTreeObjects,
  clearPendingTreeUpdate,
  clearTreeConflict,
  filePatchesFromPending,
  pendingFromSnapshot,
  pendingTreeUpdate,
  savePendingTreeUpdate,
  saveAcceptedTreeObjects,
  saveTreeConflict,
  snapshotFromPending,
  snapshotFromConflictDraft,
  treeConflict,
  withFilePatch,
} from "./sync-state.ts";
import type { ConfirmedSourcePatch } from "./workspace.ts";

const SYSTEM_REMOTE_TIMEOUT_MS = 1_000;

type ResolvedScope =
  | { kind: "root"; workspace: Workspace; ref: NodeRef }
  | { kind: "local"; path: string; ref: NodeRef }
  | { kind: "system"; path: string };

export function resolveUserPath(input: string, home = homedir()): string {
  const value = input.trim();
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return resolve(value);
}

/**
 * The daemon's top-level authority: one process-wide event bus, a root
 * manager owning N per-root Workspaces, and a filesystem service for the
 * untracked `local` scope. Requests resolve here by tree scope — with
 * `local` references canonicalized into an owning live root when their
 * real path falls inside one — before dispatch.
 */
export class ArborService implements AsyncDisposable {
  readonly events: EventBus;
  readonly trees: TreeManager;
  readonly localFs: FilesystemService;
  readonly communityConfig = new CommunityConfigStore();
  readonly visitedTrees = new VisitedTreeStore();
  private systemMutations = new MutationJournal(join(arborDataRoot(), "system", "journal", "mutations"));
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncing = false;
  private syncRequested = false;
  private syncConflicts = new Set<string>();

  private constructor(events: EventBus, trees: TreeManager, options: { autoSync?: boolean } = {}) {
    this.events = events;
    this.trees = trees;
    this.localFs = new FilesystemService(events);
    if (options.autoSync !== false) {
      this.syncTimer = setInterval(() => { void this.syncAll(); }, 2_000);
      this.syncTimer.unref?.();
      setTimeout(() => { void this.syncAll(); }, 0);
    }
  }

  static async open(
    sessionPath: string,
    options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {},
  ): Promise<ArborService> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    await trees.openSession(sessionPath, options);
    const service = new ArborService(events, trees);
    await service.migrateLegacyCommunityConfig();
    return service;
  }

  /** Open system/account authority without attaching Arbor to a filesystem session. */
  static async openControl(options: { autoSync?: boolean } = {}): Promise<ArborService> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    const service = new ArborService(events, trees, { autoSync: options.autoSync ?? false });
    await service.migrateLegacyCommunityConfig();
    return service;
  }

  get session(): Workspace {
    try {
      return this.trees.session;
    } catch {
      throw new ProtocolError("not-found", "No local browsing session is active", 409);
    }
  }

  /** Resolve a reference's scope, canonicalizing placed refs into owning trees. */
  async resolveScope(ref: NodeRef): Promise<ResolvedScope> {
    const tree = ref.tree;
    if (tree === undefined) {
      // A bare pageID fans out across all live trees; a bare path retains
      // launch-context compatibility.
      if ("pageID" in ref) {
        const workspace = await this.pageIDWorkspace(ref.pageID);
        return { kind: "root", workspace, ref };
      }
      return { kind: "root", workspace: this.session, ref };
    }
    const workspace = await this.trees.workspaceByTree(tree);
    if (workspace) {
      if ("path" in ref) {
        const mounted = this.trees.reservedBoundary(tree, canonicalNodePath(ref.path))
          ?? this.trees.localMountBoundary(tree, canonicalNodePath(ref.path));
        if (mounted) {
          const mountedWorkspace = await this.trees.workspaceByTree(mounted.tree);
          if (mountedWorkspace) {
          return {
            kind: "root",
            workspace: mountedWorkspace,
            ref: { tree: mounted.tree, path: mounted.treePath },
          };
          }
        }
      }
      return { kind: "root", workspace, ref };
    }
    if (tree === SYSTEM_TREE) {
      if (!("path" in ref)) {
        throw new ProtocolError("invalid-reference", "The system scope is addressed by path", 400);
      }
      return { kind: "system", path: canonicalNodePath(ref.path) };
    }
    if (tree === LOCAL_TREE) {
      if (!("path" in ref)) {
        throw new ProtocolError("invalid-reference", "Durable identity resolution requires a live root", 400);
      }
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
            ref: { tree: mounted.tree, path: mounted.treePath },
          };
          }
        }
        return {
          kind: "root",
          workspace: owner.workspace,
          ref: { tree: owner.workspace.tree, path: canonicalNodePath(owner.treePath) },
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
            ref: { tree: siblingOwner.workspace.tree, path: canonicalNodePath(siblingOwner.treePath) },
          };
        }
      }
      return { kind: "local", path: real, ref: { tree: LOCAL_TREE, path: real } };
    }
    throw new ProtocolError("not-found", `Unknown tree scope: ${tree}`, 404);
  }

  async snapshot(ref: NodeRef): Promise<NodeSnapshot> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") return scope.workspace.snapshot(scope.ref);
    if (scope.kind === "local") return this.localFs.snapshot(scope.path);
    return this.systemSnapshot(scope.path);
  }

  async remoteSnapshot(locatorInput: string): Promise<NodeSnapshot> {
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
              path: cached.snapshot.path,
              severity: "warning",
            },
          ],
        };
      }
      throw error;
    }
  }

  /** Resolve one unplaced canonical URL into a read-only, in-memory node. */
  private async fetchRemoteSnapshot(locatorInput: string): Promise<NodeSnapshot> {
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
    let remote: RemoteTreeDescriptor & { path: string };
    try { remote = await client.resolve(canonicalPath || "/"); }
    catch (error) {
      if (error instanceof TypeError) throw error;
      throw new ProtocolError("not-found", `The Arbor page is unavailable: ${origin}${canonicalPath}`, 404);
    }

    const logical = await resolveWireLogicalNode(remote.ref, remote.path, (hash) => client.object(hash));
    if (!logical) throw new ProtocolError("not-found", "The remote path is unavailable", 404);
    const object = logical.object;
    const objectName = logical.objectName || remote.canonicalPath.split("/").filter(Boolean).at(-1) || "community";
    const observedThrough = this.events.currentCursor();
    const enclosingTree: TreeDescriptor = {
      id: remote.id,
      name: remote.canonicalPath.split("/").filter(Boolean).at(-1) ?? "community",
      canonical: remote.arborURL,
      canonicalPath: remote.canonicalPath,
      httpURL: remote.httpURL,
      endpoint: origin,
      publicAccess: remote.publicAccess,
      access: "read",
      placement: "remote",
      sync: "idle",
    };
    const base = {
      tree: remote.id,
      enclosingTree,
      writable: false,
      materialization: "available" as const,
      observedThrough,
      diagnostics: logical.duplicateBody ? [{
        code: "duplicate-body-representation",
        message: `${canonicalNodePath(remote.path)} has both a sibling Markdown body and _index.md; keep only one.`,
        path: canonicalNodePath(remote.path),
        severity: "error" as const,
      }] : [],
    };
    if (object.type === "file") {
      const markdown = objectName.endsWith(".md");
      const source = new TextDecoder().decode(object.bytes);
      const document = markdown ? parseMarkdown(source) : undefined;
      const authoredTitle = document?.blocks.find((block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1)?.content;
      return {
        ...base,
        ref: { tree: remote.id, path: canonicalNodePath(remote.path) },
        path: canonicalNodePath(remote.path),
        name: authoredTitle || (markdown ? objectName.slice(0, -3) : objectName),
        kind: markdown ? "markdown" : "file",
        ...(markdown ? {
          contentRevision: revisionOf(source),
          bodyState: "stored" as const,
          document,
        } : {}),
      };
    }

    const source = logical.body ? new TextDecoder().decode(logical.body.bytes) : "";
    const currentCanonicalPath = `${remote.canonicalPath === "/" ? "" : remote.canonicalPath}${remote.path === "/" ? "" : remote.path}` || "/";
    const children = (await Promise.all(object.entries
      .filter((entry) => entry.name !== "_index.md")
      .map(async (entry) => {
        const childObject = entry.hash ? decodeWireObject(await client.object(entry.hash)) : null;
        const markdown = childObject?.type === "file" && entry.name.endsWith(".md");
        const name = markdown ? entry.name.slice(0, -3) : entry.name;
        if (entry.tree) {
          const accessible = await client.resolve(`${currentCanonicalPath.replace(/\/$/, "")}/${name}`).then(() => true).catch(() => false);
          if (!accessible) return null;
        }
        const path = canonicalNodePath(`${remote.path === "/" ? "" : remote.path}/${name}`);
        const childDocument = markdown && childObject?.type === "file"
          ? parseMarkdown(new TextDecoder().decode(childObject.bytes))
          : null;
        const pageID = childDocument && typeof childDocument.frontmatter.id === "string" ? childDocument.frontmatter.id : undefined;
        return {
          name,
          path,
          kind: entry.tree || childObject?.type === "directory" ? "directory" as const : markdown ? "markdown" as const : "file" as const,
          materialization: "available" as const,
          ...(pageID ? { pageID } : {}),
        };
      }))).filter((child): child is NonNullable<typeof child> => child !== null);
    const isCollectionDirectory = object.entries.some((entry) =>
      entry.name === "schema.ts" || ["_store.csv", "_store.jsonl", "_store.sqlite3", "_store.postgres"].includes(entry.name)
    );
    const operationalChildren = isCollectionDirectory
      ? children.filter((child) => child.kind !== "markdown")
      : children;
    const complete = completeDirectoryDocument(remote.path, source, operationalChildren);
    const authoredTitle = complete.document.blocks.find((block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1)?.content;
    const descriptors = operationalChildren
      .map((child) => ({ path: canonicalNodePath(child.path), kind: child.kind, pageID: child.pageID ?? null }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
    return {
      ...base,
      ref: { tree: remote.id, path: canonicalNodePath(remote.path) },
      path: canonicalNodePath(remote.path),
      name: authoredTitle || objectName,
      kind: "directory",
      contentRevision: revisionOf(`${source}\0${JSON.stringify(descriptors)}`),
      directoryRevision: revisionOf(operationalChildren.map((child) => `${child.path}:${child.kind}`).join("\n")),
      bodyState: logical.body ? "stored" : "implicit",
      ...(logical.bodyOrigin ? { bodyOrigin: logical.bodyOrigin } : {}),
      document: complete.document,
      children,
    };
  }

  async children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") {
      const page = await scope.workspace.children(scope.ref, cursor);
      if (!("path" in scope.ref)) return page;
      const mounted = [
        ...this.trees.mountedChildren(scope.workspace.tree, canonicalNodePath(scope.ref.path)),
        ...this.trees.localMountedChildren(scope.workspace.tree, canonicalNodePath(scope.ref.path)),
      ];
      if (!mounted.length) return page;
      const existing = new Set(page.items.map((item) => item.path));
      return {
        ...page,
        items: [
          ...page.items,
          ...mounted.filter((item) => !existing.has(item.path)).map((item) => ({
            name: item.name,
            path: item.path,
            kind: "directory" as const,
            materialization: "available" as const,
          })),
        ].sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    if (scope.kind === "local") return this.localFs.children(scope.path, cursor);
    return this.systemChildren(scope.path);
  }

  async collectionPage(ref: NodeRef, cursor?: string | null, table?: string): Promise<CollectionResultPage> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") return scope.workspace.collectionPage(scope.ref, cursor, table);
    if (scope.kind === "local") return this.localFs.collectionPage(scope.path, cursor, table);
    throw new ProtocolError("unsupported-operation", "The system scope has no collections", 422);
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
          ...(target.pageID ? { pageID: target.pageID } : {}),
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

  async searchPage(tree: TreeRef | undefined, query: string, cursor?: string | null): Promise<SearchPage> {
    if (tree === undefined) return this.session.searchPage(query, cursor);
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
    if (this.isSystemMutation(request.operations)) return this.executeSystemMutation(request.mutationID, request.operations[0]);
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
        const current = await workspace.snapshot({ path: error.current.path }).catch(() => undefined);
        throw new ProtocolError("stale-content-revision", error.message, 409, {
          path: error.current.path,
          current,
        });
      }
      if (error instanceof FsConflictError) {
        const mapped = fsErrorCode(error);
        const current = error.details.current
          ? await workspace.snapshot({ path: error.details.current.node.path }).catch(() => undefined)
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
      const scope = await this.resolveScope({ tree: LOCAL_TREE, path: referrerUrlPath });
      if (scope.kind !== "root") return null;
      return await scope.workspace.fileSurface(treeRootedPath, raw).catch(() => null);
    } catch {
      return null;
    }
  }

  async fileSurface(urlPath: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    let scope: ResolvedScope;
    try {
      scope = await this.resolveScope({ tree: LOCAL_TREE, path: urlPath });
    } catch {
      return null;
    }
    if (scope.kind === "root") {
      return scope.workspace.fileSurface("path" in scope.ref ? scope.ref.path : "/", raw).catch(() => null);
    }
    if (scope.kind === "local") return this.localFs.fileSurface(scope.path, raw).catch(() => null);
    return null;
  }

  /** Resolve a bare pageID across all live trees. */
  private async pageIDWorkspace(pageID: string): Promise<Workspace> {
    const owners: Array<{ workspace: Workspace; paths: readonly string[] }> = [];
    for (const workspace of await this.trees.openAll()) {
      const paths = workspace.pageIDOwners(pageID);
      if (paths.length) owners.push({ workspace, paths });
    }
    if (owners.length > 1) {
      throw new ProtocolError("duplicate-page-id", `Page ID ${pageID} has owners in multiple trees`, 409, {
        owners: owners.flatMap((owner) =>
          owner.paths.map((path) => `${owner.workspace.root}${path === "/" ? "" : path}`)
        ),
      });
    }
    return owners[0]?.workspace ?? this.session;
  }

  /** Safe `system:` projections; changes use concrete system mutations. */
  private async systemSnapshot(path: string): Promise<NodeSnapshot> {
    await this.trees.descriptors();
    const observedThrough = this.events.currentCursor();
    const base = {
      tree: SYSTEM_TREE,
      writable: false,
      materialization: "available" as const,
      diagnostics: [],
      observedThrough,
    };
    if (path === "/") {
      return {
        ...base,
        ref: { tree: SYSTEM_TREE, path: "/" },
        path: "/",
        name: "system",
        kind: "directory",
        contentRevision: revisionOf(""),
        directoryRevision: revisionOf(""),
        bodyState: "implicit",
        document: parseMarkdown(""),
        diagnostics: [],
      };
    }
    if (path === "/trees" || path === "/visited") {
      const listing = path === "/trees"
        ? await this.systemTreeChildren()
        : (await this.visitedTrees.list()).map((visit) => visit.id);
      const revision = revisionOf(listing.map((entry) => typeof entry === "string" ? entry : entry.name).join("\n"));
      return {
        ...base,
        ref: { tree: SYSTEM_TREE, path },
        path,
        name: path.slice(1),
        kind: "directory",
        contentRevision: revision,
        directoryRevision: revision,
        bodyState: "implicit",
        document: parseMarkdown(""),
        diagnostics: this.trees.diagnostics(),
      };
    }
    const record = await this.systemRecordAt(path);
    if (!record) {
      throw new ProtocolError("not-found", `Node not found: system:${path.slice(1)}`, 404, { path });
    }
    return {
      ...base,
      ref: { tree: SYSTEM_TREE, path },
      path,
      name: record.segment,
      kind: "markdown",
      contentRevision: revisionOf(record.record.source),
      bodyState: "stored",
      document: parseMarkdown(record.record.source),
      diagnostics: [],
    };
  }

  private async systemChildren(path: string): Promise<ChildrenPage> {
    await this.trees.descriptors();
    const observedThrough = this.events.currentCursor();
    if (path === "/") {
      return {
        parent: { tree: SYSTEM_TREE, path: "/" },
        items: [
          { name: "device", path: "/device", kind: "markdown", materialization: "available" },
          { name: "community", path: "/community", kind: "markdown", materialization: "available" },
          { name: "trees", path: "/trees", kind: "directory", materialization: "available" },
          { name: "credentials", path: "/credentials", kind: "markdown", materialization: "available" },
          { name: "visited", path: "/visited", kind: "directory", materialization: "available" },
          { name: "diagnostics", path: "/diagnostics", kind: "markdown", materialization: "available" },
        ],
        nextCursor: null,
        observedThrough,
      };
    }
    if (path === "/trees") {
      return {
        parent: { tree: SYSTEM_TREE, path: "/trees" },
        items: await this.systemTreeChildren(),
        nextCursor: null,
        observedThrough,
      };
    }
    if (path === "/visited") {
      const visits = await this.visitedTrees.list();
      return {
        parent: { tree: SYSTEM_TREE, path: "/visited" },
        items: visits.map((visit) => ({
          name: visit.name,
          path: `/visited/${visit.id}`,
          kind: "markdown" as const,
          materialization: "available" as const,
        })),
        nextCursor: null,
        observedThrough,
      };
    }
    throw new ProtocolError("invalid-reference", `system:${path.slice(1)} does not have children`, 400, { path });
  }

  private async systemTreeSegments() {
    const configured = await this.communityConfig.get();
    let remote: RemoteTreeDescriptor[] = [];
    let writable = new Set<string>();
    const remoteAccess = new Map<string, import("@arbor/wire").RemoteAccessEntry[]>();
    if (configured) {
      const client = new WireClient(configured.record.origin, configured.accountToken, {
        timeoutMs: SYSTEM_REMOTE_TIMEOUT_MS,
      });
      const [listed, account] = await Promise.allSettled([client.list(), client.account()]);
      if (listed.status === "fulfilled") remote = listed.value;
      if (account.status === "fulfilled") {
        writable = new Set(account.value.writableProfiles.map((tree) => tree.id));
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
        const entries = await client.access(tree.id).catch(() => []);
        remoteAccess.set(tree.id, entries);
      }));
    }
    // Read local descriptors after the bounded remote refresh so any transport
    // failure above is visible immediately as `sync: offline`.
    const local = await this.trees.descriptors();
    const byID = new Map<string, TreeDescriptor>(local.map((tree) => [tree.id, tree]));
    for (const tree of remote) {
      const current = byID.get(tree.id);
      byID.set(tree.id, {
        id: tree.id,
        name: current?.name ?? tree.canonicalPath.split("/").filter(Boolean).at(-1) ?? "community",
        osPath: current?.osPath,
        canonical: tree.arborURL,
        canonicalPath: tree.canonicalPath,
        httpURL: tree.httpURL,
        endpoint: configured?.record.origin,
        publicAccess: tree.publicAccess,
        access: current?.access ?? tree.access ?? (writable.has(tree.id) ? "write" : "read"),
        accessEntries: remoteAccess.get(tree.id),
        placement: current ? "shared" : "remote",
        sync: current?.sync,
      });
    }
    return Promise.all([...byID.values()].map(async (tree) => ({
      segment: tree.id,
      tree,
      source: this.treeRecordSource(
        tree,
        tree.placement === "shared" ? await treeConflict(tree.id) : undefined,
      ),
    })));
  }

  private async systemTreeChildren() {
    return (await this.systemTreeSegments())
      .map(({ segment, tree }) => ({
        name: tree.name,
        path: `/trees/${segment}`,
        kind: "markdown" as const,
        materialization: "available" as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private treeRecordSource(
    tree: TreeDescriptor,
    conflict?: Awaited<ReturnType<typeof treeConflict>>,
  ): string {
    return [
      "---",
      `id: ${tree.id}`,
      `name: ${JSON.stringify(tree.name)}`,
      `placement: ${tree.placement}`,
      ...(tree.osPath ? [`path: ${JSON.stringify(tree.osPath)}`] : []),
      ...(tree.canonical ? [`canonical: ${JSON.stringify(tree.canonical)}`] : []),
      ...(tree.httpURL ? [`http: ${JSON.stringify(tree.httpURL)}`] : []),
      ...(tree.endpoint ? [`endpoint: ${JSON.stringify(tree.endpoint)}`] : []),
      ...(tree.canonicalPath ? [`canonicalPath: ${JSON.stringify(tree.canonicalPath)}`] : []),
      ...(tree.publicAccess ? [`publicAccess: ${tree.publicAccess}`] : []),
      ...(tree.access ? [`access: ${tree.access}`] : []),
      ...(tree.accessEntries ? [`accessEntries: ${JSON.stringify(tree.accessEntries)}`] : []),
      ...(tree.sync ? [`sync: ${tree.sync}`] : []),
      ...(conflict ? [
        `conflictCurrent: ${JSON.stringify({ update: conflict.current.id, root: conflict.current.root })}`,
        `conflictBase: ${JSON.stringify(conflict.base)}`,
        `conflictCandidate: ${JSON.stringify(conflict.candidate)}`,
        `conflictDraft: ${JSON.stringify(conflict.draft.root)}`,
        `conflicts: ${JSON.stringify(conflict.conflicts)}`,
      ] : []),
      ...(tree.legacy ? ["legacy: true"] : []),
      "---",
      "",
      `# ${tree.name}`,
      "",
    ].join("\n");
  }

  private async systemRecordAt(path: string) {
    if (path === "/device") {
      return { segment: "device", record: { source: `---\nhome: ${JSON.stringify(homedir())}\n---\n\n# Device\n` } };
    }
    if (path === "/community") {
      const status = await this.communityConfig.status();
      const record = status?.record;
      return {
        segment: "community",
        record: {
          source: record
            ? [
                "---",
                `origin: ${JSON.stringify(record.origin)}`,
                `account: ${JSON.stringify(record.id)}`,
                `handle: ${JSON.stringify(record.handle)}`,
                ...(record.profileTree ? [`profileTree: ${JSON.stringify(record.profileTree)}`] : []),
                ...(record.profileURL ? [`profileURL: ${JSON.stringify(record.profileURL)}`] : []),
                `communityTree: ${JSON.stringify(record.communityTree)}`,
                `communityURL: ${JSON.stringify(record.communityURL)}`,
                `credential: ${JSON.stringify(record.credential)}`,
                "connected: true",
                `credentialAvailable: ${status.credentialAvailable}`,
                "---",
                "",
                "# Community",
                "",
              ].join("\n")
            : "---\nconnected: false\n---\n\n# Community\n",
        },
      };
    }
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
    const match = /^\/trees\/([^/]+)$/.exec(path);
    if (!match) return null;
    const found = (await this.systemTreeSegments()).find(({ segment }) => segment === match[1]);
    return found ? { segment: found.segment, record: { source: found.source } } : null;
  }

  private isSystemMutation(operations: readonly WorkspaceOperation[]): operations is [SystemOperation] {
    return operations.length === 1
      && ["connectCommunity", "disconnectCommunity", "claimProfile", "createGroupProfile", "promoteTree", "placeTree", "removeTreePlacement", "resolveTreeConflict", "setTreeAccess"].includes(operations[0]!.op);
  }

  private safeSystemOperation(operation: SystemOperation): SystemOperation | Record<string, unknown> {
    if (operation.op === "connectCommunity") {
      return { ...operation, accountToken: `[sha256:${sha256(operation.accountToken)}]` };
    }
    if (operation.op === "setTreeAccess" && operation.subject.kind === "link") {
      return {
        ...operation,
        subject: { kind: "link", secret: `[sha256:${sha256(operation.subject.secret)}]` },
      };
    }
    return operation;
  }

  private async executeSystemMutation(mutationID: string, operation: SystemOperation): Promise<MutationReceipt> {
    const safeRequest = { mutationID, operations: [this.safeSystemOperation(operation)] };
    const requestHash = sha256(canonicalJSONString(safeRequest));
    const existing = await this.systemMutations.prepare(mutationID, requestHash, safeRequest);
    if (existing.requestHash !== requestHash) {
      throw new ProtocolError("mutation-mismatch", `Mutation ${mutationID} was already used with different input`, 409, { mutationID });
    }
    if (existing.receipt) return existing.receipt;

    let effects: MutationReceipt["effects"];
    if (operation.op === "connectCommunity") {
      effects = await this.connectCommunity(operation.origin, operation.accountToken);
    } else if (operation.op === "disconnectCommunity") {
      await this.communityConfig.remove();
      effects = [{ kind: "updated", tree: SYSTEM_TREE, path: "/community" }];
    } else if (operation.op === "claimProfile") {
      effects = await this.claimProfile(operation.origin, operation.handle, operation.path, operation.displayName);
    } else if (operation.op === "createGroupProfile") {
      effects = await this.createGroupProfile(operation.handle, operation.path, operation.displayName);
    } else if (operation.op === "promoteTree") {
      effects = await this.promoteTree(operation.path, operation.canonicalPath, operation.audience);
    } else if (operation.op === "placeTree") {
      effects = await this.placeTree(operation.tree, operation.path, operation.endpoint, operation.canonical);
    } else if (operation.op === "removeTreePlacement") {
      effects = await this.removeTreePlacement(operation.path, operation.endpoint, operation.canonicalPath);
    } else if (operation.op === "resolveTreeConflict") {
      effects = await this.resolveTreeConflict(operation.tree, operation.choice);
    } else {
      effects = await this.setTreeAccess(operation.tree, operation.subject, operation.access);
    }
    await this.systemMutations.markMaterialized(mutationID, requestHash, effects);
    let cursor = this.events.currentCursor();
    for (const effect of effects) {
      cursor = this.events.emit({
        tree: effect.tree,
        kind: effect.kind,
        path: effect.path,
        previousPath: effect.previousPath,
        origin: "api",
        mutationID,
      }).cursor;
    }
    const receipt: MutationReceipt = { mutationID, eventCursor: cursor, effects };
    await this.systemMutations.complete(mutationID, requestHash, receipt);
    return receipt;
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

  async communityDevices(): Promise<AuthorityDevice[]> {
    const { client } = await this.configuredWire();
    return client.devices();
  }

  async createCommunityPairing(): Promise<PairingOffer> {
    const { client } = await this.configuredWire();
    return client.createPairing();
  }

  async revokeCommunityDevice(device: string): Promise<AuthorityDevice> {
    const { client } = await this.configuredWire();
    return client.revokeDevice(device);
  }

  private accountMetadata(account: import("@arbor/wire").RemoteAccountDescriptor) {
    return {
      id: account.id,
      handle: account.handle,
      profileTree: account.profileTree,
      profileURL: account.profileURL,
      communityTree: account.community.id,
      communityURL: account.community.arborURL,
    };
  }

  private async migrateLegacyCommunityConfig(): Promise<void> {
    if (await this.communityConfig.safe()) return;
    const legacy = await this.communityConfig.legacy();
    if (!legacy) return;
    try {
      const account = await new WireClient(legacy.origin, legacy.accountToken).account();
      await this.communityConfig.set(legacy.origin, legacy.accountToken, this.accountMetadata(account));
      await this.communityConfig.finishLegacyMigration();
    } catch {
      // Keep the recoverable legacy record and credential until its authority is reachable.
    }
  }

  private async connectCommunity(originInput: string, accountToken: string): Promise<MutationReceipt["effects"]> {
    const origin = new URL(originInput).origin;
    const account = await new WireClient(origin, accountToken).account();
    await this.communityConfig.set(origin, accountToken, this.accountMetadata(account));
    for (const writable of account.writableProfiles) {
      const placement = this.trees.placementFor(writable.id);
      if (!placement || placement.source === "local") continue;
      await this.trees.applySharedPlacement({
        ...placement,
        ref: writable.ref,
        ...(writable.update ? { update: writable.update } : {}),
        access: "write",
        publicAccess: writable.publicAccess,
      });
    }
    return [{ kind: "updated", tree: SYSTEM_TREE, path: "/community" }];
  }

  private async claimProfile(
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
    const result = await new WireClient(origin).claim(handle, await snapshotDirectory(path));
    await this.communityConfig.set(origin, result.accountToken, this.accountMetadata(result.account));
    await this.trees.applySharedPlacement({
      path,
      source: `arbor://tree/${result.tree.id}/` as const,
      tree: result.tree.id,
      canonical: result.tree.arborURL,
      endpoint: origin,
      ref: result.tree.ref,
      ...(result.tree.update ? { update: result.tree.update } : {}),
      access: "write",
      publicAccess: result.tree.publicAccess,
    });
    return [
      { kind: "updated", tree: SYSTEM_TREE, path: "/community" },
      { kind: "created", tree: SYSTEM_TREE, path: `/trees/${result.tree.id}` },
      { kind: "created", tree: result.tree.id, path: "/" },
    ];
  }

  private async promoteTree(
    inputPath: string,
    canonicalPath: string,
    audience: import("@arbor/core").ShareAudience,
    kind: "shared-subtree" | "group-profile" = "shared-subtree",
  ): Promise<MutationReceipt["effects"]> {
    const path = await realpath(resolveUserPath(inputPath));
    const profileIndex = await readFile(join(path, "_index.md"), "utf8").catch(() => "");
    const effectiveKind = kind === "shared-subtree"
      && /^\/~[a-z0-9][a-z0-9-]{0,62}$/.test(canonicalPath)
      && /^type:\s*group\s*$/m.test(profileIndex)
      ? "group-profile"
      : kind;
    const { client, origin } = await this.configuredWire();
    const snapshot = await snapshotDirectory(
      path,
      this.trees.sharedBoundariesWithin(path),
      this.trees.excludedMountsWithin(path),
    );
    const rules = audience.kind === "rules"
      ? audience.rules
      : audience.kind === "private"
        ? []
        : audience.kind === "everyone"
          ? [{ subject: { kind: "everyone" as const }, access: audience.access }]
          : [{ subject: { kind: "profile" as const, locator: audience.locator }, access: audience.access }];
    const everyone = rules.find((rule) => rule.subject.kind === "everyone");
    const remote = await client.create(canonicalPath, snapshot, {
      kind: effectiveKind,
      publicAccess: everyone?.access ?? "none",
      profileAccess: rules.flatMap((rule) => rule.subject.kind === "profile"
        ? [{ locator: rule.subject.locator, access: rule.access }]
        : []),
    });
    await this.trees.applySharedPlacement({
      path,
      source: `arbor://tree/${remote.id}/` as const,
      tree: remote.id,
      canonical: remote.arborURL,
      endpoint: origin,
      ref: remote.ref,
      ...(remote.update ? { update: remote.update } : {}),
      access: "write",
      publicAccess: remote.publicAccess,
    });
    for (const ancestor of this.trees.sharedPlacements()) {
      if (ancestor.tree === remote.id || ancestor.endpoint !== origin || !ancestor.canonical) continue;
      const ancestorPath = new URL(ancestor.canonical).pathname.replace(/\/$/, "");
      if (remote.canonicalPath !== ancestorPath && !remote.canonicalPath.startsWith(`${ancestorPath}/`)) continue;
      const refreshed = await client.ref(ancestor.tree);
      await this.trees.applySharedPlacement({
        ...ancestor,
        ref: refreshed.ref,
        ...(refreshed.update ? { update: refreshed.update } : {}),
        publicAccess: refreshed.publicAccess,
      });
    }
    return [
      { kind: "created", tree: SYSTEM_TREE, path: `/trees/${remote.id}` },
      { kind: "created", tree: remote.id, path: "/" },
    ];
  }

  private async createGroupProfile(
    handle: string,
    inputPath: string,
    displayName?: string,
  ): Promise<MutationReceipt["effects"]> {
    const requested = resolveUserPath(inputPath);
    await mkdir(requested, { recursive: true });
    const path = await realpath(requested);
    const index = join(path, "_index.md");
    const exists = await stat(index).then(() => true).catch(() => false);
    if (!exists) {
      await writeFile(index, `---\ntype: group\nmembers: []\n---\n\n# ${displayName?.trim() || handle}\n`);
    } else if (!/^type:\s*group\s*$/m.test(await readFile(index, "utf8"))) {
      throw new ProtocolError("invalid-reference", "Group profile _index.md must declare type: group", 409, { path });
    }
    return this.promoteTree(path, `/~${handle}`, { kind: "everyone", access: "read" }, "group-profile");
  }

  private async placeTree(
    tree: string,
    inputPath: string,
    endpoint?: string,
    canonical?: string,
  ): Promise<MutationReceipt["effects"]> {
    const requested = resolveUserPath(inputPath);
    const destination = await realpath(requested).catch(async () =>
      join(await realpath(join(requested, "..")), basename(requested))
    );
    const existing = this.trees.placementFor(tree);
    if (existing && existing.source !== "local" && existing.path === destination) return [];

    const owner = await this.communityConfig.get();
    const configured = endpoint ? null : await this.configuredWire();
    const origin = endpoint ? new URL(endpoint).origin : configured!.origin;
    const client = endpoint
      ? new WireClient(origin, owner?.record.origin === origin ? owner.accountToken : undefined)
      : configured!.client;
    const remote = endpoint
      ? await client.ref(tree).catch(() => null)
      : (await client.list()).find((item) => item.id === tree);
    if (!remote) throw new ProtocolError("not-found", `Tree is not available from the community: ${tree}`, 404);
    if (canonical && canonical !== remote.arborURL && canonical !== remote.httpURL) {
      throw new ProtocolError("invalid-reference", `Canonical URL does not resolve to ${tree}`, 409);
    }
    await mkdir(destination, { recursive: true });
    if ((await readdir(destination)).length) {
      throw new ProtocolError("occupied-destination", `Placement directory is not empty: ${destination}`, 409, { path: destination });
    }
    await materializeTree(destination, remote.ref, (hash) => client.object(hash));
    const path = await realpath(destination);
    await this.trees.applySharedPlacement({
      path,
      source: `arbor://tree/${remote.id}/` as const,
      tree: remote.id,
      canonical: remote.arborURL,
      endpoint: origin,
      ref: remote.ref,
      ...(remote.update ? { update: remote.update } : {}),
      access: remote.access,
      publicAccess: remote.publicAccess,
    });
    return [{ kind: "created", tree: remote.id, path: "/" }];
  }

  private async setTreeAccess(
    tree: string,
    subject:
      | { kind: "all" }
      | { kind: "everyone" }
      | { kind: "profile"; locator: string }
      | { kind: "link"; secret: string }
      | { kind: "entry"; id: string },
    access: "none" | "read" | "write",
  ): Promise<MutationReceipt["effects"]> {
    const placement = this.trees.placementFor(tree);
    if (!placement || placement.source === "local") throw new ProtocolError("not-found", `Unknown shared tree: ${tree}`, 404);
    const { client } = await this.configuredWire();
    const remote = subject.kind === "all"
      ? await client.clearAccess(tree)
      : subject.kind === "entry"
      ? await client.revokeAccess(tree, subject.id)
      : await client.setAccess(
          tree,
          subject.kind === "link"
            ? { kind: "link", digest: `sha256:${sha256(subject.secret)}` }
            : subject,
          access,
        );
    await this.trees.applySharedPlacement({ ...placement, publicAccess: remote.publicAccess, ref: remote.ref });
    return [{ kind: "updated", tree: SYSTEM_TREE, path: `/trees/${tree}` }];
  }

  private async removeTreePlacement(
    path: string,
    endpoint?: string,
    canonicalPath?: string,
  ): Promise<MutationReceipt["effects"]> {
    const placement = this.trees.sharedPlacements().find((candidate) => candidate.path === path);
    if (!placement) throw new ProtocolError("not-found", `No shared tree placement at ${path}`, 404);
    if (
      endpoint !== undefined
      && canonicalPath !== undefined
      && (placement.endpoint !== endpoint || new URL(placement.canonical).pathname.replace(/\/$/, "") !== canonicalPath.replace(/\/$/, ""))
    ) {
      throw new ProtocolError("invalid-reference", `${path} is not synced with ${endpoint}${canonicalPath}`, 409);
    }
    await this.trees.removeSharedPlacement(path);
    return [{ kind: "deleted", tree: SYSTEM_TREE, path: `/trees/${placement.tree}` }];
  }

  private async resolveTreeConflict(
    tree: string,
    choice: "local" | "draft" | "remote",
  ): Promise<MutationReceipt["effects"]> {
    const conflict = await treeConflict(tree);
    if (!conflict) throw new ProtocolError("not-found", `Tree has no stored synchronization conflict: ${tree}`, 404);
    const placement = this.trees.placementFor(tree);
    const workspace = await this.trees.workspaceByTree(tree);
    if (!placement || placement.source === "local" || !workspace) {
      throw new ProtocolError("not-found", `Shared tree placement is unavailable: ${tree}`, 404);
    }
    const configured = await this.communityConfig.get();
    const client = new WireClient(
      placement.endpoint,
      configured?.record.origin === placement.endpoint ? configured.accountToken : undefined,
    );
    if (choice === "remote") {
      const remote = await client.ref(tree);
      if (!remote.update) throw new Error("Authority does not advertise accepted updates for this tree");
      await materializeTree(
        workspace.root,
        remote.ref,
        (hash) => client.object(hash),
        undefined,
        this.trees.excludedMountsWithin(workspace.root),
      );
      await this.trees.applySharedPlacement({
        ...placement,
        ref: remote.ref,
        update: remote.update,
        publicAccess: remote.publicAccess,
        access: remote.access,
      });
      const acceptedLocal = await this.snapshotWorkspace(workspace, client);
      if (acceptedLocal.root !== remote.ref) throw new Error("Materialized remote tree does not match its authority root");
      await saveAcceptedTreeObjects(tree, acceptedLocal);
      await clearPendingTreeUpdate(tree);
      await clearTreeConflict(tree);
      this.trees.setSyncState(tree, "idle");
      this.syncConflicts.delete(tree);
      return [{ kind: "updated", tree: SYSTEM_TREE, path: `/trees/${tree}` }];
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
    await this.updateWorkspace(workspace, placement, client, await client.list());
    return [{ kind: "updated", tree: SYSTEM_TREE, path: `/trees/${tree}` }];
  }

  private canonicalBoundariesFor(
    workspace: Workspace,
    remoteTrees: readonly RemoteTreeDescriptor[],
  ): Map<string, string> {
    const boundaries = this.trees.sharedBoundariesWithin(workspace.root);
    const parent = remoteTrees.find((tree) => tree.id === workspace.tree);
    if (!parent) return boundaries;
    const parentPath = parent.canonicalPath.replace(/\/$/, "") || "/";
    for (const child of remoteTrees) {
      if (child.parentTree !== workspace.tree) continue;
      const relativeCanonical = parentPath === "/"
        ? child.canonicalPath.slice(1)
        : child.canonicalPath.slice(parentPath.length + 1);
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
    const listed = remoteTrees ?? await client.list();
    return snapshotDirectory(
      workspace.root,
      this.canonicalBoundariesFor(workspace, listed),
      this.trees.excludedMountsWithin(workspace.root),
    );
  }

  /** Freeze the just-admitted candidate locally; authority I/O remains background work. */
  private async freezeImmediateUpdate(workspace: Workspace, admission: ConfirmedSourcePatch): Promise<void> {
    const placement = this.trees.placementFor(workspace.tree);
    if (!placement || placement.source === "local" || placement.access !== "write" || !placement.update) return;
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
    const remote = await client.ref(workspace.tree);
    if (!remote.update) throw new Error("Authority does not advertise accepted updates for this tree");
    if (
      placement.publicAccess !== remote.publicAccess
      || placement.access !== remote.access
      || (placement.ref === remote.ref && placement.update !== remote.update)
    ) {
      placement = {
        ...placement,
        publicAccess: remote.publicAccess,
        access: remote.access,
        ...(placement.ref === remote.ref ? { update: remote.update } : {}),
      };
      await this.trees.applySharedPlacement(placement);
    }
    if (await treeConflict(workspace.tree)) {
      this.trees.setSyncState(workspace.tree, "conflict");
      this.syncConflicts.add(workspace.tree);
      return;
    }
    let pending = await pendingTreeUpdate(workspace.tree);
    let local = await this.snapshotWorkspace(workspace, client, remoteTrees);
    if (!pending && local.root === remote.ref) {
      await this.trees.applySharedPlacement({ ...placement, ref: remote.ref, update: remote.update });
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
      if (!placement.update) throw new Error("Shared placement has no accepted-update base");
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
          const retained = await acceptedTreeObjects(workspace.tree);
          const retainedHashes = retained?.root === pending.base.root ? new Set(retained.hashes) : new Set<ObjectHash>();
          pending = pendingFromSnapshot(pending.base, local, retainedHashes);
          await savePendingTreeUpdate(workspace.tree, pending);
          continue;
        }
        if (accepted.root !== pending.candidate) {
          if (!result.snapshot) throw new Error("Authority omitted a required accepted snapshot");
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
        await this.trees.applySharedPlacement({
          ...placement,
          ref: accepted.root,
          update: accepted.id,
          publicAccess: remote.publicAccess,
        });
        const acceptedLocal = await this.snapshotWorkspace(workspace, client, remoteTrees);
        if (acceptedLocal.root !== accepted.root) throw new Error("Materialized accepted tree does not match its authority root");
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

  private async syncAll(): Promise<void> {
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncRequested = false;
        const configured = await this.communityConfig.get();
        const remoteTreesByOrigin = new Map<string, Promise<RemoteTreeDescriptor[]>>();
        for (const placement of this.trees.sharedPlacements()) {
          try {
            const client = new WireClient(
              placement.endpoint,
              configured?.record.origin === placement.endpoint ? configured.accountToken : undefined,
            );
            const workspace = await this.trees.workspaceByTree(placement.tree);
            if (!workspace) continue;
            let listed = remoteTreesByOrigin.get(placement.endpoint);
            if (!listed) {
              listed = client.list();
              remoteTreesByOrigin.set(placement.endpoint, listed);
            }
            const remoteTrees = await listed;
            await this.updateWorkspace(workspace, placement, client, remoteTrees);
          } catch (error) {
            this.trees.setSyncState(placement.tree, error instanceof TypeError ? "offline" : "error");
          }
        }
      } while (this.syncRequested);
    } finally {
      this.syncing = false;
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
      if (!("path" in ref)) return;
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
        await rejectReservedMount({ tree: translated.tree, path: translated.path });
        const scope = await this.resolveScope({ tree: translated.tree, path: translated.path });
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
