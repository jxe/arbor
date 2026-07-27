import { homedir } from "node:os";
import type {
  BacklinksPage,
  ChildrenPage,
  CollectionResultPage,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeSnapshot,
  RecoveryPage,
  RootDescriptor,
  RootID,
  RootsPage,
  SearchPage,
  TreeRef,
  WorkspaceOperation,
} from "@arbor/core";
import type { ArbordErrorCode } from "@arbor/core";
import { LOCAL_TREE, SYSTEM_TREE, canonicalNodePath, revisionOf, siblingMarkdownTreePath } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import { FsConflictError } from "@arbor/fs";
import { EventBus } from "./events.ts";
import { FilesystemService, realOsPath } from "./fs-service.ts";
import { RootManager } from "./roots.ts";
import { ProtocolError, RevisionConflictError, Workspace, type WorkspaceOptions } from "./workspace.ts";

export function fsErrorCode(error: FsConflictError): { code: ArbordErrorCode; status: number; retryable?: boolean } {
  switch (error.details.code) {
    case "stale-revision": return { code: "stale-content-revision", status: 409 };
    case "missing-insertion-anchor": return { code: "missing-insertion-anchor", status: 409 };
    case "occupied-destination": return { code: "occupied-destination", status: 409 };
    case "duplicate-body": return { code: "duplicate-body-representation", status: 409 };
    case "unsafe-path":
    case "recursive-move": return { code: "unsafe-path", status: 400 };
    case "not-found": return { code: "not-found", status: 404 };
    case "read-only": return { code: "read-only", status: 422 };
    case "offline": return { code: "not-materialized", status: 409, retryable: true };
    default: return { code: "invalid-reference", status: 400 };
  }
}

type ResolvedScope =
  | { kind: "root"; workspace: Workspace; ref: NodeRef }
  | { kind: "local"; path: string; ref: NodeRef }
  | { kind: "system"; path: string };

/**
 * The daemon's top-level authority: one process-wide event bus, a root
 * manager owning N per-root Workspaces, and a filesystem service for the
 * untracked `local` scope. Requests resolve here by tree scope — with
 * `local` references canonicalized into an owning live root when their
 * real path falls inside one — before dispatch.
 */
export class ArborService implements AsyncDisposable {
  readonly events: EventBus;
  readonly roots: RootManager;
  readonly localFs: FilesystemService;

  private constructor(events: EventBus, roots: RootManager) {
    this.events = events;
    this.roots = roots;
    this.localFs = new FilesystemService(events);
  }

  static async open(
    sessionPath: string,
    options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {},
  ): Promise<ArborService> {
    const events = new EventBus();
    const roots = new RootManager(events);
    await roots.init();
    await roots.openSession(sessionPath, options);
    return new ArborService(events, roots);
  }

  get session(): Workspace {
    return this.roots.session;
  }

  /** Resolve a reference's scope, canonicalizing `local` refs into owning roots. */
  async resolveScope(ref: NodeRef): Promise<ResolvedScope> {
    const tree = ref.tree;
    if (tree === undefined) {
      // A bare pageID fans out across all live roots; a bare path means
      // the session root.
      if ("pageID" in ref) {
        const workspace = await this.pageIDWorkspace(ref.pageID);
        return { kind: "root", workspace, ref };
      }
      return { kind: "root", workspace: this.roots.session, ref };
    }
    const workspace = await this.roots.workspaceByTree(tree);
    if (workspace) return { kind: "root", workspace, ref };
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
      const owner = await this.roots.ownerOf(real);
      if (owner) {
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
        const siblingOwner = realSibling ? await this.roots.ownerOf(realSibling) : null;
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

  async children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") return scope.workspace.children(scope.ref, cursor);
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
    if (scope.kind === "root") return scope.workspace.backlinksPage(scope.ref, cursor);
    throw new ProtocolError(
      "unsupported-operation",
      "Backlinks require a tracked root: track the enclosing folder to enable them",
      422,
    );
  }

  async recoveryPage(ref: NodeRef, recursive = false, cursor?: string | null): Promise<RecoveryPage> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") return scope.workspace.recoveryPage(scope.ref, recursive, cursor);
    throw new ProtocolError(
      "unsupported-operation",
      "Recovery requires a tracked root: track the enclosing folder to enable it",
      422,
    );
  }

  async searchPage(tree: TreeRef | undefined, query: string, cursor?: string | null): Promise<SearchPage> {
    if (tree === undefined) return this.roots.session.searchPage(query, cursor);
    const workspace = await this.roots.workspaceByTree(tree);
    if (workspace) return workspace.searchPage(query, cursor);
    if (tree === LOCAL_TREE || tree === SYSTEM_TREE) {
      throw new ProtocolError(
        "unsupported-operation",
        "Search requires a tracked root: track the enclosing folder to enable it",
        422,
      );
    }
    throw new ProtocolError("not-found", `Unknown tree scope: ${tree}`, 404);
  }

