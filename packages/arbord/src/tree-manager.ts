import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Diagnostic, TreeDescriptor } from "@arbor/core";
import {
  AmbiguousWorkspaceIdentityError,
  arborDataHomeDiagnostics,
  legacySystemRootsExist,
  loadTreeRegistry,
  type TreePlacement,
  privateRootID,
  saveSharedTreePlacement,
  watchTreeRegistry,
  workspaceIdentity,
  type SharedTreePlacement,
} from "@arbor/stores";
import type { EventBus } from "./events.ts";
import { rootDisplayName } from "./root-title.ts";
import { Workspace, type WorkspaceOptions } from "./workspace.ts";

interface KnownRoot {
  placement?: TreePlacement;
  osPath: string;
  missing: boolean;
  name: string;
}

interface CandidateRoot extends KnownRoot {
  id: string;
  placement: TreePlacement;
}

/**
 * Owns legacy and shared entries in `~/.arbor/trees.yaml` and the private
 * Workspace instances behind one shared event bus. Private workspace IDs
 * are never projected as durable public identity for unpromoted content.
 */
export class TreeManager implements AsyncDisposable {
  private workspaces = new Map<string, Workspace>();
  private known = new Map<string, KnownRoot>();
  private sessionID: string | null = null;
  private recordDiagnostics: Diagnostic[] = [];
  private syncStates = new Map<string, NonNullable<TreeDescriptor["sync"]>>();
  private workspaceOptions: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {};
  private stopWatching?: () => void;
  private reloadTail: Promise<void> = Promise.resolve();

  constructor(readonly events: EventBus) {}

  async init(): Promise<void> {
    const snapshot = await loadTreeRegistry();
    this.recordDiagnostics = [...arborDataHomeDiagnostics(), ...snapshot.diagnostics];
    if (await legacySystemRootsExist()) {
      this.recordDiagnostics.push({
        code: "legacy-system-roots",
        message: "Legacy system/roots/*.md records are unsupported; convert them manually to path-keyed trees.yaml entries",
        path: "system:trees",
        severity: "warning",
      });
    }
    if (!snapshot.diagnostics.length) await this.applyPlacements(snapshot.placements, false);
    this.stopWatching = await watchTreeRegistry(() => {
      this.reloadTail = this.reloadTail.then(() => this.reloadFromDisk()).catch(() => {});
    });
  }

  private async candidate(placement: TreePlacement): Promise<CandidateRoot> {
    let osPath = placement.path;
    let missing = false;
    try {
      const canonical = await realpath(placement.path);
      const info = await stat(canonical);
      if (!info.isDirectory()) missing = true;
      else if (canonical !== placement.path) {
        throw new Error(`Tree placement key is not canonical: ${placement.path} resolves to ${canonical}`);
      } else {
        osPath = canonical;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Tree placement key is not canonical:")) throw error;
      missing = true;
    }
    const id = placement.source === "local"
      ? (missing ? await privateRootID(placement.path) : (await workspaceIdentity(osPath)).rootID)
      : placement.tree;
    return {
      id,
      placement,
      osPath,
      missing,
      name: missing ? basename(osPath) : await rootDisplayName(osPath),
    };
  }

  private validateCandidates(candidates: CandidateRoot[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.missing) {
        diagnostics.push({
          code: "missing-root-path",
          message: `Tree placement path does not resolve: ${candidate.osPath}`,
          path: candidate.osPath,
          severity: "warning",
        });
      }
      if (ids.has(candidate.id)) {
        diagnostics.push({
          code: "ambiguous-tree-move",
          message: `Several tree placements resolve to private root ${candidate.id}; Arbor will not guess which path owns it`,
          path: candidate.placement.path,
          severity: "warning",
        });
      }
      ids.add(candidate.id);
    }
    // Nested shared-tree placements are real authority boundaries. Exact
    // duplicates are rejected by the ID/path checks above; longest-prefix
    // resolution chooses the innermost tree for local operations.
    for (const candidate of candidates) {
      const open = this.workspaces.get(candidate.id);
      if (open && open.root !== candidate.osPath && candidate.id === this.sessionID) {
        diagnostics.push({
          code: "active-tree-repath",
          message: `The active session tree moved from ${open.root} to ${candidate.osPath}; restart arbord to rebind it safely`,
          path: candidate.osPath,
          severity: "warning",
        });
      }
    }
    return diagnostics;
  }

