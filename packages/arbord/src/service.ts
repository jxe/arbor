import { homedir } from "node:os";
import { mkdir, readdir, realpath } from "node:fs/promises";
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
import type { ArbordErrorCode } from "@arbor/core";
import { LOCAL_TREE, SYSTEM_TREE, canonicalJSONString, canonicalNodePath, revisionOf, sha256, siblingMarkdownTreePath } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import { FsConflictError, MutationJournal } from "@arbor/fs";
import { ServerConfigStore, arborDataRoot } from "@arbor/stores";
import { WireClient, materializeTree, snapshotDirectory, type RemoteTreeDescriptor } from "@arbor/wire";
import { EventBus } from "./events.ts";
import { FilesystemService, realOsPath } from "./fs-service.ts";
import { TreeManager } from "./tree-manager.ts";
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
  readonly trees: TreeManager;
  readonly localFs: FilesystemService;
  readonly serverConfig = new ServerConfigStore();
  private systemMutations = new MutationJournal(join(arborDataRoot(), "system", "journal", "mutations"));
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncing = false;
  private syncConflicts = new Set<string>();

  private constructor(events: EventBus, trees: TreeManager) {
    this.events = events;
    this.trees = trees;
    this.localFs = new FilesystemService(events);
    this.syncTimer = setInterval(() => { void this.syncAll(); }, 2_000);
    this.syncTimer.unref?.();
    setTimeout(() => { void this.syncAll(); }, 0);
  }

  static async open(
    sessionPath: string,
    options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {},
  ): Promise<ArborService> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    await trees.openSession(sessionPath, options);
    return new ArborService(events, trees);
  }

  get session(): Workspace {
    return this.trees.session;
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
      return { kind: "root", workspace: this.trees.session, ref };
    }
    const workspace = await this.trees.workspaceByTree(tree);
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
      const owner = await this.trees.ownerOf(real);
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
      "Backlinks require a shared tree: give the enclosing subtree a URL to enable them",
      422,
    );
  }

  async recoveryPage(ref: NodeRef, recursive = false, cursor?: string | null): Promise<RecoveryPage> {
    const scope = await this.resolveScope(ref);
    if (scope.kind === "root") return scope.workspace.recoveryPage(scope.ref, recursive, cursor);
    throw new ProtocolError(
      "unsupported-operation",
      "Recovery requires a shared tree: give the enclosing subtree a URL to enable it",
      422,
    );
  }

  async searchPage(tree: TreeRef | undefined, query: string, cursor?: string | null): Promise<SearchPage> {
    if (tree === undefined) return this.trees.session.searchPage(query, cursor);
    const workspace = await this.trees.workspaceByTree(tree);
    if (workspace) return workspace.searchPage(query, cursor);
    if (tree === LOCAL_TREE || tree === SYSTEM_TREE) {
      throw new ProtocolError(
        "unsupported-operation",
        "Search requires a shared tree: give the enclosing subtree a URL to enable it",
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
    const workspace = (scopeKey === undefined ? undefined : await this.trees.workspaceByTree(scopeKey)) ?? this.trees.session;
    return this.inWorkspace(workspace, async () => {
      const receipt = await workspace.executeMutation(translated);
      await this.pushWorkspace(workspace).catch((error) => {
        this.events.emit({
          tree: workspace.tree,
          kind: "diagnostic",
          path: "/",
          origin: "sync",
        });
        console.error(`Arbor sync push failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      await workspace.protocolFault("protocol:response-delivery");
      return receipt;
    });
  }

  async assetV1(mutationID: string, directory: NodeRef, filename: string, bytes: Uint8Array) {
    const scope = await this.resolveScope(directory);
    if (scope.kind !== "root") {
      throw new ProtocolError(
        "unsupported-operation",
        "Assets require a shared tree: give the enclosing subtree a URL to enable them",
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
        "Imports require a shared tree: give the enclosing subtree a URL to enable them",
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
    return owners[0]?.workspace ?? this.trees.session;
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
    if (path === "/trees") {
      const listing = await this.systemTreeChildren();
      const revision = revisionOf(listing.map((entry) => entry.name).join("\n"));
      return {
        ...base,
        ref: { tree: SYSTEM_TREE, path: "/trees" },
        path: "/trees",
        name: "trees",
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
          { name: "server", path: "/server", kind: "markdown", materialization: "available" },
          { name: "trees", path: "/trees", kind: "directory", materialization: "available" },
          { name: "credentials", path: "/credentials", kind: "markdown", materialization: "available" },
          { name: "visited", path: "/visited", kind: "markdown", materialization: "available" },
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
    throw new ProtocolError("invalid-reference", `system:${path.slice(1)} does not have children`, 400, { path });
  }

  private async systemTreeSegments() {
    const local = await this.trees.descriptors();
    const configured = await this.serverConfig.get();
    let remote: RemoteTreeDescriptor[] = [];
    if (configured) {
      remote = await new WireClient(configured.record.origin, configured.ownerToken).list().catch(() => []);
    }
    const byID = new Map<string, TreeDescriptor>(local.map((tree) => [tree.id, tree]));
    for (const tree of remote) {
      const current = byID.get(tree.id);
      byID.set(tree.id, {
        id: tree.id,
        name: current?.name ?? tree.slug,
        osPath: current?.osPath,
        canonical: tree.arborURL,
        httpURL: tree.httpURL,
        endpoint: configured?.record.origin,
        publication: tree.publication,
        access: current?.access,
        placement: current ? "shared" : "remote",
        sync: current?.sync,
      });
    }
    return [...byID.values()].map((tree) => ({
      segment: tree.id,
      tree,
      source: this.treeRecordSource(tree),
    }));
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

  private treeRecordSource(tree: TreeDescriptor): string {
    return [
      "---",
      `id: ${tree.id}`,
      `name: ${JSON.stringify(tree.name)}`,
      `placement: ${tree.placement}`,
      ...(tree.osPath ? [`path: ${JSON.stringify(tree.osPath)}`] : []),
      ...(tree.canonical ? [`canonical: ${JSON.stringify(tree.canonical)}`] : []),
      ...(tree.httpURL ? [`http: ${JSON.stringify(tree.httpURL)}`] : []),
      ...(tree.endpoint ? [`endpoint: ${JSON.stringify(tree.endpoint)}`] : []),
      ...(tree.publication ? [`publication: ${tree.publication}`] : []),
      ...(tree.access ? [`access: ${tree.access}`] : []),
      ...(tree.sync ? [`sync: ${tree.sync}`] : []),
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
    if (path === "/server") {
      const record = await this.serverConfig.safe();
      return {
        segment: "server",
        record: {
          source: record
            ? `---\norigin: ${JSON.stringify(record.origin)}\ncredential: ${JSON.stringify(record.credential)}\nconfigured: true\n---\n\n# Personal server\n`
            : "---\nconfigured: false\n---\n\n# Personal server\n",
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
      const configured = await this.serverConfig.safe();
      return {
        segment: "credentials",
        record: {
          source: configured
            ? `---\npersonalServer: configured\ncredential: ${JSON.stringify(configured.credential)}\n---\n\n# Credentials\n\nSecrets are held by the operating system.\n`
            : "---\npersonalServer: missing\n---\n\n# Credentials\n",
        },
      };
    }
    if (path === "/visited") {
      return {
        segment: "visited",
        record: { source: "---\ncount: 0\n---\n\n# Visited trees\n" },
      };
    }
    const match = /^\/trees\/([^/]+)$/.exec(path);
    if (!match) return null;
    const found = (await this.systemTreeSegments()).find(({ segment }) => segment === match[1]);
    return found ? { segment: found.segment, record: { source: found.source } } : null;
  }

  private isSystemMutation(operations: readonly WorkspaceOperation[]): operations is [SystemOperation] {
    return operations.length === 1 && ["configureServer", "promoteTree", "placeTree", "setTreePublication"].includes(operations[0]!.op);
  }

  private safeSystemOperation(operation: SystemOperation): SystemOperation | Record<string, unknown> {
    return operation.op === "configureServer"
      ? { ...operation, ownerToken: `[sha256:${sha256(operation.ownerToken)}]` }
      : operation;
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
    if (operation.op === "configureServer") {
      await this.serverConfig.set(operation.origin, operation.ownerToken);
      effects = [{ kind: "updated", tree: SYSTEM_TREE, path: "/server" }];
    } else if (operation.op === "promoteTree") {
      effects = await this.promoteTree(operation.path, operation.slug);
    } else if (operation.op === "placeTree") {
      effects = await this.placeTree(operation.tree, operation.path, operation.endpoint, operation.canonical);
    } else {
      effects = await this.setTreePublication(operation.tree, operation.publication);
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
    const configured = await this.serverConfig.get();
    if (!configured) throw new ProtocolError("not-found", "Configure the personal Arbor server first", 409, { path: "system:server" });
    return {
      client: new WireClient(configured.record.origin, configured.ownerToken),
      origin: configured.record.origin,
    };
  }

  private async promoteTree(inputPath: string, slug: string): Promise<MutationReceipt["effects"]> {
    const path = await realpath(inputPath);
    const { client, origin } = await this.configuredWire();
    const snapshot = await snapshotDirectory(path, this.trees.sharedBoundariesWithin(path));
    const remote = await client.create(slug, snapshot);
    await this.trees.applySharedPlacement({
      path,
      source: `arbor://tree/${remote.id}/` as const,
      tree: remote.id,
      canonical: remote.arborURL,
      endpoint: origin,
      ref: remote.ref,
      access: "write",
      publication: remote.publication,
    });
    return [
      { kind: "created", tree: SYSTEM_TREE, path: `/trees/${remote.id}` },
      { kind: "created", tree: remote.id, path: "/" },
    ];
  }

  private async placeTree(
    tree: string,
    inputPath: string,
    endpoint?: string,
    canonical?: string,
  ): Promise<MutationReceipt["effects"]> {
    const requested = resolve(inputPath);
    const destination = await realpath(requested).catch(async () =>
      join(await realpath(join(requested, "..")), basename(requested))
    );
    const existing = this.trees.placementFor(tree);
    if (existing && existing.source !== "local" && existing.path === destination) return [];

    const owner = await this.serverConfig.get();
    const configured = endpoint ? null : await this.configuredWire();
    const origin = endpoint ? new URL(endpoint).origin : configured!.origin;
    const client = endpoint
      ? new WireClient(origin, owner?.record.origin === origin ? owner.ownerToken : undefined)
      : configured!.client;
    const remote = endpoint
      ? await client.ref(tree).catch(() => null)
      : (await client.list()).find((item) => item.id === tree);
    if (!remote) throw new ProtocolError("not-found", `Tree is not available from the personal server: ${tree}`, 404);
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
      access: owner?.record.origin === origin || remote.publication === "public-write" ? "write" : "read",
      publication: remote.publication,
    });
    return [{ kind: "created", tree: remote.id, path: "/" }];
  }

  private async setTreePublication(tree: string, publication: import("@arbor/core").PublicationMode): Promise<MutationReceipt["effects"]> {
    const placement = this.trees.placementFor(tree);
    if (!placement || placement.source === "local") throw new ProtocolError("not-found", `Unknown shared tree: ${tree}`, 404);
    const { client } = await this.configuredWire();
    const remote = await client.setPublication(tree, publication);
    await this.trees.applySharedPlacement({ ...placement, publication: remote.publication, ref: remote.ref });
    return [{ kind: "updated", tree: SYSTEM_TREE, path: `/trees/${tree}` }];
  }

  private async pushWorkspace(workspace: Workspace): Promise<void> {
    const placement = this.trees.placementFor(workspace.tree);
    if (!placement || placement.source === "local") return;
    if (placement.access !== "write") return;
    const configured = await this.serverConfig.get();
    const client = new WireClient(
      placement.endpoint,
      configured?.record.origin === placement.endpoint ? configured.ownerToken : undefined,
    );
    this.trees.setSyncState(workspace.tree, "pushing");
    const snapshot = await snapshotDirectory(workspace.root, this.trees.sharedBoundariesWithin(workspace.root));
    if (snapshot.root === placement.ref) {
      this.trees.setSyncState(workspace.tree, "idle");
      return;
    }
    try {
      const remote = await client.push(workspace.tree, placement.ref, snapshot);
      await this.trees.applySharedPlacement({ ...placement, ref: remote.ref, publication: remote.publication });
      this.trees.setSyncState(workspace.tree, "idle");
      this.syncConflicts.delete(workspace.tree);
    } catch (error) {
      this.trees.setSyncState(workspace.tree, error instanceof TypeError ? "offline" : "conflict");
      throw error;
    }
  }

  private async syncAll(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const configured = await this.serverConfig.get();
      for (const placement of this.trees.sharedPlacements()) {
        try {
          const client = new WireClient(
            placement.endpoint,
            configured?.record.origin === placement.endpoint ? configured.ownerToken : undefined,
          );
          const workspace = await this.trees.workspaceByTree(placement.tree);
          if (!workspace) continue;
          const remote = await client.ref(placement.tree);
          const effectiveAccess = configured?.record.origin === placement.endpoint || remote.publication === "public-write"
            ? "write"
            : "read";
          let activePlacement = placement;
          if (placement.publication !== remote.publication || placement.access !== effectiveAccess) {
            activePlacement = {
              ...placement,
              publication: remote.publication,
              access: effectiveAccess,
            };
            await this.trees.applySharedPlacement(activePlacement);
          }
          const local = await snapshotDirectory(workspace.root, this.trees.sharedBoundariesWithin(workspace.root));
          if (remote.ref === activePlacement.ref) {
            if (local.root !== activePlacement.ref && activePlacement.access === "write") await this.pushWorkspace(workspace);
            else if (local.root !== activePlacement.ref) this.trees.setSyncState(activePlacement.tree, "conflict");
            else this.trees.setSyncState(activePlacement.tree, "idle");
            continue;
          }
          if (local.root !== activePlacement.ref) {
            this.trees.setSyncState(activePlacement.tree, "conflict");
            if (!this.syncConflicts.has(activePlacement.tree)) {
              this.syncConflicts.add(activePlacement.tree);
              this.events.emit({ tree: activePlacement.tree, kind: "diagnostic", path: "/", origin: "sync" });
            }
            continue;
          }
          this.trees.setSyncState(activePlacement.tree, "pulling");
          await materializeTree(workspace.root, remote.ref, (hash) => client.object(hash));
          await this.trees.applySharedPlacement({ ...activePlacement, ref: remote.ref });
          this.trees.setSyncState(activePlacement.tree, "idle");
          this.syncConflicts.delete(activePlacement.tree);
        } catch (error) {
          this.trees.setSyncState(placement.tree, error instanceof TypeError ? "offline" : "error");
        }
      }
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
    if (this.syncTimer) clearInterval(this.syncTimer);
    await this.trees[Symbol.asyncDispose]();
  }
}
