import { localSyncConnections, type SyncConnections } from "./sync-connections.ts";
import { FolderSync, folderStateRoot, pendingBytes, type DeclinedReport } from "./folder-sync.ts";
import type { TrackedRoot } from "./filesystem-object-source.ts";
import { ChangeLog } from "@ovst/working-tree/node";
import { NodeIndex } from "@ovst/working-tree";
import { LocalFileService } from "./local-files.ts";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type {
  LocalTreeDescriptor,
  LocatorResolution,
  SnapshotEnvelope,
  UpdateRequestJSON,
} from "@ovst/protocol";
import { canonicalHTTPURL, canonicalNodePath, canonicalOverstoryLocator, canonicalURL, storyDataRoot, resolveLogicalURL, treeConfigurationID, ProtocolClient, ProtocolTransportError, protocolObjectReferences, treeHoldsPages, verifyTreeSnapshotGraph, type CurrentTree, type ObjectHash, type TreeSnapshot, type ProtocolObjectKind, type RemoteTreeDescriptor } from "@ovst/protocol";
import { loadIgnorePolicy, membershipSkip, resolveSnapshot, snapshotDirectory, trackedEntries, type SkipPath } from "@ovst/fs";
import { loadLocalPlacements, replaceLocalPlacement, type LocalPlacement } from "@ovst/client";
import { type SharedTreePlacement } from "./state/index.ts";
import { resolveUserPath } from "@ovst/client";
import { EventBus } from "./events.ts";
import { decodeRequestPath } from "./http.ts";
import { TreeObjectCache } from "./object-cache.ts";
import { TreeManager } from "./tree-manager.ts";
import { AgentSessions } from "./agents.ts";
import { AgentRuns } from "./agent-runs.ts";
import { TaskRunner } from "./task-runner.ts";
import { ProtocolError, Workspace, type WorkspaceOptions } from "./workspace.ts";

export { resolveUserPath } from "@ovst/client";

/** `GET /v1/pending`: the request a placed folder would publish next, and the accepted base it names. */
export interface PendingUpdate {
  tree: string;
  paused: boolean;
  base: { root: string; update: string } | null;
  request: UpdateRequestJSON | null;
}

/** What a loopback client needs to open a placed tree as its own working tree. */

export interface StorySyncDaemonOptions {
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

/** One account at one host: the profile's home account, or one of its placement accounts (accounts §1.3). */
function accountKeyOf(placement: SharedTreePlacement): string {
  return `${placement.configurationTree} ${placement.endpoint}`;
}

/** A tree that an explicit synchronization could not bring current: offline, stopped, or without credentials. */
class UnsynchronizedTreeError extends ProtocolError {
  constructor(tree: string, detail?: string) {
    super("unavailable", detail ?? `Tree could not synchronize: ${tree}`, 503, { tree });
  }
}

/**
 * The daemon's top-level coordinator: one process-wide event bus, a root
 * manager owning N per-root Workspaces, one `FolderSync` per placed tree (the
 * update machine's runner with the folder as its source and accepted tree),
 * and the standard Overstory reads a working-tree client uses on loopback
 * (descriptor, snapshot, path read, objects, entry metadata, watch). Editors
 * run the same machine against their own working tree.
 */
export class StorySyncDaemon implements AsyncDisposable {
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
  private readonly nodeIndexes = new Map<string, NodeIndex>();
  /** Agents working in placed folders, shown in their trees' presence. */
  readonly agents: AgentSessions;
  /** Tasks run by the person's own agent in a placed folder. */
  readonly runs: AgentRuns;
  /** This device as a runner of the person's tasks from their other devices; started by `startRunner`. */
  readonly runner: TaskRunner;

