import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type {
  Hash,
  MutationReceipt,
  NodeRef,
  LocalTreeDescriptor,
  LocatorResolution,
  SnapshotEnvelope,
  SyncConflictContent,
  SyncConflictResolution,
  SyncConflictWorkspace,
} from "@arbor/core";
import { SYSTEM_TREE, canonicalNodePath, normalizeTreePath, siblingMarkdownTreePath } from "@arbor/core";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@arbor/fs";
import {
  CanopyAccountStore,
  CommunityConfigStore,
  ProfileIdentityStore,
  listLocalAccounts,
  loadLocalPlacements,
  replaceLocalPlacement,
  type LocalAccountSummary,
  type LocalPlacement,
  type SharedTreePlacement,
} from "@arbor/stores";
import { WireClient, compareWireNames, decodeWireObject, encodeSparseSnapshotBundle, encodeWireObject, hashObject, updateRequestDigests, verifyTreeSnapshotGraph, type CandidateUpdateJSON, type LazyTreeSnapshot, type ObjectHash, type RemoteTreeDescriptor, type TreeSnapshot, type UpdateRequest } from "@arbor/wire";
import { accountWireClient, type AccountSelector, type AccountWireClient } from "@arbor/canopy-client";
import { claimCanopyAccountBootstrap, createPairingBootstrap, forgetLocalAccount, resolveUserPath } from "@arbor/canopy-client";
import { EventBus } from "./events.ts";
import { TreeObjectCache } from "./object-cache.ts";
import {
  clearPendingTreeUpdate,
  clearTreeConflict,
  pendingFromSnapshot,
  pendingTreeUpdate,
  savePendingTreeUpdate,
  saveAcceptedTreeObjects,
  snapshotFromConflictDraft,
  saveTreeConflictMaterial,
  treeConflict,
  treeConflictMaterial,
  updatesFromPending,
} from "@arbor/canopy-client";
import { TreeManager } from "./tree-manager.ts";
import { TreeSynchronizer } from "@arbor/canopy-client";
import { ProtocolError, Workspace, type WorkspaceOptions } from "./workspace.ts";

export { resolveUserPath } from "@arbor/canopy-client";

/** A logical path inside one placed or session workspace. */
interface ResolvedScope {
  workspace: Workspace;
  ref: NodeRef;
}

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/** The real OS path for a logical path, resolving the longest existing prefix. */
async function realOsPath(inputPath: string): Promise<string> {
  const path = normalizeTreePath(inputPath);
  let prefix = path;
  let remainder = "";
  while (prefix !== "/") {
    try {
      const real = await realpath(prefix);
      return `${real}${remainder}`;
    } catch (error) {
      if (isSystemError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
        throw new ProtocolError("permission-denied", `The operating system denied access to ${inputPath}`, 403, { path: inputPath });
      }
      remainder = `/${basename(prefix)}${remainder}`;
      prefix = dirname(prefix);
    }
  }
  return `${remainder}` || "/";
}

/** What a loopback client needs to open a placed tree as its own working tree. */
export interface TreeBootstrap {
  tree: LocalTreeDescriptor;
  /** The daemon's accepted base; `cursor` is the Wire watch cursor, which equals the update id. */
  accepted: { root: Hash; update: string; cursor: string };
  /** Base64 of a sparse CBOR snapshot bundle: every directory object and every Markdown file object. */
  spine: string;
  /** Every non-Markdown file entry by wire path; the client resolves their objects on demand. */
  files: Record<string, { size: number; mtime: number }>;
  /** The daemon's stored update string, verbatim, when it still describes the folder exactly. */
  pending?: { base: string | null; updates: CandidateUpdateJSON[]; requestDigests: string[] };
  blocked?: "conflict" | "unsettled";
  observedThrough: string;
}

export interface ArborSyncDaemonOptions {
  autoSync?: boolean;
  /**
   * Fallback reconciliation interval. Live Wire watches drive synchronization;
   * this pass only covers a placement whose watch is disconnected.
   */
  syncIntervalMs?: number;
}

const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const WIRE_SYNC_TIMEOUT_MS = 60_000;