  private async applyPlacements(placements: TreePlacement[], publish: boolean): Promise<boolean> {
    let candidates: CandidateRoot[];
    try {
      candidates = await Promise.all(placements.map((placement) => this.candidate(placement)));
    } catch (error) {
      this.recordDiagnostics = [{
        code: error instanceof AmbiguousWorkspaceIdentityError ? "ambiguous-tree-move" : "invalid-tree-placement",
        message: error instanceof Error ? error.message : String(error),
        path: "system:trees",
        severity: "warning",
      }];
      return false;
    }
    const diagnostics = this.validateCandidates(candidates);
    if (diagnostics.length) {
      this.recordDiagnostics = diagnostics;
      return false;
    }

    const previousSessionID = this.sessionID;
    const previousSession = previousSessionID ? this.workspaces.get(previousSessionID) : undefined;
    const reboundSession = previousSession
      ? candidates.find((candidate) => candidate.osPath === previousSession.root && candidate.id !== previousSessionID)
      : undefined;
    if (previousSessionID && previousSession && reboundSession) {
      await previousSession[Symbol.asyncDispose]();
      this.workspaces.delete(previousSessionID);
      this.known.delete(previousSessionID);
      this.sessionID = reboundSession.id;
    }

    const nextIDs = new Set(candidates.map((candidate) => candidate.id));
    for (const [id, root] of [...this.known]) {
      if (!root.placement || nextIDs.has(id)) continue;
      const open = this.workspaces.get(id);
      if (open && id === this.sessionID) {
        open.tracking = "session";
        root.placement = undefined;
      } else {
        if (open) await open[Symbol.asyncDispose]();
        this.workspaces.delete(id);
        this.known.delete(id);
      }
    }

    for (const candidate of candidates) {
      const open = this.workspaces.get(candidate.id);
      if (open && open.root !== candidate.osPath) {
        await open[Symbol.asyncDispose]();
        this.workspaces.delete(candidate.id);
      }
      this.known.set(candidate.id, {
        placement: candidate.placement,
        osPath: candidate.osPath,
        missing: candidate.missing,
        name: candidate.name,
      });
      if (open) {
        open.tracking = "tracked";
        open.updateTreeDescriptor(candidate.placement.source === "local" ? {
          legacy: true,
        } : {
          canonical: candidate.placement.canonical,
          httpURL: `${candidate.placement.endpoint}/${new URL(candidate.placement.canonical).pathname.split("/").filter(Boolean)[0] ?? ""}`,
          endpoint: candidate.placement.endpoint,
          publication: candidate.placement.publication ?? "private",
          access: candidate.placement.access,
          placement: "shared",
          legacy: false,
        });
      }
    }
    if (reboundSession) {
      const root = this.known.get(reboundSession.id);
      if (!root) throw new Error(`Could not rebind the active session to ${reboundSession.id}`);
      await this.open(reboundSession.id, root);
    }
    this.recordDiagnostics = [...arborDataHomeDiagnostics()];
    if (await legacySystemRootsExist()) {
      this.recordDiagnostics.push({
        code: "legacy-system-roots",
        message: "Legacy system/roots/*.md records are unsupported; convert them manually to path-keyed trees.yaml entries",
        path: "system:trees",
        severity: "warning",
      });
    }
    if (publish) {
      this.events.emit({ tree: "system", kind: "updated", path: "/trees", origin: "external" });
    }
    return true;
  }

