import type { LocalTreeDescriptor, TreeID, WorkspaceChange, WorkspaceEvent } from "@arbor/core";
import type { CommunityConfigStore, SharedTreePlacement, TreePlacement } from "@arbor/stores";

/**
 * The daemon-owned objects the Canopy client needs, expressed as narrow ports
 * so the client stays a library the daemon imports rather than a slice of it.
 */

/** The part of a placed workspace the synchronizer reads: its tree and on-disk root. */
export interface SyncWorkspace {
  readonly tree: TreeID;
  readonly root: string;
}

/** Where the synchronizer reports observed changes and diagnostics. */
export interface SyncEventSink {
  emit(event: { tree: WorkspaceEvent["tree"]; kind: WorkspaceEvent["kind"] } & WorkspaceChange): unknown;
}

/** Placement metadata the synchronizer reads and advances. */
export interface PlacementRegistry {
  placementFor(tree: string): TreePlacement | undefined;
  setSyncState(tree: string, state: NonNullable<LocalTreeDescriptor["sync"]>): void;
  updateSyncMetadata(placement: SharedTreePlacement): Promise<LocalTreeDescriptor>;
  /** Nested tree mounts beneath one OS path, which materialization must leave alone. */
  excludedMountsWithin(osPath: string): string[];
}

/** What account bootstrap needs from the daemon's tree registry. */
export interface AccountTreeRegistry {
  openSession(path: string): Promise<{ readonly tree: TreeID }>;
  refreshConfiguration(): Promise<void>;
  invalidateDescriptors(): void;
}

export interface AccountBootstrapDeps {
  trees: AccountTreeRegistry;
  events: SyncEventSink;
  communityConfig: CommunityConfigStore;
}