type ConflictTarget = { kind: "object"; hash: ObjectHash } | { kind: "boundary"; tree: string } | { kind: "missing" };

function conflictPath(path: string): string[] {
  if (!path.startsWith("/")) throw new Error("Conflict path is not absolute");
  if (path === "/") return [];
  const parts = path.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Conflict path is invalid");
  return parts;
}

function conflictTarget(snapshot: TreeSnapshot, path: string): ConflictTarget {
  verifyTreeSnapshotGraph(snapshot);
  const parts = conflictPath(path);
  if (!parts.length) return { kind: "object", hash: snapshot.root };
  let hash = snapshot.root;
  for (const [index, part] of parts.entries()) {
    const bytes = snapshot.objects.get(hash);
    if (!bytes) throw new Error(`Conflict snapshot is missing object: ${hash}`);
    const object = decodeWireObject(bytes);
    if (object.type !== "directory") return { kind: "missing" };
    const entry = object.entries.find((candidate) => candidate.name === part);
    if (!entry) return { kind: "missing" };
    if (index === parts.length - 1) {
      if (entry.tree) return { kind: "boundary", tree: entry.tree };
      return entry.hash ? { kind: "object", hash: entry.hash } : { kind: "missing" };
    }
    if (!entry.hash) return { kind: "missing" };
    hash = entry.hash;
  }
  return { kind: "missing" };
}

function conflictContent(snapshot: TreeSnapshot, path: string): SyncConflictContent {
  const target = conflictTarget(snapshot, path);
  if (target.kind === "missing") return { kind: "missing" };
  if (target.kind === "boundary") return { kind: "boundary", tree: target.tree };
  const bytes = snapshot.objects.get(target.hash);
  if (!bytes) throw new Error(`Conflict snapshot is missing object: ${target.hash}`);
  const object = decodeWireObject(bytes);
  if (object.type === "directory") return { kind: "directory", entries: object.entries.map((entry) => entry.name) };
  try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(object.bytes) }; }
  catch { return { kind: "binary", bytes: Buffer.from(object.bytes).toString("base64") }; }
}

function replaceConflictTarget(destination: TreeSnapshot, path: string, source: TreeSnapshot, editedText?: string): TreeSnapshot {
  verifyTreeSnapshotGraph(destination);
  verifyTreeSnapshotGraph(source);
  const replacement = editedText === undefined
    ? conflictTarget(source, path)
    : (() => {
        const bytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(editedText) });
        return { kind: "object", hash: hashObject(bytes), bytes } as const;
      })();
  const parts = conflictPath(path);
  const objects = new Map(destination.objects);
  for (const [hash, bytes] of source.objects) objects.set(hash, bytes);
  if ("bytes" in replacement) objects.set(replacement.hash, replacement.bytes);
  if (!parts.length) {
    if (replacement.kind !== "object") throw new Error("The tree root cannot be removed or become a boundary");
    return reachableSnapshot(replacement.hash, objects);
  }
  const rewrite = (directoryHash: ObjectHash, depth: number): ObjectHash => {
    const bytes = objects.get(directoryHash);
    if (!bytes) throw new Error(`Conflict snapshot is missing object: ${directoryHash}`);
    const directory = decodeWireObject(bytes);
    if (directory.type !== "directory") throw new Error("Conflict path parent is not a directory");
    const name = parts[depth]!;
    const entries = directory.entries.filter((entry) => entry.name !== name);
    if (depth === parts.length - 1) {
      if (replacement.kind === "object") entries.push({ name, hash: replacement.hash });
      if (replacement.kind === "boundary") entries.push({ name, tree: replacement.tree });
    } else {
      const prior = directory.entries.find((entry) => entry.name === name);
      if (!prior?.hash) throw new Error("Conflict path parent is missing");
      entries.push({ name, hash: rewrite(prior.hash, depth + 1) });
    }
    entries.sort((left, right) => compareWireNames(left.name, right.name));
    const next = encodeWireObject({ type: "directory", entries, ...(directory.childrenSource ? { childrenSource: directory.childrenSource } : {}) });
    const nextHash = hashObject(next);
    objects.set(nextHash, next);
    return nextHash;
  };
  return reachableSnapshot(rewrite(destination.root, 0), objects);
}