  private async reloadFromDisk(): Promise<void> {
    const snapshot = await loadTreeRegistry();
    if (snapshot.diagnostics.length) {
      this.recordDiagnostics = [...arborDataHomeDiagnostics(), ...snapshot.diagnostics];
      this.events.emit({ tree: "system", kind: "diagnostic", path: "/trees", origin: "external" });
      return;
    }
    await this.applyPlacements(snapshot.placements, true);
  }

  async openSession(path: string, options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {}): Promise<Workspace> {
    this.workspaceOptions = options;
    const canonical = await realpath(path);
    const trackedEntry = [...this.known.entries()].find(([, root]) =>
      !root.missing && root.placement
      && (root.osPath === canonical || canonical.startsWith(root.osPath.endsWith("/") ? root.osPath : `${root.osPath}/`))
    );
    const trackedID = trackedEntry?.[0];
    const tracked = trackedEntry?.[1];
    const workspace = await Workspace.open(tracked?.osPath ?? canonical, {
      ...options,
      events: this.events,
      tree: trackedID,
      displayName: tracked?.name,
      tracking: tracked ? "tracked" : "session",
      treeDescriptor: tracked?.placement?.source === "local" ? { legacy: true } : tracked?.placement ? {
        canonical: tracked.placement.canonical,
        httpURL: `${tracked.placement.endpoint}/${new URL(tracked.placement.canonical).pathname.split("/").filter(Boolean)[0] ?? ""}`,
        endpoint: tracked.placement.endpoint,
        publication: tracked.placement.publication ?? "private",
        access: tracked.placement.access,
        placement: "shared",
      } : undefined,
    });
    this.sessionID = workspace.tree;
    this.workspaces.set(workspace.tree, workspace);
    if (!tracked) {
      this.known.set(workspace.tree, {
        osPath: workspace.root,
        missing: false,
        name: workspace.descriptor().name,
      });
    }
    return workspace;
  }

  get session(): Workspace {
    const workspace = this.sessionID ? this.workspaces.get(this.sessionID) : undefined;
    if (!workspace) throw new Error("The session root is not open");
    return workspace;
  }

  async workspaceByTree(tree: string): Promise<Workspace | undefined> {
    const open = this.workspaces.get(tree);
    if (open) return open;
    const root = this.known.get(tree);
    if (!root?.placement || root.missing) return undefined;
    return this.open(tree, root);
  }

  private async open(tree: string, root: KnownRoot): Promise<Workspace> {
    const workspace = await Workspace.open(root.osPath, {
      ...this.workspaceOptions,
      events: this.events,
      tree,
      displayName: root.name,
      tracking: "tracked",
      treeDescriptor: root.placement?.source === "local" ? { legacy: true } : root.placement ? {
        canonical: root.placement.canonical,
        httpURL: `${root.placement.endpoint}/${new URL(root.placement.canonical).pathname.split("/").filter(Boolean)[0] ?? ""}`,
        endpoint: root.placement.endpoint,
        publication: root.placement.publication ?? "private",
        access: root.placement.access,
        placement: "shared",
      } : undefined,
    });
    this.workspaces.set(tree, workspace);
    return workspace;
  }

  list(): Workspace[] {
    return [...this.workspaces.values()];
  }

  async openAll(): Promise<Workspace[]> {
    for (const [tree, root] of this.known) {
      if (!this.workspaces.has(tree) && root.placement && !root.missing) {
        await this.open(tree, root);
      }
    }
    return this.list();
  }

