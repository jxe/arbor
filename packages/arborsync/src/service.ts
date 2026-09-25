import { localSyncConnections, type SyncConnections } from "./sync-connections.ts";
import { FolderSync, folderStateRoot, pendingBytes, type DeclinedReport } from "./folder-sync.ts";
import type { TrackedRoot } from "./filesystem-object-source.ts";
import { ChangeLog } from "@overstory/working-tree/node";
import { LocalFileService } from "./local-files.ts";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type {
  Hash,
  LocalTreeDescriptor,
  LocatorResolution,
  SnapshotEnvelope,
  UpdateRequestJSON,
} from "@overstory/protocol";
import { canonicalNodePath, ProtocolClient, hashObject, decodeProtocolDirectory, encodeSparseSnapshotBundle, verifyTreeSnapshotGraph, type ObjectHash, type RemoteTreeDescriptor } from "@overstory/protocol";
import { loadIgnorePolicy, membershipSkip, resolveSnapshot, snapshotDirectory, trackedEntries, type SkipPath } from "@overstory/fs";
import { loadLocalPlacements, replaceLocalPlacement, type LocalPlacement, type SharedTreePlacement } from "./state/index.ts";
import { resolveUserPath, retireEarlierSyncState } from "@overstory/client";
import { EventBus } from "./events.ts";
import { TreeObjectCache } from "./object-cache.ts";
import { TreeManager } from "./tree-manager.ts";
import { ProtocolError, Workspace, type WorkspaceOptions } from "./workspace.ts";

export { resolveUserPath } from "@overstory/client";

/** `GET /v1/pending`: the request a placed folder would publish next, and the accepted base it names. */
export interface PendingUpdate {
  tree: string;
  paused: boolean;
  base: { root: string; update: string } | null;
  request: UpdateRequestJSON | null;
}

/** What a loopback client needs to open a placed tree as its own working tree. */
export type BootstrapTreeDescriptor = Pick<
  LocalTreeDescriptor,
  "id" | "configurationTree" | "kind" | "access" | "canonical" | "name" | "osPath" | "placement"
>;

export interface TreeBootstrap {
  /** Placement and routing metadata only; daemon synchronization state is deliberately excluded. */
  tree: BootstrapTreeDescriptor;
  /** The daemon's accepted base; `cursor` is the protocol watch cursor, which is independent of the accepted update id. */
  accepted: { root: Hash; update: string; cursor: string | null };
  /** Base64 of a sparse CBOR snapshot bundle: every directory object and every Markdown file object. */
  spine: string;
  observedThrough: string;
}

export interface ArborSyncDaemonOptions {
  connections?: SyncConnections;
  autoSync?: boolean;
  /**
   * The update machine's poll interval: a freshness check for a clean tree
   * and a retry for a transport failure. Live protocol watches and folder scans
   * drive synchronization; polling only covers a disconnected watch.
   */
  syncIntervalMs?: number;
}

const DEFAULT_SYNC_INTERVAL_MS = 30_000;

/** A tree that an explicit synchronization could not bring current: offline, stopped, or without credentials. */
class UnsynchronizedTreeError extends ProtocolError {
  constructor(tree: string, detail?: string) {
    super("unavailable", detail ?? `Tree could not synchronize: ${tree}`, 503, { tree });
  }
}
const WIRE_SYNC_TIMEOUT_MS = 60_000;

async function sparseSpine(
  snapshotRoot: ObjectHash,
  readObject: (hash: ObjectHash) => Promise<Uint8Array | undefined>,
): Promise<string> {
  const spine = new Map<ObjectHash, Uint8Array>();
  const visit = async (hash: ObjectHash): Promise<void> => {
    const bytes = spine.get(hash) ?? await readObject(hash);
    if (!bytes) throw new Error(`Accepted snapshot is missing object ${hash}`);
    if (hashObject(bytes) !== hash) throw new Error(`Accepted snapshot object does not match ${hash}`);
    spine.set(hash, bytes);
    for (const entry of decodeProtocolDirectory(bytes).entries) {
      if (entry.directory) await visit(entry.directory);
      else if (entry.file && entry.name.toLowerCase().endsWith(".md")) {
        const child = spine.get(entry.file) ?? await readObject(entry.file);
        if (!child) throw new Error(`Accepted snapshot is missing Markdown ${entry.file}`);
        if (hashObject(child) !== entry.file) throw new Error(`Accepted Markdown does not match ${entry.file}`);
        spine.set(entry.file, child);
      }
    }
  };
  await visit(snapshotRoot);
  verifyTreeSnapshotGraph({ root: snapshotRoot, objects: spine }, "sparse-files");
  return Buffer.from(encodeSparseSnapshotBundle(spine)).toString("base64");
}

