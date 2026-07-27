import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Diagnostic, RootDescriptor, RootID } from "@arbor/core";
import { sha256 } from "@arbor/core";
import {
  deleteSystemRoot,
  loadSystemRoots,
  saveSystemRoot,
  type SystemRootRecord,
} from "@arbor/stores";
import type { EventBus } from "./events.ts";
import { ProtocolError, Workspace, type WorkspaceOptions } from "./workspace.ts";

/** Deterministic per-path root identity for this device. Opaque to clients. */
export function mintRootID(canonicalPath: string): RootID {
  return `rt_${sha256(canonicalPath).slice(0, 10)}`;
}

interface KnownRoot {
  record?: SystemRootRecord;
  osPath: string;
  missing: boolean;
}

/**
 * Owns the tracked-root records and the per-root Workspace instances
 * behind one shared event bus. The session root opens eagerly; tracked
 * roots open lazily as requests resolve into them. A later per-user
 * singleton daemon adds lifecycle (idle eviction, start-or-attach) here
 * without changing the service above it.
 */
export class RootManager implements AsyncDisposable {
  private workspaces = new Map<RootID, Workspace>();
  private known = new Map<RootID, KnownRoot>();
  private sessionID: RootID | null = null;
  private recordDiagnostics: Diagnostic[] = [];
  private workspaceOptions: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {};

  constructor(readonly events: EventBus) {}

  /** Load tracked-root records and resolve their paths. */
  async init(): Promise<void> {
    const { records, diagnostics } = await loadSystemRoots();
    this.recordDiagnostics = diagnostics;
    for (const record of records) {
      let osPath = record.path;
      let missing = false;
      try {
        const info = await stat(await realpath(record.path));
        if (!info.isDirectory()) missing = true;
        else osPath = await realpath(record.path);
      } catch {
        missing = true;
      }
      this.known.set(record.id, { record, osPath, missing });
    }
  }

  async openSession(path: string, options: Omit<WorkspaceOptions, "events" | "tree" | "tracking"> = {}): Promise<Workspace> {
    this.workspaceOptions = options;
    const canonical = await realpath(path);
    // Joining an already-tracked root — even from a subdirectory — keeps
    // that root's identity instead of opening a duplicate authority.
    const tracked = [...this.known.values()].find((root) =>
      !root.missing && root.record
      && (root.osPath === canonical || canonical.startsWith(root.osPath.endsWith("/") ? root.osPath : `${root.osPath}/`))
    );
    const workspace = await Workspace.open(tracked?.osPath ?? canonical, {
      ...options,
      events: this.events,
      tree: tracked?.record?.id,
      tracking: tracked ? "tracked" : "session",
    });
    this.sessionID = workspace.tree;
    this.workspaces.set(workspace.tree, workspace);
    if (!tracked) this.known.set(workspace.tree, { osPath: workspace.root, missing: false });
    return workspace;
  }

  get session(): Workspace {
    const workspace = this.sessionID ? this.workspaces.get(this.sessionID) : undefined;
    if (!workspace) throw new Error("The session root is not open");
    return workspace;
  }

  /** The Workspace for a tree scope, opening a tracked root lazily. */
  async workspaceByTree(tree: RootID): Promise<Workspace | undefined> {
    const open = this.workspaces.get(tree);
    if (open) return open;
    const root = this.known.get(tree);
    if (!root?.record || root.missing) return undefined;
    return this.open(tree, root);
  }

  private async open(tree: RootID, root: KnownRoot): Promise<Workspace> {
    const workspace = await Workspace.open(root.osPath, {
      ...this.workspaceOptions,
      events: this.events,
      tree,
      tracking: "tracked",
    });
    this.workspaces.set(tree, workspace);
    return workspace;
  }

  list(): Workspace[] {
    return [...this.workspaces.values()];
  }

  /** The durable tracked-root records, for the read-only system: pages. */
  records(): SystemRootRecord[] {
    return [...this.known.values()]
      .map((root) => root.record)
      .filter((record): record is SystemRootRecord => Boolean(record));
  }

  /** Open every tracked root (bare-pageID fan-out needs all ID maps). */
  async openAll(): Promise<Workspace[]> {
    for (const [tree, root] of this.known) {
      if (!this.workspaces.has(tree) && root.record && !root.missing) {
        await this.open(tree, root);
      }
    }
    return this.list();
  }

  descriptors(): RootDescriptor[] {
    const descriptors: RootDescriptor[] = [];
    for (const [tree, root] of this.known) {
      const workspace = this.workspaces.get(tree);
      if (workspace) {
        descriptors.push(workspace.descriptor());
        continue;
      }
      descriptors.push({
        id: tree,
        name: root.record?.name ?? basename(root.osPath),
        osPath: root.osPath,
        tracking: root.record ? "tracked" : "session",
        ...(root.missing ? { missing: true } : {}),
      });
    }
    return descriptors;
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

  /**
   * Longest-prefix owner of an absolute OS path among live and tracked
   * roots, opening the owning tracked root lazily. Callers realpath first.
   */
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

  /** Track a folder durably. Idempotent by canonical path; refuses nesting. */
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
        // Idempotent: already known. Promote a session root in place.
        if (!root.record) {
          const workspace = this.workspaces.get(tree);
          const record = await saveSystemRoot({
            id: tree,
            path: canonical,
            added: new Date().toISOString(),
            name: workspace ? workspace.descriptor().name : basename(canonical),
          });
          root.record = record;
          if (workspace) workspace.tracking = "tracked";
        }
        return this.descriptorFor(tree)!;
      }
      const prefix = root.osPath.endsWith("/") ? root.osPath : `${root.osPath}/`;
      if (canonical.startsWith(prefix) || root.osPath.startsWith(`${canonical}/`)) {
        throw new ProtocolError(
          "unsupported-operation",
          `Tracking ${canonical} would nest with the existing root at ${root.osPath}; overlapping roots arrive with mounts`,
          422,
          { path: canonical },
        );
      }
    }
    const id = mintRootID(canonical);
    const record = await saveSystemRoot({
      id,
      path: canonical,
      added: new Date().toISOString(),
      name: basename(canonical),
    });
    this.known.set(id, { record, osPath: canonical, missing: false });
    return this.descriptorFor(id)!;
  }

  /** Untrack a root. The private state directory is retained. */
  async untrack(id: RootID): Promise<void> {
    const root = this.known.get(id);
    if (!root?.record) {
      throw new ProtocolError("not-found", `No tracked root ${id}`, 404);
    }
    await deleteSystemRoot(id);
    root.record = undefined;
    const workspace = this.workspaces.get(id);
    if (workspace) {
      // The session root stays open (session scope); others close.
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

  private descriptorFor(tree: RootID): RootDescriptor | undefined {
    return this.descriptors().find((descriptor) => descriptor.id === tree);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const workspace of this.workspaces.values()) {
      await workspace[Symbol.asyncDispose]();
    }
    this.workspaces.clear();
  }
}