  async descriptors(): Promise<TreeDescriptor[]> {
    await Promise.all([...this.known.entries()].map(async ([id, root]) => {
      const workspace = this.workspaces.get(id);
      if (workspace && workspace.root === root.osPath) {
        root.name = await workspace.refreshDisplayName();
      } else if (!root.missing) {
        root.name = await rootDisplayName(root.osPath);
      }
    }));
    return [...this.known.entries()].filter(([, root]) => Boolean(root.placement)).map(([id, root]): TreeDescriptor => ({
      id,
      name: this.workspaces.get(id)?.descriptor().name ?? root.name,
      osPath: root.osPath,
      placement: root.placement?.source === "local" || !root.placement ? "local" : "shared",
      ...(root.placement?.source === "local" ? { legacy: true } : {}),
      ...(root.placement && root.placement.source !== "local" ? {
        canonical: root.placement.canonical,
        httpURL: `${root.placement.endpoint}/${new URL(root.placement.canonical).pathname.split("/").filter(Boolean)[0] ?? ""}`,
        endpoint: root.placement.endpoint,
        publication: root.placement.publication ?? "private",
        access: root.placement.access,
        sync: this.syncStates.get(id) ?? "idle",
      } : {}),
      ...(root.missing ? { missing: true } : {}),
    }));
  }

  diagnostics(): Diagnostic[] {
    const missing = [...this.known.entries()]
      .filter(([, root]) => root.missing)
      .map(([tree, root]): Diagnostic => ({
        code: "missing-root-path",
        message: `Shared tree ${tree} placement path does not resolve`,
        path: root.osPath,
        severity: "warning",
      }));
    return [...this.recordDiagnostics, ...missing];
  }

  async ownerOf(osPath: string): Promise<{ workspace: Workspace; treePath: string } | null> {
    let best: { tree: string; root: KnownRoot } | null = null;
    for (const [tree, root] of this.known) {
      if (root.missing || !root.placement) continue;
      const prefix = root.osPath.endsWith("/") ? root.osPath : `${root.osPath}/`;
      if (osPath !== root.osPath && !osPath.startsWith(prefix)) continue;
      if (best && best.root.osPath.length >= root.osPath.length) continue;
      best = { tree, root };
    }
    if (!best) return null;
    const workspace = this.workspaces.get(best.tree) ?? await this.open(best.tree, best.root);
    const remainder = osPath === best.root.osPath ? "/" : osPath.slice(best.root.osPath.length);
    return { workspace, treePath: remainder.startsWith("/") ? remainder : `/${remainder}` };
  }

  placementFor(tree: string): TreePlacement | undefined {
    return this.known.get(tree)?.placement;
  }

  sharedPlacements(): SharedTreePlacement[] {
    return [...this.known.values()].flatMap((root) =>
      root.placement && root.placement.source !== "local" ? [root.placement] : []
    );
  }

  setSyncState(tree: string, state: NonNullable<TreeDescriptor["sync"]>): void {
    this.syncStates.set(tree, state);
  }

  sharedBoundariesWithin(osPath: string): Map<string, string> {
    const result = new Map<string, string>();
    const prefix = osPath.endsWith("/") ? osPath : `${osPath}/`;
    for (const [tree, root] of this.known) {
      if (root.placement?.source === "local" || !root.placement || root.missing) continue;
      if (root.osPath.startsWith(prefix)) result.set(root.osPath, tree);
    }
    return result;
  }

  async applySharedPlacement(placement: SharedTreePlacement): Promise<TreeDescriptor> {
    await saveSharedTreePlacement(placement);
    const snapshot = await loadTreeRegistry();
    if (snapshot.diagnostics.length || !(await this.applyPlacements(snapshot.placements, true))) {
      throw new Error(`Could not activate shared tree placement at ${placement.path}`);
    }
    return (await this.descriptorFor(placement.tree))!;
  }

  private async descriptorFor(tree: string): Promise<TreeDescriptor | undefined> {
    return (await this.descriptors()).find((descriptor) => descriptor.id === tree);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stopWatching?.();
    await this.reloadTail.catch(() => {});
    for (const workspace of this.workspaces.values()) {
      await workspace[Symbol.asyncDispose]();
    }
    this.workspaces.clear();
  }
}