function reachableSnapshot(root: ObjectHash, available: ReadonlyMap<ObjectHash, Uint8Array>): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const visit = (hash: ObjectHash) => {
    if (objects.has(hash)) return;
    const bytes = available.get(hash);
    if (!bytes) throw new Error(`Retained conflict candidate is missing object: ${hash}`);
    objects.set(hash, bytes);
    const object = decodeWireObject(bytes);
    if (object.type === "directory") for (const entry of object.entries) if (entry.hash) visit(entry.hash);
  };
  visit(root);
  return verifyTreeSnapshotGraph({ root, objects });
}

/**
 * Walk a lazy snapshot from its root without loading non-Markdown files:
 * directory objects and `.md` file objects go into the sparse spine, every
 * other file entry is reported by wire path with its size and mtime so the
 * client can tell a payload-less file from a missing directory (wire entries
 * carry no kind). Boundaries stop the walk.
 */
async function sparseSpine(root: string, lazy: LazyTreeSnapshot): Promise<{ spine: string; files: Record<string, { size: number; mtime: number }> }> {
  const spine = new Map<ObjectHash, Uint8Array>();
  const files: Record<string, { size: number; mtime: number }> = {};
  const visit = async (hash: ObjectHash, segments: string[]): Promise<void> => {
    const source = lazy.objects.get(hash);
    if (!source) throw new Error(`Snapshot is missing object ${hash}`);
    const bytes = await source.bytes();
    if (!spine.has(hash)) spine.set(hash, bytes);
    const object = decodeWireObject(bytes);
    if (object.type !== "directory") return;
    for (const entry of object.entries) {
      if (!entry.hash) continue;
      const child = lazy.objects.get(entry.hash);
      if (!child) throw new Error(`Snapshot is missing object ${entry.hash}`);
      const path = [...segments, entry.name];
      if (child.kind === "directory") {
        await visit(entry.hash, path);
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        if (!spine.has(entry.hash)) spine.set(entry.hash, await child.bytes());
      } else {
        const info = await stat(join(root, ...path));
        files[`/${path.join("/")}`] = { size: info.size, mtime: Math.floor(info.mtimeMs) };
      }
    }
  };
  await visit(lazy.root, []);
  return { spine: Buffer.from(encodeSparseSnapshotBundle(spine)).toString("base64"), files };
}

/**
 * The daemon's top-level coordinator: one process-wide event bus, a root
 * manager owning N per-root Workspaces, the per-tree Canopy synchronizer,
 * and the loopback services a working-tree client uses (bootstrap,
 * credential, objects, conflicts). The editor path (node reads, mutations,
 * admission) was deleted in Native 022 Phase 7; editors run the update
 * machine against their own working tree.
 */
export class ArborSyncDaemon implements AsyncDisposable {
  readonly events: EventBus;
  readonly trees: TreeManager;
  readonly communityConfig = new CommunityConfigStore();
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncStartupTimer?: ReturnType<typeof setTimeout>;
  private placementMoving = false;
  private placementMoveWaiters: Array<() => void> = [];
  private syncing = false;
  private syncRequested = false;
  private syncWaiters: Array<() => void> = [];
  private workspaceIOTails = new Map<string, Promise<void>>();
  private readonly treeSync: TreeSynchronizer<Workspace>;
  private readonly objectCache: TreeObjectCache;

  private constructor(events: EventBus, trees: TreeManager, options: ArborSyncDaemonOptions = {}) {
    this.events = events;
    this.trees = trees;
    this.treeSync = new TreeSynchronizer<Workspace>({
      trees,
      events,
      accountToken: (placement) => this.accountToken(placement),
      withWorkspaceIO: (workspace, run) => this.withWorkspaceIO(workspace, run),
      snapshotWorkspace: (workspace, client, remoteTrees) => this.snapshotWorkspace(workspace, client, remoteTrees),
      requestSync: () => this.syncAll(),
    });
    this.objectCache = new TreeObjectCache({
      workspaceFor: (tree) => trees.workspaceByTree(tree),
      boundariesFor: (workspace) => trees.sharedBoundariesWithin(workspace.root),
      exclusionsFor: (workspace) => trees.excludedMountsWithin(workspace.root),
      clientFor: async (tree, origin) => {
        const placement = trees.placementFor(tree);
        if (placement) return this.accountClient(placement);
        return origin ? new WireClient(origin, undefined, { timeoutMs: WIRE_SYNC_TIMEOUT_MS }) : undefined;
      },
    });
    if (options.autoSync !== false) this.startAutoSync(options.syncIntervalMs);
  }