  private constructor(events: EventBus, trees: TreeManager, options: StorySyncDaemonOptions = {}) {
    this.connections = options.connections ?? localSyncConnections();
    this.files = new LocalFileService(trees);
    this.events = events;
    this.trees = trees;
    // A folder edit schedules that folder's scan; the scan decides whether it is a change.
    this.unsubscribeEvents = events.subscribe((event) => {
      if (event.kind === "diagnostic" || event.change.origin === "sync") return;
      // A reloaded placement registry (a claim, a pairing, an edited
      // placements.yaml) may add placements no folder machine syncs yet.
      if (event.tree === "system") {
        if (this.autoSync && trees.sharedPlacements().some((placement) => !this.folders.has(placement.tree))) void this.syncAll();
        return;
      }
      this.folders.get(event.tree)?.sync.scheduleScan();
    });
    this.objectCache = new TreeObjectCache({
      pendingBytes: (tree, hash) => pendingBytes(this.folders.get(tree)?.sync.log ?? new ChangeLog(tree, folderStateRoot(tree)), hash),
      workspaceFor: (tree) => trees.workspaceByTree(tree),
      boundariesFor: (workspace) => trees.sharedBoundariesWithin(workspace.root),
      exclusionsFor: (workspace) => trees.excludedMountsWithin(workspace.root),
      clientFor: async (tree) => {
        const placement = trees.placementFor(tree);
        return placement ? this.accountClient(placement) : undefined;
      },
    });
    this.agents = new AgentSessions({
      locate: async (absolutePath) => {
        const scope = await this.files.resolveScope(absolutePath).catch(() => null);
        if (!scope || !trees.placementFor(scope.ref.tree)) return null;
        return { tree: scope.ref.tree, root: scope.workspace.root, path: scope.ref.path };
      },
      presence: async (tree) => {
        const placement = trees.placementFor(tree);
        return placement ? this.accountClient(placement) : undefined;
      },
      hold: (tree, holder) => this.folders.get(tree)?.sync.hold(holder),
      release: async (tree, holder) => { await this.folders.get(tree)?.sync.release(holder); },
    });
    this.runs = new AgentRuns({
      folder: async (tree) => {
        if (!trees.placementFor(tree)) return null;
        const descriptor = (await trees.descriptors()).find((candidate) => candidate.id === tree);
        return descriptor?.placement === "placed" && descriptor.osPath && !descriptor.missing ? descriptor.osPath : null;
      },
      hold: (tree, holder) => this.folders.get(tree)?.sync.hold(holder),
      release: async (tree, holder) => { await this.folders.get(tree)?.sync.release(holder); },
      // Only the run's tree: not behind a full pass, and not failed by another tree.
      publish: async (tree) => {
        const folder = this.folders.get(tree);
        if (folder) await folder.sync.syncOnce();
        else await this.synchronizeNow();
      },
      stateDirectory: join(storyDataRoot(), ".state"),
    }, this.agents);
    this.runner = new TaskRunner({
      trees: async () => (await trees.descriptors())
        .filter((tree) => tree.placement === "placed" && tree.osPath && !tree.missing && trees.placementFor(tree.id))
        .map((tree) => tree.id),
      presence: async (tree) => {
        const placement = trees.placementFor(tree);
        return placement ? this.accountClient(placement) : undefined;
      },
    }, this.runs, { settingsPath: join(storyDataRoot(), ".state", "runner.json") });
    if (options.autoSync !== false) this.startAutoSync(options.syncIntervalMs);
  }

  /** Verified object bytes for a tree from the index, its pending changes, or the host. */
  objectBytes(tree: string, hash: ObjectHash): Promise<Uint8Array | undefined> {
    return this.objectCache.bytes(tree, hash);
  }

