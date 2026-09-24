import type { TreeID, WorkspaceChange, WorkspaceEvent } from "@overstory/protocol";

/**
 * The daemon-owned objects the Canopy client needs, expressed as narrow ports
 * so the client stays a library the daemon imports rather than a slice of it.
 */

/** Where account bootstrap reports observed changes and diagnostics. */
export interface SyncEventSink {
  emit(event: { tree: WorkspaceEvent["tree"]; kind: WorkspaceEvent["kind"] } & WorkspaceChange): unknown;
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
}
