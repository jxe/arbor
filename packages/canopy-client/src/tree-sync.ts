import type { SharedTreePlacement } from "@arbor/stores";
import {
  WireClient,
  WireUpdateConflict,
  applyTransitionPayload,
  decodeCandidateUpdateJSON,
  decodeWireObject,
  type CurrentTree,
  type ObjectHash,
  type RemoteTreeDescriptor,
  type TreeSnapshot,
  type WatchEvent,
} from "@arbor/wire";
import { ProtocolError, type Hash } from "@arbor/core";
import type { PlacementRegistry, SyncEventSink, SyncWorkspace } from "./ports.ts";
import {
  initialSyncState,
  reduceSync,
  type PreparedRequest,
  type SyncEffect,
  type SyncEvent,
  type SyncState,
} from "./direct-sync.ts";
import type { FrozenEditorAdmission } from "./editor-admission.ts";
import {
  acceptedTreeObjects,
  clearPendingTreeUpdate,
  clearTreeConflict,
  deltasFromPending,
  markEditorAdmissionsTransmitted,
  pendingFromSnapshot,
  pendingEditorAdmissions,
  pendingTreeUpdate,
  rememberAcceptedRequestDigests,
  retireAcknowledgedEditorAdmissions,
  saveAcceptedTreeObjectHashes,
  saveAcceptedTreeObjects,
  savePendingTreeUpdate,
  saveTreeConflict,
  acknowledgePendingEditorAdmissions,
  snapshotFromPending,
  treeConflict,
} from "./sync-state.ts";
import { materializeTree } from "@arbor/fs";

export interface TreeSyncDeps<W extends SyncWorkspace = SyncWorkspace> {
  trees: PlacementRegistry;
  events: SyncEventSink;
  accountToken(placement: SharedTreePlacement): Promise<string | undefined>;
  /** Serialize only local filesystem reads/writes for one tree; never hold this across Wire I/O. */
  withWorkspaceIO<T>(workspace: W, run: () => Promise<T>): Promise<T>;
  snapshotWorkspace(workspace: W, client: WireClient, remoteTrees?: readonly RemoteTreeDescriptor[]): Promise<TreeSnapshot>;
  /** Schedule one coalesced synchronization pass; resolves when a pass covering the request completes. */
  requestSync(): Promise<void>;
  /** Injected for deterministic publication and grace timers in tests. */
  clock?: SyncClock;
  /** Override the reference publication delays. */
  publicationDelayMs?: number;
  publicationMaxDelayMs?: number;
}

export interface SyncClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: SyncClock = {
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface TreeTimers {
  trailing?: unknown;
  max?: unknown;
  grace?: unknown;
}

type TreeRefWatchEvent = Extract<WatchEvent, { kind: "tree.update" }>;

const INITIAL_WATCH_BACKOFF_MS = 1_000;
const MAX_WATCH_BACKOFF_MS = 30_000;
/** Delayed watcher delivery must not outlive editor ownership handoff. */
const RECENT_EDITOR_GRACE_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Per-tree reconciliation between a placed workspace and its Wire authority.
 * Each shared placement keeps one open watch; delivered `tree.update` batches are
 * queued and applied by the daemon's serialized synchronization pass, so watch
 * events only ever hint or supply payload and never mutate state themselves.
 */
export class TreeSynchronizer<W extends SyncWorkspace = SyncWorkspace> {
  readonly conflicts = new Set<string>();
  private readonly queued = new Map<string, TreeRefWatchEvent[]>();
  private readonly watches = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** One direct Canopy synchronization machine per placed tree. */
  private readonly machines = new Map<string, SyncState>();
  private readonly timers = new Map<string, TreeTimers>();
  /** At most one editor publication request in flight per tree. */
  private readonly pushes = new Map<string, Promise<void>>();
  private readonly pushClients = new Map<string, WireClient>();
  /** Exact roots written by this process, including pre-metadata handoff windows. */
  private readonly lastMaterializedRoots = new Map<string, ObjectHash>();
  private readonly clock: SyncClock;
  private closed = false;