  /**
   * The standard current-tree read, answered from the daemon's recorded
   * accepted base (Clients 003): the root and update Story Sync last
   * accepted for the placement, and the host's watch cursor for it. The
   * folder's own changes and held work belong only to the folder's client and
   * never gate or seed another client.
   */
  async acceptedTree(tree: string): Promise<CurrentTree> {
    const placement = this.trees.placementFor(tree);
    if (!placement) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });
    if (!placement.ref || !placement.update || !placement.cursor) {
      throw new ProtocolError("conflict", `Tree has not synchronized an accepted base yet: ${tree}`, 409, { tree, details: { kind: "unsynchronized" } });
    }
    const descriptor = (await this.trees.descriptors()).find((item) => item.id === tree);
    if (!descriptor) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });
    return {
      tree: {
        id: descriptor.id,
        kind: descriptor.kind,
        access: descriptor.access,
        root: placement.ref as RemoteTreeDescriptor["root"],
        update: placement.update,
        conflicted: placement.conflicted === true,
        canonical: descriptor.canonical ?? null,
      },
      observedThrough: placement.cursor,
    };
  }

  /** Objects of a placed tree for the standard read routes; only placed trees are served. */
  private placedObject(tree: string): (hash: ObjectHash) => Promise<Uint8Array> {
    if (!this.trees.placementFor(tree)) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });
    return async (hash) => {
      const bytes = await this.objectCache.bytes(tree, hash);
      if (!bytes) throw new ProtocolError("not-found", `Object is not available: ${hash}`, 404, { tree });
      return bytes;
    };
  }

  /** The standard snapshot read of a placed tree: its complete graph at `root`. */
  async snapshot(tree: string, root: ObjectHash): Promise<TreeSnapshot> {
    const read = this.placedObject(tree);
    const objects = new Map<ObjectHash, Uint8Array>();
    const visit = async (hash: ObjectHash, kind: ProtocolObjectKind): Promise<void> => {
      if (objects.has(hash)) return;
      const bytes = await read(hash);
      objects.set(hash, bytes);
      await Promise.all(protocolObjectReferences(kind, bytes).map((reference) => visit(reference.hash, reference.kind)));
    };
    await visit(root, "directory");
    return verifyTreeSnapshotGraph({ root, objects });
  }

  /**
   * The standard path read of a placed tree (tree operations §1.2.4), from
   * the tree's lazy node index: directories it already decoded are not read
   * again.
   */
  pathRead(tree: string, root: ObjectHash, path: string): Promise<Map<ObjectHash, Uint8Array>> {
    return this.nodeIndex(tree, root).pathRead(path);
  }

  /** A placed tree's node index at `root`, over its object source chain (folder, pending, host). */
  private nodeIndex(tree: string, root: ObjectHash): NodeIndex {
    const read = this.placedObject(tree);
    let index = this.nodeIndexes.get(tree);
    if (!index) {
      index = new NodeIndex(root, { object: read });
      this.nodeIndexes.set(tree, index);
    }
    return index.at(root);
  }

  /** The host's entry metadata for a placed tree, read through its account. */
  async entryMetadata(tree: string): Promise<Awaited<ReturnType<ProtocolClient["entryMetadata"]>>> {
    return (await this.hostClient(tree)).entryMetadata(tree);
  }

  /** The tree's host, through the placement's account: what loopback reads fall through to. */
  async hostClient(tree: string): Promise<ProtocolClient> {
    const placement = this.trees.placementFor(tree);
    if (!placement) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });
    return this.accountClient(placement);
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
   * The multiplexer: every host pass-through picks the claimed account
   * whose address contains the target and forwards with that credential.
   */
  private async accountClient(placement: SharedTreePlacement): Promise<ProtocolClient> {
    return (await this.connections.accountClientFor({ configurationTree: placement.configurationTree, origin: placement.endpoint })).client;
  }

  static async open(
    sessionPath: string,
    options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {},
    daemon: StorySyncDaemonOptions = {},
  ): Promise<StorySyncDaemon> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    await trees.openSession(sessionPath, options);
    const service = new StorySyncDaemon(events, trees, { ...daemon, autoSync: false });
    await trees.refreshConfiguration();
    if (daemon.autoSync !== false) service.startAutoSync(daemon.syncIntervalMs);
    return service;
  }

  /** Open system/account services without attaching Story to a filesystem session. */
  static async openControl(options: StorySyncDaemonOptions = {}): Promise<StorySyncDaemon> {
    const events = new EventBus();
    const trees = new TreeManager(events);
    await trees.init();
    const autoSync = options.autoSync ?? false;
    const service = new StorySyncDaemon(events, trees, { ...options, autoSync: false });
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

  /**
   * The placed tree a canonical URL names, as a run request gives it: at a
   * person's domain or at the host, or a TreeID. Undefined when it is not
   * placed here.
   */
  async treeForURL(url: string): Promise<string | undefined> {
    const descriptors = (await this.trees.descriptors()).filter((tree) => this.trees.placementFor(tree.id));
    if (/^tr_[a-z2-7]+$/.test(url)) return descriptors.find((tree) => tree.id === url)?.id;
    const wanted = url.replace(/\/+$/, "");
    const named = descriptors.find((tree) => tree.canonical && [canonicalURL(tree.canonical), canonicalHTTPURL(tree.canonical), canonicalOverstoryLocator(tree.canonical)]
      .some((candidate) => candidate.replace(/\/+$/, "") === wanted));
    if (named) return named.id;
    const resolved = await this.resolveLocator(url).catch(() => null);
    const tree = resolved?.enclosingTree?.id;
    return tree && resolved?.ref.path === "/" && this.trees.placementFor(tree) ? tree : undefined;
  }

  async resolveLocator(input: string): Promise<LocatorResolution> {
    const locator = input;
    if (!/^(?:https?|overstory):\/\//.test(locator)) {
      const absolute = resolveUserPath(locator);
      const scope = await this.files.resolveScope(absolute);
      if (!scope) throw new ProtocolError("not-found", `Path is not inside a placed tree: ${absolute}`, 404, { path: absolute });
      const enclosingTree = (await this.trees.descriptors()).find((tree) => tree.id === scope.workspace.tree);
      return { ref: scope.ref, ...(enclosingTree ? { enclosingTree } : {}), historical: false, observedThrough: this.events.currentCursor() };
    }
    if (/;overstory-config$/.test(locator)) return this.resolveConfigurationLocator(locator);
    const parsed = new URL(locator);
    const overstoryScheme = parsed.protocol === "overstory:";
    if (overstoryScheme && parsed.hostname === "tree") {
      const [tree, ...segments] = parsed.pathname.split("/").filter(Boolean);
      if (!tree) throw new ProtocolError("invalid-request", "Raw tree locator requires a TreeID", 400);
      const descriptor = (await this.trees.descriptors()).find((candidate) => candidate.id === tree);
      if (!descriptor) throw new ProtocolError("not-found", `Unknown tree scope: ${tree}`, 404);
      return { ref: { tree, path: canonicalNodePath(decodeRequestPath(`/${segments.join("/")}`)), stableKey: null }, enclosingTree: descriptor, historical: false, observedThrough: this.events.currentCursor() };
    }
    const origin = overstoryScheme
      ? `${parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ? "http" : "https"}://${parsed.host}`
      : parsed.origin;
    const path = decodeRequestPath(parsed.pathname);
    const resolution = await (await this.connections.accountClientFor({ origin })).client.resolve(path || "/");
    const local = (await this.trees.descriptors()).find((tree) => tree.id === resolution.ref.tree);
    return { ...resolution, ...(local ? { enclosingTree: local } : {}) };
  }

  /**
   * `…;overstory-config` names the configuration of the tree whose root the rest
   * names: `overstory://<TreeID>;overstory-config` (or `overstory://tree/<TreeID>;overstory-config`)
   * is answered from this device's checkouts, a canonical URL by its host.
   */
  private async resolveConfigurationLocator(locator: string): Promise<LocatorResolution> {
    const web = /^https?:\/\//.exec(locator);
    const resolved = resolveLogicalURL("/", web ? `overstory://${locator.slice(web[0].length)}` : locator);
    if (!resolved || resolved.kind !== "overstory" || !resolved.configuration) {
      throw new ProtocolError("invalid-request", `Invalid configuration locator: ${locator}`, 400);
    }
    const governed = "treeID" in resolved.authority
      ? resolved.authority.treeID
      : resolved.authority.dns === "tree" && /^\/tr_[a-z2-7]+$/.test(resolved.path) ? resolved.path.slice(1) : null;
    if (governed) {
      const configuration = treeConfigurationID(governed);
      const enclosingTree = (await this.trees.descriptors()).find((tree) => tree.id === configuration);
      if (!enclosingTree) throw new ProtocolError("not-found", `This device holds no configuration for ${governed}`, 404);
      return { ref: { tree: configuration, path: "/", stableKey: null }, enclosingTree, historical: false, observedThrough: this.events.currentCursor() };
    }
    if (!("dns" in resolved.authority)) throw new ProtocolError("invalid-request", `Invalid configuration locator: ${locator}`, 400);
    const host = resolved.authority.dns;
    const origin = web
      ? `${web[0]}${host}`
      : `${/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https"}://${host}`;
    const resolution = await (await this.connections.accountClientFor({ origin })).client.resolveConfiguration(resolved.path);
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
    const tree = placement.tree;
    const accountKey = accountKeyOf(placement);
    const sync = new FolderSync(tree, folderStateRoot(tree), {
      placement: () => this.trees.placementFor(tree),
      client: (current) => this.accountClient(current),
      updateSyncMetadata: (current) => this.trees.updateSyncMetadata(current),
      setSyncState: (state) => this.trees.setSyncState(tree, state),
      setDeclined: (declined) => this.trees.setDeclined(tree, declined),
      withWorkspaceIO: (run) => this.withWorkspaceIO(workspace, run),
      scan: (tracked, also, basis) => {
        const listed = this.listings.get(accountKey) ?? [];
        const remote = listed.find((candidate) => candidate.id === tree);
        return this.scanWorkspace(workspace, listed, tracked, also, basis, remote?.pages === true && remote.access === "write");
      },
      root: workspace.root,
      excludedMounts: () => this.trees.excludedMountsWithin(workspace.root),
      refreshListing: async () => {
        const current = this.trees.placementFor(tree);
        if (current) this.listings.set(accountKey, (await (await this.accountClient(current)).list()).snapshot);
      },
      objectBytes: (hash) => this.objectCache.bytes(tree, hash),
      collections: (directory, object, load) => workspace.writeProtocolCollection(directory, object, load),
      materialized: () => this.events.emit({ tree, kind: "updated", ref: { tree, path: "/", stableKey: null }, origin: "sync" }),
      // A 401 ends the session at the host that sent it: the home's, or a placement host's.
      forgetSession: (current) => this.connections.forgetSession(current),
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
    const placed = new Set(this.trees.excludedMountsWithin(workspace.root));
    const parentPath = parent.canonical?.path.replace(/\/$/, "") || "/";
    for (const child of remoteTrees) {
      if (child.canonical?.parentTree !== workspace.tree) continue;
      const relativeCanonical = parentPath === "/"
        ? child.canonical!.path.slice(1)
        : child.canonical!.path.slice(parentPath.length + 1);
      if (!relativeCanonical || relativeCanonical.startsWith("../")) continue;
      // The host's listing is newer than a local placement's last canonical path: a renamed mount is only where the host says.
      for (const [path, tree] of boundaries) if (tree === child.id && !placed.has(path)) boundaries.delete(path);
      boundaries.set(join(workspace.root, ...relativeCanonical.split("/").map(decodeURIComponent)), child.id);
    }
    return boundaries;
  }

  /** Which directories hold a page, by hash, across every folder's scans. */
  private readonly pageDirectories = new Map<ObjectHash, boolean>();

  /**
   * Walk a folder into a lazy graph; index hits read no file bytes until a
   * change needs them. An ignored path is left out unless `tracked` holds it,
   * or when `also` leaves it out. Markdown reads as pages once the root the
   * folder builds on holds one. `convert` (a writer, where the host's
   * descriptor says the tree takes pages) also reads a folder that holds exactly its tracked root as
   * pages: that scan is the tree's one conversion, an ordinary snapshot the
   * host checks changes no page (spec 02 §3). A folder with local edits
   * publishes them first and converts on a later scan.
   */
  private async scanWorkspace(workspace: Workspace, remoteTrees: readonly RemoteTreeDescriptor[], tracked: TrackedRoot | null, also?: SkipPath, collectionBasis?: TrackedRoot, convert = false) {
    const exclusions = this.trees.excludedMountsWithin(workspace.root);
    const policy = await loadIgnorePolicy(workspace.root, { excludedRoots: exclusions });
    const skip = membershipSkip(policy, tracked ? trackedEntries(tracked.root, tracked.load) : null);
    const basis = tracked ?? collectionBasis;
    const scan = (pages: boolean) => {
      workspace.objects.setPageMode(pages);
      return snapshotDirectory(
        workspace.root,
        this.canonicalBoundariesFor(workspace, remoteTrees),
        exclusions,
        (directory, names) => workspace.describeProtocolCollection(directory, names, collectionBasis),
        workspace.objectIndex(),
        also ? async (path, isDirectory) => await skip(path, isDirectory) || await also(path, isDirectory) : skip,
        pages,
      );
    };
    if (basis && await treeHoldsPages(basis.root, basis.load, this.pageDirectories)) return scan(true);
    const legacy = await scan(false);
    return convert && tracked && legacy.root === tracked.root ? scan(true) : legacy;
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
            Number(right.kind === "tree-configuration") - Number(left.kind === "tree-configuration")
          );
        for (const placement of placements) {
          try {
            const client = await this.accountClient(placement);
            const workspace = await this.trees.workspaceByTree(placement.tree);
            if (!workspace) continue;
            const accountKey = accountKeyOf(placement);
            let listed = remoteTreesByAccount.get(accountKey);
            if (!listed) {
              listed = client.list().then((value) => value.snapshot);
              remoteTreesByAccount.set(accountKey, listed);
            }
            const remoteTrees = await listed;
            this.listings.set(accountKey, remoteTrees);
            const folder = await this.folderFor(placement, workspace);
            let remote = remoteTrees.find((tree) => tree.id === placement.tree);
            if (!remote && placement.readOnly) {
              // A tree mounted nowhere is not listed to a reader; read it by ID.
              // A read-only placement never activates a tree.
              remote = (await client.descriptor(placement.tree).catch(() => null))?.tree;
              if (!remote) throw new ProtocolError("not-found", `${placement.tree} is not readable at ${placement.endpoint}`, 404);
            }
            if (!remote) {
              // A reserved tree is activated with the folder's whole content.
              const initial = await this.withWorkspaceIO(
                workspace,
                // Nothing is tracked yet: ignore rules apply to the first snapshot.
                async () => resolveSnapshot(await this.scanWorkspace(workspace, remoteTrees, null)),
              );
              const activated = await client.submitUpdate(placement.tree, null, initial);
              // Activation attaches the tree where its parent mounts it, if anywhere.
              const described = await client.descriptor(placement.tree).catch(() => null);
              await this.trees.updateSyncMetadata({
                ...placement,
                ref: activated.update.root,
                update: activated.update.id,
                access: "write",
                canonicalPath: described?.tree.canonical?.path ?? placement.canonicalPath,
                canonicalURL: described?.tree.canonical?.url,
              });
              await folder.placed({ root: activated.update.root, update: activated.update.id });
              this.trees.setSyncState(placement.tree, "idle");
              continue;
            }
            const access = placement.readOnly ? "read" : remote.access;
            // The host decides a tree's canonical path; a mount or rename moves it.
            const canonicalPath = remote.canonical?.path;
            const canonicalURL = remote.canonical?.url;
            if (placement.access !== access || (placement.kind !== "tree-configuration"
              && (placement.canonicalPath !== canonicalPath || placement.canonicalURL !== canonicalURL))) {
              await this.trees.updateSyncMetadata({ ...placement, access, canonicalPath, canonicalURL });
            }
            if (!placement.ref || !placement.update) await folder.placeFromHost();
            folder.ensureWatch();
            const presentation = await folder.syncOnce();
            // A configuration edit can mount, rename or unmount trees: list again after it.
            if (placement.kind === "tree-configuration") remoteTreesByAccount.delete(accountKey);
            if (throwErrors && (presentation.state === "offline" || presentation.state === "stopped"
                || presentation.state === "authentication-failure" || presentation.state === "revoked")) {
              // The machine already reports this state; only the caller needs the error.
              throw new UnsynchronizedTreeError(placement.tree, presentation.detail);
            }
          } catch (error) {
            if (!(error instanceof UnsynchronizedTreeError)) this.trees.setSyncState(placement.tree, error instanceof ProtocolTransportError ? "offline" : "error");
            if (throwErrors) throw error;
          }
        }
      } while (this.syncRequested);
    } finally {
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
    }
  }

  /** Run the person's tasks sent from their other devices (Agents 002): only the device's own long-lived Story Sync does. */
  startRunner(): void {
    this.runner.start();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.syncStartupTimer) clearTimeout(this.syncStartupTimer);
    await this.runner[Symbol.asyncDispose]();
    await this.runs[Symbol.asyncDispose]();
    await this.agents[Symbol.asyncDispose]();
    if (this.syncing) await new Promise<void>((resolve) => this.syncWaiters.push(resolve));
    this.unsubscribeEvents();
    for (const unsubscribe of this.ignoredChanges.values()) unsubscribe();
    this.ignoredChanges.clear();
    await Promise.all([...this.folders.values()].map((folder) => folder.sync.close()));
    this.folders.clear();
    await this.trees[Symbol.asyncDispose]();
  }
}