  /**
   * Execute a mutation in its single scope. Every reference is resolved
   * (canonicalizing `local` refs into owning roots) and the batch must land
   * entirely in one scope.
   */
  async executeMutation(request: MutationRequest): Promise<MutationReceipt> {
    const { scopeKey, request: translated } = await this.translateMutation(request);
    if (scopeKey === LOCAL_TREE) return this.localFs.executeMutation(translated);
    if (scopeKey === SYSTEM_TREE) {
      throw new ProtocolError("unsupported-operation", "The system scope is read-only", 422);
    }
    const workspace = (scopeKey === undefined ? undefined : await this.roots.workspaceByTree(scopeKey)) ?? this.roots.session;
    return this.inWorkspace(workspace, async () => {
      const receipt = await workspace.executeMutation(translated);
      await workspace.protocolFault("protocol:response-delivery");
      return receipt;
    });
  }

  async assetV1(mutationID: string, directory: NodeRef, filename: string, bytes: Uint8Array) {
    const scope = await this.resolveScope(directory);
    if (scope.kind !== "root") {
      throw new ProtocolError(
        "unsupported-operation",
        "Assets require a tracked root: track the enclosing folder to enable them",
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
        "Imports require a tracked root: track the enclosing folder to enable them",
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

  /** The tracked-root surface behind `GET/POST/DELETE /v1/roots`. */
  rootsPage(): RootsPage {
    return {
      roots: this.roots.descriptors(),
      home: homedir(),
      diagnostics: this.roots.diagnostics(),
      observedThrough: this.events.currentCursor(),
    };
  }

  async track(path: string): Promise<RootDescriptor> {
    return this.roots.track(path);
  }

  async untrack(id: RootID): Promise<void> {
    await this.roots.untrack(id);
  }

  /** Resolve a bare pageID across all live roots. */
  private async pageIDWorkspace(pageID: string): Promise<Workspace> {
    const owners: Array<{ workspace: Workspace; paths: readonly string[] }> = [];
    for (const workspace of await this.roots.openAll()) {
      const paths = workspace.pageIDOwners(pageID);
      if (paths.length) owners.push({ workspace, paths });
    }
    if (owners.length > 1) {
      throw new ProtocolError("duplicate-page-id", `Page ID ${pageID} has owners in multiple roots`, 409, {
        owners: owners.flatMap((owner) =>
          owner.paths.map((path) => `${owner.workspace.root}${path === "/" ? "" : path}`)
        ),
      });
    }
    return owners[0]?.workspace ?? this.roots.session;
  }

  /** Read-only `system:` pages: `/`, `/roots`, and `/roots/<name>`. */
  private systemSnapshot(path: string): NodeSnapshot {
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
    if (path === "/roots") {
      const listing = this.systemRootChildren();
      const revision = revisionOf(listing.map((entry) => entry.name).join("\n"));
      return {
        ...base,
        ref: { tree: SYSTEM_TREE, path: "/roots" },
        path: "/roots",
        name: "roots",
        kind: "directory",
        contentRevision: revision,
        directoryRevision: revision,
        bodyState: "implicit",
        document: parseMarkdown(""),
        diagnostics: this.roots.diagnostics(),
      };
    }
    const record = this.systemRecordAt(path);
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
      bodyOrigin: "sibling",
      document: parseMarkdown(record.record.source),
      diagnostics: [],
    };
  }

  private systemChildren(path: string): ChildrenPage {
    const observedThrough = this.events.currentCursor();
    if (path === "/") {
      return {
        parent: { tree: SYSTEM_TREE, path: "/" },
        items: [{ name: "roots", path: "/roots", kind: "directory", materialization: "available" }],
        nextCursor: null,
        observedThrough,
      };
    }
    if (path === "/roots") {
      return {
        parent: { tree: SYSTEM_TREE, path: "/roots" },
        items: this.systemRootChildren(),
        nextCursor: null,
        observedThrough,
      };
    }
    throw new ProtocolError("invalid-reference", `system:${path.slice(1)} does not have children`, 400, { path });
  }

  /** Record pages are named by friendly name, falling back to id on collision. */
  private systemRootSegments(): Array<{ segment: string; record: import("@arbor/stores").SystemRootRecord }> {
    const records = this.roots.records();
    const counts = new Map<string, number>();
    for (const record of records) counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
    return records.map((record) => ({
      segment: (counts.get(record.name) ?? 0) > 1 ? record.id : record.name,
      record,
    }));
  }

  private systemRootChildren() {
    return this.systemRootSegments()
      .map(({ segment }) => ({
        name: segment,
        path: `/roots/${segment}`,
        kind: "markdown" as const,
        materialization: "available" as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private systemRecordAt(path: string) {
    const match = /^\/roots\/([^/]+)$/.exec(path);
    if (!match) return null;
    return this.systemRootSegments().find(({ segment, record }) => segment === match[1] || record.id === match[1]) ?? null;
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
    const operations = await Promise.all(request.operations.map(async (operation) => {
      const translated: WorkspaceOperation = { ...operation };
      if ("ref" in translated && translated.ref) translated.ref = await translateRef(translated.ref);
      if ("refs" in translated && Array.isArray(translated.refs)) {
        translated.refs = await Promise.all(translated.refs.map(translateRef));
      }
      if ("destination" in translated && translated.destination) {
        translated.destination = await translateRef(translated.destination);
      }
      if (translated.op === "createMarkdown" || translated.op === "createDirectory") {
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
    await this.roots[Symbol.asyncDispose]();
  }
}