  constructor(private readonly deps: TreeSyncDeps<W>) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The machine state for one tree, for status and tests. */
  syncStateFor(tree: string): SyncState {
    return this.machines.get(tree) ?? initialSyncState();
  }

  private timersFor(tree: string): TreeTimers {
    let timers = this.timers.get(tree);
    if (!timers) {
      timers = {};
      this.timers.set(tree, timers);
    }
    return timers;
  }

  private clearTimer(tree: string, name: keyof TreeTimers): void {
    const timers = this.timersFor(tree);
    if (timers[name] !== undefined) this.clock.clearTimeout(timers[name]);
    timers[name] = undefined;
  }

  /** Enter the machine at the placement's accepted base, or advance its base when the placement moved. */
  private ensureMachine(tree: string): SyncState {
    const placement = this.deps.trees.placementFor(tree);
    let state = this.syncStateFor(tree);
    if (state.kind === "unplaced" && placement?.ref && placement.update) {
      state = reduceSync(state, { type: "bootstrapInstalled", root: placement.ref, update: placement.update }).state;
      this.machines.set(tree, state);
    }
    return state;
  }

  /**
   * Feed one event to a tree's machine and run its effects. Effects that need
   * daemon I/O are executed asynchronously; the reducer itself never waits.
   */
  private dispatch(tree: string, event: SyncEvent): SyncState {
    const before = this.ensureMachine(tree);
    const transition = reduceSync(before, event, {
      publicationDelayMs: this.deps.publicationDelayMs,
      publicationMaxDelayMs: this.deps.publicationMaxDelayMs,
    });
    this.machines.set(tree, transition.state);
    for (const effect of transition.effects) this.runEffect(tree, effect);
    return transition.state;
  }

  private runEffect(tree: string, effect: SyncEffect): void {
    switch (effect.type) {
      case "schedule": {
        this.clearTimer(tree, effect.timer);
        const timers = this.timersFor(tree);
        timers[effect.timer] = this.clock.setTimeout(() => {
          timers[effect.timer] = undefined;
          this.dispatch(tree, { type: effect.timer === "max" ? "maxDelayElapsed" : "publishDelayElapsed" });
        }, effect.delay);
        return;
      }
      case "cancelTimers":
        this.clearTimer(tree, "trailing");
        this.clearTimer(tree, "max");
        return;
      case "persistRequest":
        // Editor generations are already durable elements; the request is the
        // unacknowledged chain of the current epoch.
        void this.prepareEditorRequest(tree).catch(() => {});
        return;
      case "submit":
        void this.pushEditorChain(tree, effect.request).catch(() => {});
        return;
      case "apply":
      case "catchUp":
        // The daemon's serialized synchronization pass materializes accepted state.
        void this.deps.requestSync().catch(() => {});
        return;
      case "discardMirrorHead":
      case "surfaceConflict":
      case "stop":
        return;
    }
  }

  /**
   * During an editor epoch disk is a materialized mirror, not local intent.
   * The role stays `editor-mirror` while any admission is retained and for a
   * bounded grace period after the latest basis or admission, covering
   * delayed watcher delivery.
   */
  noteEditorActivity(tree: string): void {
    this.dispatch(tree, { type: "setRole", role: "editor-mirror" });
    this.clearTimer(tree, "grace");
    this.timersFor(tree).grace = this.clock.setTimeout(() => {
      this.timersFor(tree).grace = undefined;
      void pendingEditorAdmissions(tree).then((retained) => {
        if (!retained.length) this.dispatch(tree, { type: "setRole", role: "source" });
      });
    }, RECENT_EDITOR_GRACE_MS);
  }

  private filesystemIsEditorMirror(tree: string, retained: readonly FrozenEditorAdmission[]): boolean {
    return retained.length > 0 || this.syncStateFor(tree).role === "editor-mirror";
  }

  private snapshotWorkspace(
    workspace: W,
    client: WireClient,
    remoteTrees?: readonly RemoteTreeDescriptor[],
  ): Promise<TreeSnapshot> {
    return this.deps.withWorkspaceIO(
      workspace,
      () => this.deps.snapshotWorkspace(workspace, client, remoteTrees),
    );
  }