  /** Verified object bytes for a tree from the index, the pending body, or Canopy. */
  objectBytes(tree: string, hash: ObjectHash, origin?: string): Promise<Uint8Array | undefined> {
    return this.objectCache.bytes(tree, hash, origin);
  }

  /**
   * Bootstrap material for a placed tree. The spine and `files` map always
   * describe the folder as it is now; `pending` is returned verbatim only when
   * the stored update string still ends at that folder, and `blocked` tells a
   * client why it must not adopt the folder as a clean base.
   */
  async bootstrapTree(tree: string): Promise<TreeBootstrap> {
    const placement = this.trees.placementFor(tree);
    const workspace = placement ? await this.trees.workspaceByTree(tree) : undefined;
    if (!placement || !workspace) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });
    if (!placement.ref || !placement.update) {
      throw new ProtocolError("conflict", `Tree has not synchronized an accepted base yet: ${tree}`, 409, { tree, details: { kind: "unsynchronized" } });
    }
    const list = await this.treeList();
    const descriptor = list.snapshot.find((item) => item.id === tree);
    if (!descriptor) throw new ProtocolError("not-found", `Tree has no local placement: ${tree}`, 404, { tree });

    const lazy = await snapshotDirectory(
      workspace.root,
      this.trees.sharedBoundariesWithin(workspace.root),
      this.trees.excludedMountsWithin(workspace.root),
      (directory, sourceName) => workspace.describeWireCollectionFile(directory, sourceName),
      workspace.objectIndex(),
    );
    const { spine, files } = await sparseSpine(workspace.root, lazy);

    const [conflict, pending] = await Promise.all([treeConflict(tree), pendingTreeUpdate(tree)]);
    const response: TreeBootstrap = {
      tree: descriptor,
      accepted: { root: placement.ref as Hash, update: placement.update, cursor: placement.update },
      spine,
      files,
      observedThrough: this.events.currentCursor(),
    };
    if (conflict) return { ...response, blocked: "conflict" };
    if (pending) {
      const updates = updatesFromPending(pending);
      if (pending.base === placement.update && updates.at(-1)?.candidate === lazy.root) {
        // Digests ignore object envelopes, so the JSON updates stand in for the decoded request.
        const request = { base: pending.base, updates } as unknown as UpdateRequest;
        return { ...response, pending: { base: pending.base, updates, requestDigests: updateRequestDigests(tree, request) } };
      }
      return { ...response, blocked: "unsettled" };
    }
    if (lazy.root !== placement.ref) return { ...response, blocked: "unsettled" };
    return response;
  }

  /**
   * The account credential for a configuration tree. Serving it over loopback
   * is deliberate: any local process with the user's filesystem access can
   * already read the credential store and write the placed folders, so this
   * exposes no new authority (documented in `docs/local-system.md`).
   */
  async credentialToken(configurationTree?: string): Promise<string> {
    let token: string | undefined;
    if (configurationTree) {
      let store: CanopyAccountStore;
      try { store = new CanopyAccountStore(configurationTree); }
      catch { throw new ProtocolError("invalid-request", "configurationTree must be a TreeID", 400); }
      token = (await store.get())?.accountToken;
    } else {
      const accounts = await CanopyAccountStore.list();
      if (accounts.length > 1) {
        throw new ProtocolError("invalid-request", "credential requires an explicit configurationTree when several accounts are connected", 400);
      }
      token = accounts.length === 1
        ? (await new CanopyAccountStore(accounts[0]!.configurationTree).get())?.accountToken
        : (await this.communityConfig.get())?.accountToken;
    }
    if (!token) throw new ProtocolError("not-found", "No account credential is available", 404);
    return token;
  }

  private startAutoSync(syncIntervalMs?: number): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      // A periodic tick is only a freshness hint. Do not turn a slow or failed
      // request into an unbounded immediate retry loop that masks its error
      // state as permanently syncing.
      if (!this.syncing) void this.syncAll();
    }, syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
    this.syncStartupTimer = setTimeout(() => {
      this.syncStartupTimer = undefined;
      void this.syncAll();
    }, 0);
  }

  /**
   * The multiplexer: every Canopy pass-through picks the claimed account
   * whose address contains the target and forwards with that credential.
   */
  private wireFor(selector: AccountSelector, options: { required?: boolean } = {}): Promise<AccountWireClient> {
    return accountWireClient(selector, { communityConfig: this.communityConfig, timeoutMs: WIRE_SYNC_TIMEOUT_MS, ...options });
  }

  private async accountToken(placement: SharedTreePlacement): Promise<string | undefined> {
    const selected = await this.wireFor({ configurationTree: placement.configurationTree, origin: placement.endpoint });
    if (!selected.authenticated) return undefined;
    if (selected.configurationTree) return (await new CanopyAccountStore(selected.configurationTree).get())?.accountToken;
    return (await this.communityConfig.get())?.accountToken;
  }

  private async accountClient(placement: SharedTreePlacement): Promise<WireClient> {
    return (await this.wireFor({ configurationTree: placement.configurationTree, origin: placement.endpoint })).client;
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
  private async resolveScope(inputPath: string): Promise<ResolvedScope | null> {
    const canonical = canonicalNodePath(inputPath);
    const real = await realOsPath(canonical);
    const owner = await this.trees.ownerOf(real);
    if (owner) {
      const mounted = this.trees.reservedBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath))
        ?? this.trees.localMountBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath));
      if (mounted) {
        const mountedWorkspace = await this.trees.workspaceByTree(mounted.tree);
        if (mountedWorkspace) {
          return { workspace: mountedWorkspace, ref: { tree: mounted.tree, path: mounted.treePath, stableKey: null } };
        }
      }
      return { workspace: owner.workspace, ref: { tree: owner.workspace.tree, path: canonicalNodePath(owner.treePath), stableKey: null } };
    }
    // A Markdown node's physical representation is its `.md` sibling; a
    // symlinked sibling can land the logical node inside a live root.
    if (canonical !== "/") {
      const realSibling = await realOsPath(siblingMarkdownTreePath(canonical)).catch(() => null);
      const siblingOwner = realSibling ? await this.trees.ownerOf(realSibling) : null;
      if (siblingOwner && siblingOwner.treePath.endsWith(".md")) {
        return { workspace: siblingOwner.workspace, ref: { tree: siblingOwner.workspace.tree, path: canonicalNodePath(siblingOwner.treePath), stableKey: null } };
      }
    }
    return null;
  }

  async treeList(): Promise<SnapshotEnvelope<LocalTreeDescriptor[]>> {
    const descriptors = await this.trees.descriptors();
    return {
      snapshot: await Promise.all(descriptors.map(async (descriptor) => ({
        ...descriptor,
        ...(descriptor.sync === "conflict" ? { reviewableConflict: Boolean(await treeConflict(descriptor.id)) } : {}),
      }))),
      observedThrough: this.events.currentCursor(),
    };
  }

  async resolveLocator(locator: string): Promise<LocatorResolution> {
    if (!/^(?:https?|arbor):\/\//.test(locator)) {
      const absolute = resolveUserPath(locator);
      const scope = await this.resolveScope(absolute);
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
    const resolution = await (await this.wireFor({ origin })).client.resolve(path || "/");
    const local = (await this.trees.descriptors()).find((tree) => tree.id === resolution.ref.tree);
    return { ...resolution, ...(local ? { enclosingTree: local } : {}) };
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
      const scope = await this.resolveScope(referrerUrlPath);
      if (!scope) return null;
      return await scope.workspace.fileSurface(treeRootedPath, raw);
    } catch {
      return null;
    }
  }

  /** The byte surface for an OS-shaped URL path, dispatched into its owning root. */
  async fileSurface(urlPath: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    let scope: ResolvedScope | null;
    try {
      scope = await this.resolveScope(urlPath);
    } catch {
      return null;
    }
    if (!scope) return null;
    return scope.workspace.fileSurface(scope.ref.path, raw).catch(() => null);
  }

  async claimCanopyAccount(account: string, inputPath: string, displayName?: string): Promise<MutationReceipt["effects"]> {
    return claimCanopyAccountBootstrap(this, account, inputPath, displayName);
  }

  async profileIdentity() {
    return new ProfileIdentityStore().status();
  }

  async createProfileIdentity(inputPath: string) {
    const result = await new ProfileIdentityStore().create(resolveUserPath(inputPath));
    this.trees.invalidateDescriptors();
    return result;
  }

  async forgetLocalAccount(): Promise<void> {
    return forgetLocalAccount(this);
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

  /** The claimed accounts of this data home; the projection lives in `@arbor/stores` so the CLI can read it directly. */
  async accountList(): Promise<LocalAccountSummary[]> {
    return listLocalAccounts(this.communityConfig);
  }

  async createPairingBootstrap(configurationTree?: string) {
    return createPairingBootstrap(this, configurationTree);
  }

  private async conflictReviewMaterial(tree: string) {
    const conflict = await treeConflict(tree);
    if (!conflict) throw new ProtocolError("not-found", `Tree has no stored synchronization conflict: ${tree}`, 404);
    const identity = conflict.details.candidate;
    const retained = await treeConflictMaterial(tree);
    if (retained?.identity === identity) return { conflict, identity, material: retained.material };
    const placement = this.trees.placementFor(tree);
    const workspace = await this.trees.workspaceByTree(tree);
    if (!placement || !workspace) throw new ProtocolError("not-found", `Shared tree placement is unavailable: ${tree}`, 404);
    const client = await this.accountClient(placement);
    const mine = await this.snapshotWorkspace(workspace, client);
    if (mine.root !== conflict.details.candidate) {
      throw new ProtocolError(
        "conflict",
        "Conflict evidence is unavailable because the local tree advanced before its candidate graph was retained",
        409,
        { tree, details: { kind: "conflict-evidence-unavailable" } },
      );
    }
    const [base, current] = await Promise.all([
      client.snapshot(tree, conflict.details.base),
      client.snapshot(tree, conflict.details.current.root),
    ]);
    if (base.root !== conflict.details.base || current.root !== conflict.details.current.root) {
      throw new Error("Canopy returned conflict snapshots with unexpected roots");
    }
    const draft = snapshotFromConflictDraft(conflict, mine);
    const material = {
      base: verifyTreeSnapshotGraph(base),
      current: verifyTreeSnapshotGraph(current),
      mine: verifyTreeSnapshotGraph(mine),
      draft: verifyTreeSnapshotGraph(draft),
    };
    await saveTreeConflictMaterial(tree, identity, material);
    return { conflict, identity, material };
  }

  async treeConflictWorkspace(tree: string): Promise<SyncConflictWorkspace> {
    const { conflict, identity, material } = await this.conflictReviewMaterial(tree);
    const grouped = new Map<string, string[]>();
    for (const item of conflict.details.conflicts) {
      grouped.set(item.path, [...(grouped.get(item.path) ?? []), item.reason]);
    }
    return {
      identity,
      tree,
      // The daemon submits one filesystem head per request; there is no
      // retained suffix behind the failed element.
      unattemptedCount: 0,
      items: [...grouped].sort(([left], [right]) => compareWireNames(left, right)).map(([path, reasons]) => {
        const current = conflictContent(material.current, path);
        const mine = conflictContent(material.mine, path);
        const draft = conflictContent(material.draft, path);
        return {
          path,
          reasons,
          base: conflictContent(material.base, path),
          current,
          mine,
          draft,
          offersBoth: JSON.stringify(draft) !== JSON.stringify(current) && JSON.stringify(draft) !== JSON.stringify(mine),
        };
      }),
    };
  }

  async resolveReviewedTreeConflict(
    tree: string,
    identity: string,
    resolutions: Record<string, SyncConflictResolution>,
  ): Promise<MutationReceipt["effects"]> {
    const review = await this.treeConflictWorkspace(tree);
    if (review.identity !== identity) throw new ProtocolError("conflict", "Conflict review is stale; reopen it before submitting", 409);
    if (review.unattemptedCount > 0) {
      throw new ProtocolError("unsupported-operation", "Later queued changes require ordered replay before this conflict can be resolved", 422);
    }
    const paths = review.items.map((item) => item.path);
    if (Object.keys(resolutions).length !== paths.length || paths.some((path) => !resolutions[path])) {
      throw new ProtocolError("invalid-request", "Choose a resolution for every conflicting path", 400);
    }
    for (const left of paths) for (const right of paths) {
      if (left !== right && right.startsWith(left === "/" ? "/" : `${left}/`)) {
        throw new ProtocolError("unsupported-operation", "Overlapping conflict paths cannot be resolved independently", 422);
      }
    }
    const { conflict, material } = await this.conflictReviewMaterial(tree);
    let candidate = material.draft;
    for (const item of review.items) {
      const resolution = resolutions[item.path]!;
      if (resolution.choice === "both") {
        if (!item.offersBoth) throw new ProtocolError("invalid-request", `Both is unavailable for ${item.path}`, 400);
      } else if (resolution.choice === "current") {
        candidate = replaceConflictTarget(candidate, item.path, material.current);
      } else if (resolution.choice === "mine") {
        candidate = replaceConflictTarget(candidate, item.path, material.mine);
      } else {
        if (resolution.choice !== "edit") throw new ProtocolError("invalid-request", `Invalid resolution for ${item.path}`, 400);
        const editable = [item.current, item.mine, item.draft].some((content) => content.kind === "text");
        if (!editable) throw new ProtocolError("invalid-request", `${item.path} is not editable text`, 400);
        candidate = replaceConflictTarget(candidate, item.path, material.draft, resolution.text);
      }
    }
    const placement = this.trees.placementFor(tree);
    const workspace = await this.trees.workspaceByTree(tree);
    if (!placement || !workspace) throw new ProtocolError("not-found", `Shared tree placement is unavailable: ${tree}`, 404);
    const client = await this.accountClient(placement);
    const descriptor = (await client.descriptor(tree)).tree;
    const local = await this.snapshotWorkspace(workspace, client);
    if (descriptor.root !== conflict.details.current.root || descriptor.update !== conflict.details.current.id || local.root !== material.mine.root) {
      throw new ProtocolError("conflict", "The tree changed while conflict review was open; reopen it before submitting", 409);
    }
    await materializeTree(
      workspace.root,
      candidate.root,
      (hash) => {
        const bytes = candidate.objects.get(hash);
        if (!bytes) throw new Error(`Reviewed conflict candidate is missing object: ${hash}`);
        return Promise.resolve(bytes);
      },
      undefined,
      this.trees.excludedMountsWithin(workspace.root),
    );
    await savePendingTreeUpdate(tree, pendingFromSnapshot(conflict.details.current.id, candidate));
    await clearTreeConflict(tree);
    this.treeSync.conflicts.delete(tree);
    await this.treeSync.updateWorkspace(workspace, placement, client, (await client.list()).snapshot);
    return [{ kind: "updated", ref: { tree: SYSTEM_TREE, path: `/conflicts/${tree}`, stableKey: null } }];
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
    await savePendingTreeUpdate(tree, pendingFromSnapshot(conflict.details.current.id, candidate));
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
    // The synchronizer builds requests and conflict material from the complete
    // graph, so the lazy walk is resolved here; index hits still skip no reads
    // for files the request needs, but the walk itself writes fresh rows.
    return resolveSnapshot(await snapshotDirectory(
      workspace.root,
      this.canonicalBoundariesFor(workspace, listed),
      this.trees.excludedMountsWithin(workspace.root),
      (directory, sourceName) => workspace.describeWireCollectionFile(directory, sourceName),
      workspace.objectIndex(),
    ));
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

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.syncStartupTimer) clearTimeout(this.syncStartupTimer);
    if (this.syncing) await new Promise<void>((resolve) => this.syncWaiters.push(resolve));
    await this.treeSync.close();
    await this.trees[Symbol.asyncDispose]();
  }
}
