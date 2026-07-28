import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Diagnostic, RootDescriptor, RootID } from "@arbor/core";
import {
  AmbiguousWorkspaceIdentityError,
  arborDataHomeDiagnostics,
  deleteTreePlacement,
  legacySystemRootsExist,
  loadTreeRegistry,
  type LocalTreePlacement,
  privateRootID,
  saveLocalTreePlacement,
  watchTreeRegistry,
  workspaceIdentity,
} from "@arbor/stores";
import type { EventBus } from "./events.ts";
import { rootDisplayName } from "./root-title.ts";
import { ProtocolError, Workspace, type WorkspaceOptions } from "./workspace.ts";

export interface SystemRootProjection {
  id: RootID;
  path: string;
  name: string;
  source: string;
}

interface KnownRoot {
  placement?: LocalTreePlacement;
  osPath: string;
  missing: boolean;
  name: string;
}

interface CandidateRoot extends KnownRoot {
  id: RootID;
  placement: LocalTreePlacement;
}

/**
 * Owns the local-source entries in `~/.arbor/trees.yaml` and the per-root
 * Workspace instances behind one shared event bus. RootIDs remain private
 * compatibility scope tags; the human registry is keyed only by paths.
 */
export class RootManager implements AsyncDisposable {
  private workspaces = new Map<RootID, Workspace>();
  private known = new Map<RootID, KnownRoot>();
  private sessionID: RootID | null = null;
  private recordDiagnostics: Diagnostic[] = [];
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
        path: "system:roots",
        severity: "warning",
      });
    }
    if (!snapshot.diagnostics.length) await this.applyPlacements(snapshot.placements, false);
    this.stopWatching = await watchTreeRegistry(() => {
      this.reloadTail = this.reloadTail.then(() => this.reloadFromDisk()).catch(() => {});
    });
  }

  private async candidate(placement: LocalTreePlacement): Promise<CandidateRoot> {
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
    const id = missing ? await privateRootID(placement.path) : (await workspaceIdentity(osPath)).rootID;
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
    const ids = new Set<RootID>();
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
    const live = candidates.filter((candidate) => !candidate.missing);
    for (let index = 0; index < live.length; index += 1) {
      for (let other = index + 1; other < live.length; other += 1) {
        const left = live[index]!;
        const right = live[other]!;
        const leftPrefix = left.osPath.endsWith("/") ? left.osPath : `${left.osPath}/`;
        const rightPrefix = right.osPath.endsWith("/") ? right.osPath : `${right.osPath}/`;
        if (left.osPath.startsWith(rightPrefix) || right.osPath.startsWith(leftPrefix)) {
          diagnostics.push({
            code: "overlapping-tree-placements",
            message: `Tree placements overlap: ${left.osPath} and ${right.osPath}`,
            path: left.osPath,
            severity: "warning",
          });
        }
      }
    }
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

  private async applyPlacements(placements: LocalTreePlacement[], publish: boolean): Promise<boolean> {
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
      if (open) open.tracking = "tracked";
    }
    this.recordDiagnostics = [...arborDataHomeDiagnostics()];
    if (await legacySystemRootsExist()) {
      this.recordDiagnostics.push({
        code: "legacy-system-roots",
        message: "Legacy system/roots/*.md records are unsupported; convert them manually to path-keyed trees.yaml entries",
        path: "system:roots",
        severity: "warning",
      });
    }
    if (publish) {
      this.events.emit({ tree: "system", kind: "updated", path: "/roots", origin: "external" });
    }
    return true;
  }

  private async reloadFromDisk(): Promise<void> {
    const snapshot = await loadTreeRegistry();
    if (snapshot.diagnostics.length) {
      this.recordDiagnostics = [...arborDataHomeDiagnostics(), ...snapshot.diagnostics];
      this.events.emit({ tree: "system", kind: "diagnostic", path: "/roots", origin: "external" });
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

  async workspaceByTree(tree: RootID): Promise<Workspace | undefined> {
    const open = this.workspaces.get(tree);
    if (open) return open;
    const root = this.known.get(tree);
    if (!root?.placement || root.missing) return undefined;
    return this.open(tree, root);
  }

  private async open(tree: RootID, root: KnownRoot): Promise<Workspace> {
    const workspace = await Workspace.open(root.osPath, {
      ...this.workspaceOptions,
      events: this.events,
      tree,
      displayName: root.name,
      tracking: "tracked",
    });
    this.workspaces.set(tree, workspace);
    return workspace;
  }

  list(): Workspace[] {
    return [...this.workspaces.values()];
  }

  records(): SystemRootProjection[] {
    return [...this.known.entries()]
      .filter(([, root]) => Boolean(root.placement))
      .map(([id, root]) => ({
        id,
        path: root.placement!.path,
        name: this.workspaces.get(id)?.descriptor().name ?? root.name,
        source: [
          "---",
          `id: ${id}`,
          `path: ${JSON.stringify(root.placement!.path)}`,
          "---",
          "",
        ].join("\n"),
      }));
  }

  async openAll(): Promise<Workspace[]> {
    for (const [tree, root] of this.known) {
      if (!this.workspaces.has(tree) && root.placement && !root.missing) {
        await this.open(tree, root);
      }
    }
    return this.list();
  }

  async descriptors(): Promise<RootDescriptor[]> {
    await Promise.all([...this.known.entries()].map(async ([id, root]) => {
      const workspace = this.workspaces.get(id);
      if (workspace && workspace.root === root.osPath) {
        root.name = await workspace.refreshDisplayName();
      } else if (!root.missing) {
        root.name = await rootDisplayName(root.osPath);
      }
    }));
    return [...this.known.entries()].map(([id, root]) => ({
      id,
      name: this.workspaces.get(id)?.descriptor().name ?? root.name,
      osPath: root.osPath,
      tracking: root.placement ? "tracked" : "session",
      ...(root.missing ? { missing: true } : {}),
    }));
  }

  diagnostics(): Diagnostic[] {
    const missing = [...this.known.entries()]
      .filter(([, root]) => root.missing)
      .map(([tree, root]): Diagnostic => ({
        code: "missing-root-path",
        message: `Tracked root ${tree} path does not resolve`,
        path: root.osPath,
        severity: "warning",
      }));
    return [...this.recordDiagnostics, ...missing];
  }

  async ownerOf(osPath: string): Promise<{ workspace: Workspace; treePath: string } | null> {
    let best: { tree: RootID; root: KnownRoot } | null = null;
    for (const [tree, root] of this.known) {
      if (root.missing) continue;
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

  async track(inputPath: string): Promise<RootDescriptor> {
    let canonical: string;
    try {
      canonical = await realpath(inputPath);
      if (!(await stat(canonical)).isDirectory()) {
        throw new ProtocolError("invalid-reference", `${inputPath} is not a directory`, 400, { path: inputPath });
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("not-found", `Cannot track ${inputPath}`, 404, { path: inputPath });
    }
    for (const [tree, root] of this.known) {
      if (root.missing) continue;
      if (root.osPath === canonical) {
        if (!root.placement) {
          root.placement = await saveLocalTreePlacement(canonical);
          const workspace = this.workspaces.get(tree);
          if (workspace) workspace.tracking = "tracked";
        }
        return (await this.descriptorFor(tree))!;
      }
      const prefix = root.osPath.endsWith("/") ? root.osPath : `${root.osPath}/`;
      if (canonical.startsWith(prefix) || root.osPath.startsWith(`${canonical}/`)) {
        throw new ProtocolError(
          "unsupported-operation",
          `Tracking ${canonical} would nest with the existing root at ${root.osPath}; overlapping trees are not supported`,
          422,
          { path: canonical },
        );
      }
    }
    const identity = await workspaceIdentity(canonical);
    const placement = await saveLocalTreePlacement(canonical);
    this.known.set(identity.rootID, {
      placement,
      osPath: canonical,
      missing: false,
      name: await rootDisplayName(canonical),
    });
    return (await this.descriptorFor(identity.rootID))!;
  }

  async untrack(id: RootID): Promise<void> {
    const root = this.known.get(id);
    if (!root?.placement) {
      throw new ProtocolError("not-found", `No tracked root ${id}`, 404);
    }
    await deleteTreePlacement(root.placement.path);
    root.placement = undefined;
    const workspace = this.workspaces.get(id);
    if (workspace) {
      if (id === this.sessionID) workspace.tracking = "session";
      else {
        await workspace[Symbol.asyncDispose]();
        this.workspaces.delete(id);
        this.known.delete(id);
      }
    } else {
      this.known.delete(id);
    }
  }

  private async descriptorFor(tree: RootID): Promise<RootDescriptor | undefined> {
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