  /** Keep one live watch per placed tree; a finished loop is restarted by the next pass. */
  ensureWatch(placement: SharedTreePlacement): void {
    const { tree } = placement;
    const key = `${placement.configurationTree ?? "legacy"}:${tree}`;
    if (this.closed || this.watches.has(key)) return;
    const abort = new AbortController();
    const done = this.runWatch(placement, abort.signal).catch(() => {}).finally(() => {
      if (this.watches.get(key)?.abort === abort) this.watches.delete(key);
    });
    this.watches.set(key, { abort, done });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const tree of this.timers.keys()) {
      this.clearTimer(tree, "trailing");
      this.clearTimer(tree, "max");
      this.clearTimer(tree, "grace");
    }
    const open = [...this.watches.values()];
    for (const watch of open) watch.abort.abort();
    await Promise.all(open.map((watch) => watch.done));
  }

  private async runWatch(expected: SharedTreePlacement, signal: AbortSignal): Promise<void> {
    const { tree, endpoint } = expected;
    let backoff = INITIAL_WATCH_BACKOFF_MS;
    while (!signal.aborted) {
      const placement = this.deps.trees.placementFor(tree);
      if (!placement?.update || placement.endpoint !== endpoint || placement.configurationTree !== expected.configurationTree) return;
      const client = new WireClient(endpoint, await this.deps.accountToken(placement));
      if (signal.aborted) return;
      const connection = new AbortController();
      const stopConnection = () => connection.abort();
      signal.addEventListener("abort", stopConnection, { once: true });
      let resync = false;
      try {
        for await (const event of client.watch(tree, placement.update, { signal: connection.signal })) {
          backoff = INITIAL_WATCH_BACKOFF_MS;
          if (event.kind === "tree.update" && "transitions" in event) {
            const queue = this.queued.get(tree) ?? [];
            queue.push(event);
            this.queued.set(tree, queue);
            void this.deps.requestSync();
          } else if (event.kind === "resync-required") {
            this.queued.delete(tree);
            resync = true;
            break;
          }
        }
      } catch {
        // Transport failures fall through to the backoff below.
      } finally {
        signal.removeEventListener("abort", stopConnection);
        connection.abort();
      }
      if (signal.aborted) return;
      if (resync) {
        // Let a full pass re-establish the accepted base before resuming.
        await this.deps.requestSync().catch(() => {});
        continue;
      }
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_WATCH_BACKOFF_MS);
    }
  }

  private async materialize(
    workspace: W,
    snapshot: TreeSnapshot,
    acceptedRequestDigests: readonly Hash[] = [],
  ): Promise<void> {
    await materializeTree(
      workspace.root,
      snapshot.root,
      (hash) => {
        const bytes = snapshot.objects.get(hash);
        if (!bytes) throw new Error(`Accepted snapshot is missing object: ${hash}`);
        return Promise.resolve(bytes);
      },
      undefined,
      this.deps.trees.excludedMountsWithin(workspace.root),
    );
    this.lastMaterializedRoots.set(workspace.tree, snapshot.root);
    await rememberAcceptedRequestDigests(workspace.tree, acceptedRequestDigests);
    // Cursor ordering and request-digest correlation have already established
    // that this is accepted Wire state. Publish that causal fact directly
    // instead of relying on the filesystem watcher to infer it from bytes. The
    // root event is a conservative tree-wide invalidation for open sessions;
    // path-specific filesystem observations may follow as harmless duplicates.
    this.deps.events.emit({
      tree: workspace.tree,
      kind: "updated",
      ref: { tree: workspace.tree, path: "/", stableKey: null },
      origin: "sync",
      ...(acceptedRequestDigests.length ? { acceptedRequestDigests: [...new Set(acceptedRequestDigests)] } : {}),
    });
  }

  /** Resolve one coherent descriptor observation to its immutable graph. */
  private async readSnapshot(
    client: WireClient,
    tree: string,
    descriptor?: CurrentTree,
  ): Promise<{ current: CurrentTree; snapshot: TreeSnapshot }> {
    const current = descriptor ?? await client.descriptor(tree);
    return { current, snapshot: await client.snapshot(tree, current.tree.root) };
  }

  /** Reuse the clean local graph and fetch only objects newly reachable from the current root. */
  private async readSparseCurrent(
    client: WireClient,
    tree: string,
    current: CurrentTree,
    retained: TreeSnapshot,
  ): Promise<TreeSnapshot> {
    const objects = new Map<ObjectHash, Uint8Array>();
    const pending: ObjectHash[] = [current.tree.root];
    while (pending.length) {
      const hash = pending.pop()!;
      if (objects.has(hash)) continue;
      const bytes = retained.objects.get(hash) ?? await client.object(tree, hash);
      objects.set(hash, bytes);
      const object = decodeWireObject(bytes);
      if (object.type === "directory") {
        for (const entry of object.entries) if (entry.hash) pending.push(entry.hash);
      }
    }
    return { root: current.tree.root, objects };
  }

  /** Verify the on-disk tree matches the accepted root, then record it as the accepted base. */
  private async confirmMaterialized(
    workspace: W,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
    root: ObjectHash,
    message: string,
  ): Promise<void> {
    const acceptedLocal = await this.deps.snapshotWorkspace(workspace, client, remoteTrees);
    if (acceptedLocal.root !== root) throw new Error(message);
    await saveAcceptedTreeObjects(workspace.tree, acceptedLocal);
    await clearPendingTreeUpdate(workspace.tree);
    await clearTreeConflict(workspace.tree);
    this.deps.trees.setSyncState(workspace.tree, "idle");
    this.conflicts.delete(workspace.tree);
  }

  /** Bring a clean placement to the authority's current state in one snapshot read. */
  private async pullCurrent(
    workspace: W,
    placement: SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
    descriptor?: CurrentTree,
    retained?: TreeSnapshot,
  ): Promise<void> {
    const current = descriptor ?? await client.descriptor(workspace.tree);
    const snapshot = retained
      ? await this.readSparseCurrent(client, workspace.tree, current, retained)
      : (await this.readSnapshot(client, workspace.tree, current)).snapshot;
    await this.deps.withWorkspaceIO(workspace, async () => {
      await this.materialize(workspace, {
        root: current.tree.root,
        objects: snapshot.objects,
      });
      await this.deps.trees.updateSyncMetadata({
        ...placement,
        ref: current.tree.root,
        update: current.tree.update,
        access: current.tree.access === "none" ? "read" : current.tree.access,
      });
      await this.confirmMaterialized(workspace, client, remoteTrees, current.tree.root, "Materialized placement does not match its server root");
    });
  }

  /**
   * Apply watched transitions to a clean placement without contacting the
   * server. Returns false, leaving the ordinary pass to reconcile, whenever
   * the queue does not chain exactly from the local accepted base.
   */
  private async applyQueuedTransitions(
    workspace: W,
    placement: SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
  ): Promise<boolean> {
    const events = this.queued.get(workspace.tree);
    if (!events?.length) return false;
    this.queued.delete(workspace.tree);
    if (!placement.ref || !placement.update) return false;
    const transitions = events.flatMap((event) => event.transitions);
    const final = transitions.at(-1);
    if (!final) return false;
    if (final.update.id === placement.update) {
      // The pass that submitted this update already materialized it.
      this.deps.trees.setSyncState(workspace.tree, "idle");
      return true;
    }
    if (transitions[0]!.update.previousRoot !== placement.ref) return false;
    if (await pendingTreeUpdate(workspace.tree) || await treeConflict(workspace.tree)) return false;
    const local = await this.snapshotWorkspace(workspace, client, remoteTrees);
    if (local.root !== placement.ref) return false;

    let objects: Map<ObjectHash, Uint8Array> = new Map(local.objects);
    let expected: ObjectHash = placement.ref;
    try {
      for (const transition of transitions) {
        if (transition.update.previousRoot !== expected) return false;
        objects = applyTransitionPayload(objects, transition);
        expected = transition.update.root;
      }
    } catch {
      return false;
    }
    const descriptor = events.at(-1)!.descriptor;
    if (descriptor.root !== final.update.root || descriptor.update !== final.update.id) return false;

    await this.deps.withWorkspaceIO(workspace, async () => {
      await this.materialize(
        workspace,
        { root: final.update.root, objects },
        transitions.flatMap((transition) => transition.requestDigest ? [transition.requestDigest as Hash] : []),
      );
      await this.deps.trees.updateSyncMetadata({
        ...placement,
        ref: final.update.root,
        update: final.update.id,
        access: descriptor.access === "none" ? "read" : descriptor.access,
      });
      await this.confirmMaterialized(workspace, client, remoteTrees, final.update.root, "Materialized watched transition does not match its accepted root");
    });
    return true;
  }

  /**
   * Submit editor candidates that were frozen without touching the authored
   * tree. Once every queued decision is durable on Canopy, prefer its accepted
   * transition chain and otherwise fetch only objects absent from the clean
   * local graph. A newer local edit still leaves materialization to the ordinary
   * filesystem path.
   */
  private async submitEditorAdmissions(
    workspace: W,
    placement: SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
    publishNow: boolean,
  ): Promise<SharedTreePlacement> {
    let admissions = await pendingEditorAdmissions(workspace.tree);
    if (!admissions.length) return placement;
    if (placement.access !== "write") {
      this.deps.trees.setSyncState(workspace.tree, "conflict");
      return placement;
    }
    await this.publishEditorAdmissions(workspace.tree, client, { now: publishNow });
    admissions = await pendingEditorAdmissions(workspace.tree);
    if (admissions.some((admission) => !admission.acknowledged)) return placement;

    const local = await this.snapshotWorkspace(workspace, client, remoteTrees);
    if (!placement.ref || local.root !== placement.ref) return placement;
    const acknowledged = admissions.filter((admission) => admission.acknowledged);
    if (await this.applyQueuedTransitions(workspace, placement, client, remoteTrees)) {
      await retireAcknowledgedEditorAdmissions(workspace.tree, acknowledged);
      this.dispatch(workspace.tree, { type: "applied" });
      return this.deps.trees.placementFor(workspace.tree) ?? placement;
    }
    const current = await client.descriptor(workspace.tree);
    const snapshot = await this.readSparseCurrent(client, workspace.tree, current, local);
    await this.deps.withWorkspaceIO(workspace, async () => {
      // Recheck after network I/O. A local editor or external process may have
      // changed the disk while the accepted snapshot was being fetched.
      const stillClean = await this.deps.snapshotWorkspace(workspace, client, remoteTrees);
      if (stillClean.root !== placement.ref) return;
      await this.materialize(
        workspace,
        snapshot,
        acknowledged.flatMap((admission) => admission.requestDigest ? [admission.requestDigest] : []),
      );
      await this.deps.trees.updateSyncMetadata({
        ...placement,
        ref: current.tree.root,
        update: current.tree.update,
        access: current.tree.access === "none" ? "read" : current.tree.access,
      });
      await this.confirmMaterialized(
        workspace,
        client,
        remoteTrees,
        current.tree.root,
        "Materialized editor admission does not match its accepted Canopy root",
      );
      await retireAcknowledgedEditorAdmissions(workspace.tree, acknowledged);
      this.dispatch(workspace.tree, { type: "applied" });
      placement = {
        ...placement,
        ref: current.tree.root,
        update: current.tree.update,
        access: current.tree.access === "none" ? "read" : current.tree.access,
      };
    });
    return placement;
  }

  /** The unacknowledged chain of the earliest open editor epoch, as the machine's request identity. */
  private async editorRequest(tree: string): Promise<{ request: PreparedRequest; chain: FrozenEditorAdmission[] } | undefined> {
    const admissions = await pendingEditorAdmissions(tree);
    const firstIndex = admissions.findIndex((admission) => !admission.acknowledged);
    const first = admissions[firstIndex];
    if (!first) return undefined;
    const nextEpoch = admissions.findIndex((admission, index) => index > firstIndex && admission.id !== first.id);
    const prefix = admissions.slice(0, nextEpoch < 0 ? admissions.length : nextEpoch);
    const chain = prefix.filter((admission) => admission.id === first.id);
    const digests = chain.map((admission) => admission.requestDigest ?? `${admission.id}:${admission.request.candidate}`);
    return {
      chain,
      request: {
        id: digests.at(-1)!,
        base: first.request.base,
        candidate: chain.at(-1)!.request.candidate,
        digests,
      },
    };
  }

  private async prepareEditorRequest(tree: string): Promise<void> {
    const prepared = await this.editorRequest(tree);
    if (!prepared) {
      // Nothing unacknowledged remains: the head equals the accepted base.
      const state = this.syncStateFor(tree);
      if (state.kind === "locally-pending") this.dispatch(tree, { type: "localHead", root: state.base.root, origin: "editor" });
      return;
    }
    this.dispatch(tree, { type: "requestPersisted", request: prepared.request });
  }

  /**
   * Publish frozen editor generations through the direct synchronization
   * machine. A new durable candidate updates one unsent head and resets the
   * trailing publication delay; a request already in flight retains the head
   * as its successor instead of posting a concurrent longer prefix. Explicit
   * synchronization (`now`) bypasses the delay and awaits the in-flight push.
   */
  async publishEditorAdmissions(tree: string, client: WireClient, options: { now?: boolean } = {}): Promise<void> {
    this.pushClients.set(tree, client);
    const prepared = await this.editorRequest(tree);
    if (!prepared) {
      await this.pushes.get(tree);
      return;
    }
    const state = this.ensureMachine(tree);
    if (state.kind === "offline") this.dispatch(tree, { type: "transportAvailable", available: true });
    this.dispatch(tree, { type: "localHead", root: prepared.request.candidate, origin: "editor" });
    if (options.now) {
      const now = this.syncStateFor(tree);
      if (now.kind === "locally-pending" && !now.preparing) this.dispatch(tree, { type: "maxDelayElapsed" });
      // Preparation and submission are asynchronous; wait for the push they start.
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 0));
      await this.pushes.get(tree);
    }
  }

  /** Send exactly one request for the tree's current chain; mark it transmitted first. */
  private pushEditorChain(tree: string, request: PreparedRequest): Promise<void> {
    const existing = this.pushes.get(tree);
    if (existing) return existing;
    const client = this.pushClients.get(tree);
    if (!client) return Promise.resolve();
    const push = (async () => {
      const prepared = await this.editorRequest(tree);
      if (!prepared || prepared.request.id !== request.id) return;
      const { chain } = prepared;
      const first = chain[0]!;
      await markEditorAdmissionsTransmitted(tree, first.id, chain.map((admission) => admission.request.candidate));
      this.dispatch(tree, { type: "submitStarted", id: request.id });
      try {
        const response = await client.submitUpdates(tree, {
          base: first.request.base,
          updates: chain.map((admission) => decodeCandidateUpdateJSON(admission.request)),
        });
        await acknowledgePendingEditorAdmissions(
          tree,
          first.id,
          chain.map((admission) => admission.request.candidate),
        );
        const final = response.results.at(-1)!;
        this.dispatch(tree, {
          type: "accepted",
          id: request.id,
          result: {
            kind: final.outcome,
            root: final.update.root,
            update: final.update.id,
            digests: response.results.map((result) => result.requestDigest),
          },
        });
        // For Arbor Sync the durable acknowledgement is the apply boundary of
        // the editor path: the accepted decision is retained locally and on
        // Canopy, and the ordinary pass materializes disk once every open
        // epoch is acknowledged. A retained successor may publish now.
        this.dispatch(tree, { type: "applied" });
        void this.deps.requestSync().catch(() => {});
      } catch (error) {
        if (!(error instanceof WireUpdateConflict)) {
          this.dispatch(tree, { type: "transportFailed", id: request.id });
          throw error;
        }
        await acknowledgePendingEditorAdmissions(
          tree,
          first.id,
          chain.slice(0, error.result.details.completed.length).map((admission) => admission.request.candidate),
        );
        await saveTreeConflict(tree, error.result);
        this.deps.trees.setSyncState(tree, "conflict");
        this.conflicts.add(tree);
        this.dispatch(tree, {
          type: "conflicted",
          id: request.id,
          conflict: {
            current: { root: error.result.details.current.root, update: error.result.details.current.id },
            localRoot: request.candidate,
          },
        });
        this.deps.events.emit({
          tree,
          kind: "diagnostic",
          ref: { tree, path: first.ref.path, stableKey: first.ref.stableKey },
          origin: "sync",
        });
      }
    })().finally(() => {
      if (this.pushes.get(tree) === push) this.pushes.delete(tree);
    });
    this.pushes.set(tree, push);
    return push;
  }

  async updateWorkspace(
    workspace: W,
    initialPlacement: SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
    options: { publishNow?: boolean } = {},
  ): Promise<void> {
    const { trees } = this.deps;
    trees.setSyncState(workspace.tree, "syncing");
    if (this.ensureMachine(workspace.tree).kind === "offline") {
      // Each pass is a reconnection probe for a request whose transport failed.
      this.dispatch(workspace.tree, { type: "transportAvailable", available: true });
    }
    let placement = await this.submitEditorAdmissions(workspace, initialPlacement, client, remoteTrees, options.publishNow ?? false);
    if (await treeConflict(workspace.tree)) {
      trees.setSyncState(workspace.tree, "conflict");
      this.conflicts.add(workspace.tree);
      return;
    }
    const retainedEditorAdmissions = await pendingEditorAdmissions(workspace.tree);
    if (retainedEditorAdmissions.some((admission) => !admission.acknowledged)) {
      // Editor admissions are already durable and represent the earliest
      // authored order. Do not let a filesystem snapshot overtake them and
      // turn same-device edits into artificial three-way merges. The pending
      // publication requests the next pass when its request resolves.
      return;
    }
    if (await this.applyQueuedTransitions(workspace, placement, client, remoteTrees)) return;
    const current = await client.descriptor(workspace.tree);
    const remote = current.tree;
    if (!remote.update) throw new Error("Server does not advertise accepted updates for this tree");
    if (
      placement.access !== remote.access
      || (placement.ref === remote.root && placement.update !== remote.update)
    ) {
      placement = {
        ...placement,
        access: remote.access === "none" ? "read" : remote.access,
        ...(placement.ref === remote.root ? { update: remote.update } : {}),
      };
      await trees.updateSyncMetadata(placement);
    }
    if (await treeConflict(workspace.tree)) {
      trees.setSyncState(workspace.tree, "conflict");
      this.conflicts.add(workspace.tree);
      return;
    }
    let pending = await pendingTreeUpdate(workspace.tree);
    let local = await this.snapshotWorkspace(workspace, client, remoteTrees);
    if (!placement.ref || !placement.update) {
      if (local.root === remote.root) {
        await trees.updateSyncMetadata({ ...placement, ref: remote.root, update: remote.update });
        await saveAcceptedTreeObjects(workspace.tree, local);
        trees.setSyncState(workspace.tree, "idle");
        this.conflicts.delete(workspace.tree);
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
      await this.pullCurrent(workspace, placement, client, remoteTrees, current);
      return;
    }
    if (local.root === remote.root) {
      await trees.updateSyncMetadata({ ...placement, ref: remote.root, update: remote.update });
      await saveAcceptedTreeObjects(workspace.tree, local);
      if (pending) await clearPendingTreeUpdate(workspace.tree);
      trees.setSyncState(workspace.tree, "idle");
      this.conflicts.delete(workspace.tree);
      return;
    }
    if (!pending && local.root === placement.ref) {
      // Clean but behind: read the current state rather than proposing a
      // candidate the authority would only report as superseded.
      await this.pullCurrent(workspace, placement, client, remoteTrees, current, local);
      return;
    }
    const filesystemIsEditorMirror = this.filesystemIsEditorMirror(workspace.tree, retainedEditorAdmissions);
    if (filesystemIsEditorMirror && pending?.origin !== "local-api") {
      // Editor admissions are the sole local source during this epoch. Bytes
      // materialized from an earlier accepted prefix must not be frozen as a
      // fresh filesystem candidate and sent back to Canopy. A root this
      // process actually materialized may advance; any other divergence is
      // unsafe to overwrite and requires explicit reconciliation.
      if (pending) await clearPendingTreeUpdate(workspace.tree);
      if (this.lastMaterializedRoots.get(workspace.tree) === local.root) {
        await this.pullCurrent(workspace, placement, client, remoteTrees, current);
        return;
      }
      trees.setSyncState(workspace.tree, "conflict");
      const firstConflict = !this.conflicts.has(workspace.tree);
      this.conflicts.add(workspace.tree);
      if (firstConflict) {
        this.deps.events.emit({
          tree: workspace.tree,
          kind: "diagnostic",
          ref: { tree: workspace.tree, path: "/", stableKey: null },
          origin: "sync",
        });
      }
      return;
    }
    if (placement.access !== "write") {
      trees.setSyncState(workspace.tree, "conflict");
      return;
    }
    if (!pending) {
      const retained = await acceptedTreeObjects(workspace.tree);
      const retainedHashes = retained?.root === placement.ref ? new Set(retained.hashes) : new Set<ObjectHash>();
      pending = pendingFromSnapshot(placement.update, local, retainedHashes);
      await savePendingTreeUpdate(workspace.tree, pending);
    }

    for (let generation = 0; generation < 4; generation++) {
      try {
        const result = await client.submitUpdate(
          workspace.tree,
          pending.base,
          snapshotFromPending(pending),
          { deltas: deltasFromPending(pending) },
        );
        const accepted = result.update;
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
            for (const delta of pending.deltas ?? []) retainedHashes.add(delta.result);
            placement = {
              ...placement,
              ref: accepted.root,
              update: accepted.id,
            };
            await trees.updateSyncMetadata(placement);
            await saveAcceptedTreeObjectHashes(workspace.tree, {
              root: accepted.root,
              hashes: [...retainedHashes],
            });
            pending = pendingFromSnapshot(accepted.id, local, retainedHashes, pending.origin);
          } else {
            const retained = await acceptedTreeObjects(workspace.tree);
            const retainedHashes = retained && retained.root === placement.ref
              ? new Set(retained.hashes)
              : new Set<ObjectHash>();
            pending = pendingFromSnapshot(pending.base, local, retainedHashes, pending.origin);
          }
          await savePendingTreeUpdate(workspace.tree, pending);
          continue;
        }
        await this.deps.withWorkspaceIO(workspace, async () => {
          if (accepted.root !== pending!.candidate) {
            if (!result.reconciliation) throw new Error("Server omitted a required reconciliation transition");
            await this.materialize(workspace, {
              root: accepted.root,
              objects: applyTransitionPayload(local.objects, result.reconciliation),
            });
          }
          await trees.updateSyncMetadata({
            ...placement,
            ref: accepted.root,
            update: accepted.id,
          });
          await this.confirmMaterialized(workspace, client, remoteTrees, accepted.root, "Materialized accepted tree does not match its server root");
        });
        return;
      } catch (error) {
        if (error instanceof WireUpdateConflict) {
          await saveTreeConflict(workspace.tree, error.result);
          await clearPendingTreeUpdate(workspace.tree);
          trees.setSyncState(workspace.tree, "conflict");
          const firstConflict = !this.conflicts.has(workspace.tree);
          this.conflicts.add(workspace.tree);
          if (firstConflict) {
            this.deps.events.emit({ tree: workspace.tree, kind: "diagnostic", ref: { tree: workspace.tree, path: "/", stableKey: null }, origin: "sync" });
          }
          return;
        }
        throw error;
      }
    }
    throw new Error("Local tree kept changing while an accepted update was being applied");
  }
}
