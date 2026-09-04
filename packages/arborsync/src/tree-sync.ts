import type { SharedTreePlacement } from "@arbor/stores";
import {
  WireClient,
  WireUpdateConflict,
  applyTransitionPayload,
  decodeWireObject,
  type CurrentTree,
  type ObjectHash,
  type RemoteTreeDescriptor,
  type TreeSnapshot,
  type WatchEvent,
} from "@arbor/wire";
import type { EventBus } from "./events.ts";
import type { TreeManager } from "./tree-manager.ts";
import { ProtocolError, type Workspace } from "./workspace.ts";
import {
  acceptedTreeObjects,
  clearPendingEditorAdmission,
  clearPendingTreeUpdate,
  clearTreeConflict,
  deltasFromPending,
  pendingFromSnapshot,
  pendingEditorAdmissions,
  pendingTreeUpdate,
  saveAcceptedTreeObjectHashes,
  saveAcceptedTreeObjects,
  savePendingTreeUpdate,
  saveTreeConflict,
  snapshotFromPending,
  treeConflict,
} from "./sync-state.ts";
import { materializeTree } from "@arbor/fs";

export interface TreeSyncDeps {
  trees: TreeManager;
  events: EventBus;
  accountToken(placement: SharedTreePlacement): Promise<string | undefined>;
  /** Serialize only local filesystem reads/writes for one tree; never hold this across Wire I/O. */
  withWorkspaceIO<T>(workspace: Workspace, run: () => Promise<T>): Promise<T>;
  snapshotWorkspace(workspace: Workspace, client: WireClient, remoteTrees?: readonly RemoteTreeDescriptor[]): Promise<TreeSnapshot>;
  /** Schedule one coalesced synchronization pass; resolves when a pass covering the request completes. */
  requestSync(): Promise<void>;
}

type TreeRefWatchEvent = Extract<WatchEvent, { kind: "tree.update" }>;

const INITIAL_WATCH_BACKOFF_MS = 1_000;
const MAX_WATCH_BACKOFF_MS = 30_000;

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
export class TreeSynchronizer {
  readonly conflicts = new Set<string>();
  private readonly queued = new Map<string, TreeRefWatchEvent[]>();
  private readonly watches = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closed = false;

  constructor(private readonly deps: TreeSyncDeps) {}

  private snapshotWorkspace(
    workspace: Workspace,
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

  private async materialize(workspace: Workspace, snapshot: TreeSnapshot): Promise<void> {
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

  /** Verify the on-disk tree matches the accepted root, then record it as the accepted base. */
  private async confirmMaterialized(
    workspace: Workspace,
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
    workspace: Workspace,
    placement: SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
    descriptor?: CurrentTree,
  ): Promise<void> {
    const { current, snapshot } = await this.readSnapshot(client, workspace.tree, descriptor);
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
    workspace: Workspace,
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
      await this.materialize(workspace, { root: final.update.root, objects });
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
   * tree. Once every queued decision is durable on Canopy, materialize the
   * final accepted snapshot only when the disk still equals its accepted base;
   * otherwise the ordinary filesystem path submits that independent change.
   */
  private async submitEditorAdmissions(
    workspace: Workspace,
    placement: SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
  ): Promise<SharedTreePlacement> {
    const admissions = await pendingEditorAdmissions(workspace.tree);
    if (!admissions.length) return placement;
    if (placement.access !== "write") {
      this.deps.trees.setSyncState(workspace.tree, "conflict");
      return placement;
    }
    for (const admission of admissions) {
      try {
        await client.submitUpdate(
          workspace.tree,
          admission.request.base,
          snapshotFromPending(admission.request),
          { deltas: deltasFromPending(admission.request) },
        );
        await clearPendingEditorAdmission(workspace.tree, admission.id, admission.request.candidate);
      } catch (error) {
        if (error instanceof WireUpdateConflict) {
          await saveTreeConflict(workspace.tree, error.result);
          this.deps.trees.setSyncState(workspace.tree, "conflict");
          this.conflicts.add(workspace.tree);
          this.deps.events.emit({
            tree: workspace.tree,
            kind: "diagnostic",
            ref: { tree: workspace.tree, path: admission.ref.path, stableKey: admission.ref.stableKey },
            origin: "sync",
          });
          return placement;
        }
        throw error;
      }
    }

    const local = await this.snapshotWorkspace(workspace, client, remoteTrees);
    if (!placement.ref || local.root !== placement.ref) return placement;
    const { current, snapshot } = await this.readSnapshot(client, workspace.tree);
    await this.deps.withWorkspaceIO(workspace, async () => {
      // Recheck after network I/O. A local editor or external process may have
      // changed the disk while the accepted snapshot was being fetched.
      const stillClean = await this.deps.snapshotWorkspace(workspace, client, remoteTrees);
      if (stillClean.root !== placement.ref) return;
      await this.materialize(workspace, snapshot);
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
      placement = {
        ...placement,
        ref: current.tree.root,
        update: current.tree.update,
        access: current.tree.access === "none" ? "read" : current.tree.access,
      };
    });
    return placement;
  }

  async updateWorkspace(
    workspace: Workspace,
    initialPlacement: SharedTreePlacement,
    client: WireClient,
    remoteTrees: readonly RemoteTreeDescriptor[],
  ): Promise<void> {
    const { trees } = this.deps;
    trees.setSyncState(workspace.tree, "syncing");
    let placement = await this.submitEditorAdmissions(workspace, initialPlacement, client, remoteTrees);
    if (await treeConflict(workspace.tree)) {
      trees.setSyncState(workspace.tree, "conflict");
      this.conflicts.add(workspace.tree);
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
      await this.pullCurrent(workspace, placement, client, remoteTrees, current);
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
            pending = pendingFromSnapshot(accepted.id, local, retainedHashes);
          } else {
            const retained = await acceptedTreeObjects(workspace.tree);
            const retainedHashes = retained && retained.root === placement.ref
              ? new Set(retained.hashes)
              : new Set<ObjectHash>();
            pending = pendingFromSnapshot(pending.base, local, retainedHashes);
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
