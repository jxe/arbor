import type { LocalTreeDescriptor, TreeID } from "@overstory/protocol";
import { nodePathFromPhysical, sha256, workspaceState } from "@overstory/protocol";
import { resolveTreePath, toTreePath } from "@overstory/protocol/path";
import { type FsEvent, type SnapshotObjectIndex, WorkspaceFS } from "@overstory/fs";
import { basename, join } from "node:path";
import { EventBus } from "./events.ts";
import { FilesystemObjectSource } from "./filesystem-object-source.ts";
import { reportObjectRead } from "./object-read-diagnostics.ts";
import { rootDisplayName } from "./root-title.ts";
import { WorkspaceNodes } from "./workspace-nodes.ts";

export { ProtocolError } from "@overstory/protocol";

export interface WorkspaceOptions {
  /** Shared process-wide bus; a standalone Workspace mints its own. */
  events?: EventBus;
  /** This root's tree scope tag; minted from the canonical root by default. */
  tree?: TreeID;
  /** Derived from the root `_index.md`; basename fallback. */
  displayName?: string;
  tracking?: "tracked" | "session";
  /** Untracked browsing starts shallow; tracked trees require complete discovery. */
  discovery?: "recursive" | "shallow";
  treeDescriptor?: Partial<LocalTreeDescriptor>;
  /** Reader-local child placements which are not content owned by this tree. */
  excludedRoots?: readonly string[];
  /** Interval for the uncached object-index revalidation walk; 0 disables it. */
  objectRevalidationMs?: number;
}

const DEFAULT_OBJECT_REVALIDATION_MS = 30 * 60_000;
/** Owns a placed folder's filesystem, object access, observation and lifetime. */
export class Workspace implements AsyncDisposable {
  readonly root: string;
  readonly tree: TreeID;
  readonly fs: WorkspaceFS;
  readonly events: EventBus;
  readonly objects: FilesystemObjectSource;
  readonly nodes: WorkspaceNodes;
  tracking: "tracked" | "session";
  private displayName: string;
  private treeDescriptor: Partial<LocalTreeDescriptor>;
  private discovery: "recursive" | "shallow";
  private excludedRoots: string[];
  private unsubscribeFS: () => void;
  private constructor(root: string, stateDirectory: string, fs: WorkspaceFS, options: WorkspaceOptions) {
    this.root = root;
    this.events = options.events ?? new EventBus();
    this.tree = options.tree ?? `rt_${sha256(root).slice(0, 10)}`;
    this.displayName = options.displayName ?? basename(root);
    this.treeDescriptor = options.treeDescriptor ?? {};
    this.discovery = options.discovery ?? "recursive";
    this.excludedRoots = [...(options.excludedRoots ?? [])].sort();
    this.tracking = options.tracking ?? "session";
    this.fs = fs;
    this.objects = new FilesystemObjectSource(root, join(stateDirectory, "index.sqlite"), {
      exclusions: () => this.excludedRoots,
      revalidationMs: options.objectRevalidationMs ?? DEFAULT_OBJECT_REVALIDATION_MS,
      report: (diagnostic) => reportObjectRead({ ...diagnostic, tree: this.tree }),
      changed: (absolute) => this.events.emit({
        tree: this.tree,
        kind: "diagnostic",
        ref: this.nodes.mutationRef(nodePathFromPhysical(toTreePath(this.root, absolute))),
        origin: "sync",
      }),
    });

    this.nodes = new WorkspaceNodes(root, stateDirectory, fs, this.tree, this.events, () => this.descriptor());
    this.unsubscribeFS = fs.subscribe((event) => { void this.handleFsEvent(event); });
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this.unsubscribeFS();
    await this.objects[Symbol.asyncDispose]();
    await this.nodes[Symbol.asyncDispose]();
    await this.fs[Symbol.asyncDispose]();
  }
  static async open(path: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const state = await workspaceState(path);
    const stateDirectory = state.directory;
    const fs = await WorkspaceFS.open(path, {
      stateDirectory,
      discovery: options.discovery,
      excludedRoots: options.excludedRoots,
    });
    const discovery = fs.startupDiscovery();
    const workspace = new Workspace(fs.root, stateDirectory, fs, {
      ...options,
      tree: options.tree ?? state.identity.rootID,
      displayName: options.displayName ?? await rootDisplayName(fs.root),
    });
    await workspace.nodes.initialize(discovery, workspace.discovery === "recursive");
    // The object index is never authority; the first walk after open audits it.
    void workspace.revalidateObjectIndex().catch(() => {});
    return workspace;
  }

  objectIndex(): SnapshotObjectIndex { return this.objects.index(); }

  revalidateObjectIndex(): Promise<void> { return this.objects.revalidate(); }

  descriptor(): LocalTreeDescriptor {
    return {
      id: this.tree,
      name: this.displayName,
      osPath: this.root,
      kind: "ordinary",
      access: "write",
      canonical: null,
      placement: "placed",
      ...this.treeDescriptor,
    };
  }

  describeProtocolCollectionFile(directory: string, sourceName: string) {
    return this.nodes.describeProtocolCollectionFile(directory, sourceName);
  }

  updateTreeDescriptor(descriptor: Partial<LocalTreeDescriptor>): void {
    this.treeDescriptor = { ...this.treeDescriptor, ...descriptor };
  }

  async activateRecursiveDiscovery(): Promise<void> {
    if (this.discovery === "recursive") return;
    const discovery = await this.fs.discoverRecursively();
    this.nodes.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    await this.nodes.generateTypes(discovery);
    this.discovery = "recursive";
  }

  async updateExcludedRoots(roots: readonly string[]): Promise<void> {
    const next = [...roots].sort();
    if (next.length === this.excludedRoots.length && next.every((root, index) => root === this.excludedRoots[index])) return;
    this.excludedRoots = next;
    const discovery = await this.fs.setExcludedRoots(next);
    this.nodes.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    if (this.discovery === "recursive") await this.nodes.generateTypes(discovery);
  }

  async refreshDisplayName(): Promise<string> {
    this.displayName = await rootDisplayName(this.root);
    return this.displayName;
  }

  async fileSurface(inputPath: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    const read = await this.fs.read(inputPath);
    if (read.node.kind === "file") {
      return read.bytes ? { bytes: read.bytes, revision: read.byteRevision, path: read.node.path } : null;
    }
    if (raw && (read.node.kind === "markdown" || read.node.kind === "directory") && read.bytes) {
      return { bytes: read.bytes, revision: read.byteRevision, path: read.node.path };
    }
    return null;
  }

  private async handleFsEvent(event: FsEvent): Promise<void> {
    if (event.path === "/") this.displayName = await rootDisplayName(this.root);
    if (event.type !== "diagnostic") this.forgetObjectRows(event.path, event.previousPath);
    this.events.emit({
      tree: this.tree,
      kind: event.type,
      ref: this.nodes.mutationRef(event.path),
      previousPath: event.previousPath,
      contentRevision: event.byteRevision,
      origin: "external",
    });
  }

  private forgetObjectRows(...paths: Array<string | undefined>): void {
    for (const path of paths) {
      if (!path) continue;
      let absolute: string;
      try { absolute = resolveTreePath(this.root, path); } catch { continue; }
      // A watcher event can arrive after dispose closed the index; a missed
      // forget is harmless because the stat tuple no longer matches.
      try {
        this.objects.invalidate([absolute, `${absolute}.md`, join(absolute, "_index.md")]);
      } catch {}
    }
  }
}