/**
 * The daemon's top-level coordinator: one process-wide event bus, a root
 * manager owning N per-root Workspaces, one `FolderSync` per placed tree (the
 * update machine's runner with the folder as its source and accepted tree),
 * and the loopback services a working-tree client uses (bootstrap,
 * credential, objects). Editors run the same machine against their own
 * working tree.
 */
export class ArborSyncDaemon implements AsyncDisposable {
  readonly events: EventBus;
  readonly trees: TreeManager;
  private readonly connections: SyncConnections;
  private syncStartupTimer?: ReturnType<typeof setTimeout>;
  private syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
  private autoSync = false;
  private placementMoving = false;
  private placementMoveWaiters: Array<() => void> = [];
  private syncing = false;
  private syncRequested = false;
  private syncWaiters: Array<() => void> = [];
  private workspaceIOTails = new Map<string, Promise<void>>();
  private readonly folders = new Map<string, { root: string; sync: FolderSync }>();
  /** Each folder's subscription to changes at paths its ignore rules keep out. */
  private readonly ignoredChanges = new Map<string, () => void>();
  /** The last tree listing per account, for nested canonical boundaries. */
  private readonly listings = new Map<string, RemoteTreeDescriptor[]>();
  private readonly unsubscribeEvents: () => void;
  private readonly files: LocalFileService;
  private readonly objectCache: TreeObjectCache;

  private constructor(events: EventBus, trees: TreeManager, options: ArborSyncDaemonOptions = {}) {
    this.connections = options.connections ?? localSyncConnections();
    this.files = new LocalFileService(trees);
    this.events = events;
    this.trees = trees;
    // A folder edit schedules that folder's scan; the scan decides whether it is a change.
    this.unsubscribeEvents = events.subscribe((event) => {
      if (event.kind === "diagnostic" || event.change.origin === "sync") return;
      this.folders.get(event.tree)?.sync.scheduleScan();
    });
    this.objectCache = new TreeObjectCache({
      pendingBytes: (tree, hash) => pendingBytes(this.folders.get(tree)?.sync.log ?? new ChangeLog(tree, folderStateRoot(tree)), hash),
      workspaceFor: (tree) => trees.workspaceByTree(tree),
      boundariesFor: (workspace) => trees.sharedBoundariesWithin(workspace.root),
      exclusionsFor: (workspace) => trees.excludedMountsWithin(workspace.root),
      clientFor: async (tree, origin) => {
        const placement = trees.placementFor(tree);
        if (placement) return this.accountClient(placement);
        return origin ? new ProtocolClient(origin, undefined, { timeoutMs: WIRE_SYNC_TIMEOUT_MS }) : undefined;
      },
    });
    if (options.autoSync !== false) this.startAutoSync(options.syncIntervalMs);
  }

  /** Verified object bytes for a tree from the index, its pending changes, or Canopy. */
  objectBytes(tree: string, hash: ObjectHash, origin?: string): Promise<Uint8Array | undefined> {
    return this.objectCache.bytes(tree, hash, origin);
  }

  /**
   * Bootstrap the daemon's recorded accepted Canopy root. The folder's own
   * changes and held work belong only to the folder's client and never gate
   * or seed another client.
   */
  async bootstrapTree(tree: string): Promise<TreeBootstrap> {
    const placement = this.trees.placementFor(tree);
    const workspace = placement ? await this.trees.workspaceByTree(tree) : undefined;
    if (!placement || !workspace) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });
    if (!placement.ref || !placement.update) {
      throw new ProtocolError("conflict", `Tree has not synchronized an accepted base yet: ${tree}`, 409, { tree, details: { kind: "unsynchronized" } });
    }
    const descriptor = (await this.trees.descriptors()).find((item) => item.id === tree);
    if (!descriptor) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });

    const spine = await sparseSpine(
      placement.ref as ObjectHash,
      (hash) => this.objectCache.bytes(tree, hash),
    );
    const bootstrapDescriptor: BootstrapTreeDescriptor = {
      id: descriptor.id,
      ...(descriptor.configurationTree ? { configurationTree: descriptor.configurationTree } : {}),
      kind: descriptor.kind,
      access: descriptor.access,
      canonical: descriptor.canonical ?? null,
      name: descriptor.name,
      ...(descriptor.osPath ? { osPath: descriptor.osPath } : {}),
      placement: descriptor.placement,
    };
    return {
      tree: bootstrapDescriptor,
      accepted: { root: placement.ref as Hash, update: placement.update, cursor: placement.cursor ?? null },
      spine,
      observedThrough: this.events.currentCursor(),
    };
  }

  /** Start every placed folder once; from then on its machine polls, and watches and scans drive it. */
  private startAutoSync(syncIntervalMs?: number): void {
    if (this.autoSync) return;
    this.autoSync = true;
    this.syncIntervalMs = syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.syncStartupTimer = setTimeout(() => {
      this.syncStartupTimer = undefined;
      void this.syncAll();
    }, 0);
  }

  /**
   * The multiplexer: every Canopy pass-through picks the claimed account
   * whose address contains the target and forwards with that credential.
   */
  private async accountClient(placement: SharedTreePlacement): Promise<ProtocolClient> {
    return (await this.connections.accountClientFor({ configurationTree: placement.configurationTree, origin: placement.endpoint })).client;
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

  /**
   * Resolve an OS-shaped path into its owning workspace, canonicalizing
   * through canonical and reader-local mounts. Null when no live root owns it.
   */
  async treeList(): Promise<SnapshotEnvelope<LocalTreeDescriptor[]>> {
    const descriptors = await this.trees.descriptors();
    return { snapshot: descriptors, observedThrough: this.events.currentCursor() };
  }

  async resolveLocator(locator: string): Promise<LocatorResolution> {
    if (!/^(?:https?|arbor):\/\//.test(locator)) {
      const absolute = resolveUserPath(locator);
      const scope = await this.files.resolveScope(absolute);
      if (!scope) throw new ProtocolError("not-found", `Path is not inside a placed tree: ${absolute}`, 404, { path: absolute });
      const enclosingTree = (await this.trees.descriptors()).find((tree) => tree.id === scope.workspace.tree);
      return { ref: scope.ref, ...(enclosingTree ? { enclosingTree } : {}), historical: false, observedThrough: this.events.currentCursor() };
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
    const resolution = await (await this.connections.accountClientFor({ origin })).client.resolve(path || "/");
    const local = (await this.trees.descriptors()).find((tree) => tree.id === resolution.ref.tree);
    return { ...resolution, ...(local ? { enclosingTree: local } : {}) };
  }

  /** One tree's local write/snapshot/materialization boundary; protocol requests must remain outside. */
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

  /** Flush a valid file-edited configuration and its resulting tree work before a CLI process exits. */
  async synchronizeNow(configurationTree?: string): Promise<void> {
    if (this.placementMoving) await new Promise<void>((resolve) => this.placementMoveWaiters.push(resolve));
    await this.trees.refreshConfiguration();
    if (
      configurationTree
      && !this.trees.sharedPlacements().some((placement) => placement.configurationTree === configurationTree)
    ) throw new ProtocolError("not-found", `Unknown account configuration: ${configurationTree}`, 404);
    await this.syncAll(true, configurationTree);
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

  private folderSync(tree: string): FolderSync {
    const folder = this.folders.get(tree);
    if (!folder) throw new ProtocolError("not-found", `Tree has no synchronizing placement: ${tree}`, 404, { tree });
    return folder.sync;
  }

  /** A placed tree's synchronization as its update machine presents it, with its unsettled local changes. */
  async syncPresentation(tree: string) {
    return this.folderSync(tree).coordinator.presentation();
  }

  /** A placed folder's declined work: the paths the host refused and where they are on disk now. */
  async declinedChanges(tree: string): Promise<DeclinedReport | null> {
    return this.folderSync(tree).declinedReport();
  }

  /** Discard a request held whole and every change authored on it; the folder returns to the accepted state. */
  async discardHeldChanges(tree: string): Promise<void> {
    await this.folderSync(tree).discardHeldChanges();
  }

  /** Put the accepted state back at a folder's declined paths; its other changes are kept. */
  async restoreDeclined(tree: string): Promise<void> {
    await this.folderSync(tree).restoreDeclined();
  }

  /** Publish a folder's declined paths again as the folder holds them now. */
  async resendDeclined(tree: string): Promise<void> {
    await this.folderSync(tree).resendDeclined();
  }

  /** Stop publishing a placed folder's changes until resumed, across restarts. */
  async pauseFolder(tree: string): Promise<{ tree: string; paused: boolean }> {
    const sync = this.folderSync(tree);
    await sync.pause();
    return { tree, paused: sync.isPaused };
  }

  /** Publish a paused folder's changes again, starting with a scan of what it holds. */
  async resumeFolder(tree: string): Promise<{ tree: string; paused: boolean }> {
    const sync = this.folderSync(tree);
    await sync.resume();
    return { tree, paused: sync.isPaused };
  }

  /** Exactly what the folder's next publication would POST, without sending or retaining it. */
  async pendingUpdate(tree: string): Promise<PendingUpdate> {
    const sync = this.folderSync(tree);
    const pending = await sync.preview();
    return { tree, paused: sync.isPaused, base: pending?.base ?? null, request: pending?.request ?? null };
  }

  /** The runner for one placed folder, created on first use and again after the folder moves. */
  private async folderFor(placement: SharedTreePlacement, workspace: Workspace): Promise<FolderSync> {
    const existing = this.folders.get(placement.tree);
    if (existing?.root === workspace.root) return existing.sync;
    await existing?.sync.close();
    // Pending work or conflict material from the earlier synchronizer is refused, never rewritten.
    await retireEarlierSyncState(placement.tree);
    const tree = placement.tree;
    const accountKey = placement.configurationTree ?? `legacy:${placement.endpoint}`;
    const sync = new FolderSync(tree, folderStateRoot(tree), {
      placement: () => this.trees.placementFor(tree),
      client: (current) => this.accountClient(current),
      updateSyncMetadata: (current) => this.trees.updateSyncMetadata(current),
      setSyncState: (state) => this.trees.setSyncState(tree, state),
      setDeclined: (declined) => this.trees.setDeclined(tree, declined),
      withWorkspaceIO: (run) => this.withWorkspaceIO(workspace, run),
      scan: (tracked, also) => this.scanWorkspace(workspace, this.listings.get(accountKey) ?? [], tracked, also),
      root: workspace.root,
      excludedMounts: () => this.trees.excludedMountsWithin(workspace.root),
      objectBytes: (hash) => this.objectCache.bytes(tree, hash),
      materialized: () => this.events.emit({ tree, kind: "updated", ref: { tree, path: "/", stableKey: null }, origin: "sync" }),
    }, { pollIntervalMs: this.syncIntervalMs });
    this.folders.set(tree, { root: workspace.root, sync });
    // The folder's object reads and audits follow the root it last held, and
    // a change at a path a rule keeps out matters only while that root holds it.
    workspace.objects.setTracked(() => sync.trackedRoot());
    this.ignoredChanges.get(tree)?.();
    this.ignoredChanges.set(tree, workspace.fs.subscribeIgnored((path) => { void sync.noteIgnoredChange(path); }));
    return sync;
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

  /**
   * Walk a folder into a lazy graph; index hits read no file bytes until a
   * change needs them. An ignored path is left out unless `tracked` holds it,
   * or when `also` leaves it out.
   */
  private async scanWorkspace(workspace: Workspace, remoteTrees: readonly RemoteTreeDescriptor[], tracked: TrackedRoot | null, also?: SkipPath) {
    const exclusions = this.trees.excludedMountsWithin(workspace.root);
    const policy = await loadIgnorePolicy(workspace.root, { excludedRoots: exclusions });
    const skip = membershipSkip(policy, tracked ? trackedEntries(tracked.root, tracked.load) : null);
    return snapshotDirectory(
      workspace.root,
      this.canonicalBoundariesFor(workspace, remoteTrees),
      exclusions,
      (directory, sourceName) => workspace.describeProtocolCollectionFile(directory, sourceName),
      workspace.objectIndex(),
      also ? async (path, isDirectory) => await skip(path, isDirectory) || await also(path, isDirectory) : skip,
    );
  }

  private async syncAll(throwErrors = false, configurationTree?: string): Promise<void> {
    if (this.placementMoving) {
      this.syncRequested = true;
      if (throwErrors) {
        await new Promise<void>((resolve) => this.placementMoveWaiters.push(resolve));
        await this.syncAll(true, configurationTree);
      }
      return;
    }
    if (this.syncing) {
      this.syncRequested = true;
      await new Promise<void>((resolve) => this.syncWaiters.push(resolve));
      if (throwErrors) await this.syncAll(true, configurationTree);
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncRequested = false;
        const remoteTreesByAccount = new Map<string, Promise<RemoteTreeDescriptor[]>>();
        const placements = this.trees.sharedPlacements()
          .filter((placement) => !configurationTree || placement.configurationTree === configurationTree)
          .sort((left, right) =>
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
            this.listings.set(accountKey, remoteTrees);
            const folder = await this.folderFor(placement, workspace);
            const remote = remoteTrees.find((tree) => tree.id === placement.tree);
            if (!remote) {
              // A reserved tree is activated with the folder's whole content.
              const initial = await this.withWorkspaceIO(
                workspace,
                // Nothing is tracked yet: ignore rules apply to the first snapshot.
                async () => resolveSnapshot(await this.scanWorkspace(workspace, remoteTrees, null)),
              );
              const activated = await client.submitUpdate(placement.tree, null, initial);
              await this.trees.updateSyncMetadata({
                ...placement,
                ref: activated.update.root,
                update: activated.update.id,
                access: "write",
              });
              await folder.placed({ root: activated.update.root, update: activated.update.id });
              this.trees.setSyncState(placement.tree, "idle");
              continue;
            }
            const access = remote.access === "none" ? "read" : remote.access;
            if (placement.access !== access) await this.trees.updateSyncMetadata({ ...placement, access });
            if (!placement.ref || !placement.update) await folder.placeFromHost();
            folder.ensureWatch();
            const presentation = await folder.syncOnce();
            if (throwErrors && (presentation.state === "offline" || presentation.state === "stopped"
                || presentation.state === "authentication-failure" || presentation.state === "revoked")) {
              // The machine already reports this state; only the caller needs the error.
              throw new UnsynchronizedTreeError(placement.tree, presentation.detail);
            }
          } catch (error) {
            if (!(error instanceof UnsynchronizedTreeError)) this.trees.setSyncState(placement.tree, error instanceof TypeError ? "offline" : "error");
            if (throwErrors) throw error;
          }
        }
      } while (this.syncRequested);
    } finally {
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.syncStartupTimer) clearTimeout(this.syncStartupTimer);
    if (this.syncing) await new Promise<void>((resolve) => this.syncWaiters.push(resolve));
    this.unsubscribeEvents();
    for (const unsubscribe of this.ignoredChanges.values()) unsubscribe();
    this.ignoredChanges.clear();
    await Promise.all([...this.folders.values()].map((folder) => folder.sync.close()));
    this.folders.clear();
    await this.trees[Symbol.asyncDispose]();
  }
}
