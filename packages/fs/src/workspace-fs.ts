import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import * as watcher from "@parcel/watcher";
import type { Diagnostic, MarkdownDocument } from "@overstory/protocol";
import {
  compareUTF8,
  canonicalNodePath,
  isPageID,
  directoryIndexTreePath,
  nodeDisplayName,
  nodePathFromPhysical,
  normalizeTreePath,
  PathEscapeError,
  revisionOf,
  sha256,
  siblingMarkdownTreePath,
} from "@overstory/protocol";
import { directoryPlacementDiagnostics, parseMarkdown } from "@overstory/protocol";
import { pathExists } from "@overstory/protocol/file-ops";
import { discoverWorkspace, type WorkspaceDiscovery, WORKSPACE_WATCHER_IGNORE_GLOBS } from "./discovery.ts";
import { isIgnoreFileName, loadIgnorePolicy, type IgnorePolicy, type Membership } from "./ignore-policy.ts";
import { iCloudPlaceholderLogicalName, iCloudPlaceholderPath } from "./materialization.ts";
import {
  type FsDirectoryEntry,
  type FsEvent,
  type FsReadResult,
  type ResolvedFsNode,
  type WorkspaceFSOptions,
} from "./types.ts";
import { ensureContainedPath, resolveTreePath, toTreePath } from "@overstory/protocol/path";

const RESERVED = new Set(["schema.cddl", "_store.csv", "_store.json", "_store.jsonl", "_store.postgres", "_store.sqlite3", "_index.md"]);
const EMPTY_REVISION = revisionOf("");

function bodyRevision(document: MarkdownDocument): string {
  return sha256(document.bodySource);
}

function directoryContentRevision(storedSource: string, children: readonly FsDirectoryEntry[]): string {
  const descriptors = children
    .map((child) => ({
      path: canonicalNodePath(child.path),
      kind: child.kind,
      pageID: child.pageID ?? null,
    }))
    .sort((left, right) => compareUTF8(left.path, right.path));
  return revisionOf(`${storedSource}\0${JSON.stringify(descriptors)}`);
}

function isTransactionTemporary(path: string): boolean {
  return basename(path).includes(".arbor-txn-") || basename(path).includes(".arbor-write-");
}

export class WorkspaceFS implements AsyncDisposable {
  readonly root: string;
  readonly stateDirectory: string;
  private subscription?: watcher.AsyncSubscription;
  private listeners = new Set<(event: FsEvent) => void>();
  private pagePathsByID = new Map<string, string>();
  private watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recentExternalMoves = new Map<string, number>();
  private initialDiscovery?: WorkspaceDiscovery;
  private excludedRoots: string[];
  private policy!: IgnorePolicy;
  private readonly addressable: boolean;
  private ignoredListeners = new Set<(treePath: string) => void>();
  private rediscoveryListeners = new Set<(discovery: WorkspaceDiscovery) => void>();
  private policyTimer?: ReturnType<typeof setTimeout>;
  private policyReload?: Promise<void>;

  private constructor(root: string, options: WorkspaceFSOptions) {
    this.root = root;
    this.stateDirectory = options.stateDirectory;
    this.excludedRoots = (options.excludedRoots ?? []).map((item) => resolve(item));
    // Browsing without discovery opens any local path; membership still shapes listings.
    this.addressable = options.discovery === "none";
  }

  static async open(path: string, options: WorkspaceFSOptions): Promise<WorkspaceFS> {
    const root = await realpath(path);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("WorkspaceFS requires a directory");
    const instance = new WorkspaceFS(root, options);
    instance.policy = await loadIgnorePolicy(root, { excludedRoots: instance.excludedRoots });
    instance.initialDiscovery = options.discovery === "none"
      ? { root, files: [], directories: [], pagePathsByID: new Map(), pageIDOwners: new Map(), diagnostics: [] }
      : await discoverWorkspace(root, {
        recursive: options.discovery !== "shallow",
        policy: instance.policy,
      });
    instance.loadPageIDs(instance.initialDiscovery);
    if (options.discovery !== "shallow" && options.discovery !== "none") await instance.startWatcher();
    return instance;
  }

  startupDiscovery(): WorkspaceDiscovery {
    if (!this.initialDiscovery) throw new Error("Workspace discovery is unavailable");
    return this.initialDiscovery;
  }

  /** The membership policy this folder's listings and events currently follow. */
  get ignorePolicy(): IgnorePolicy {
    return this.policy;
  }

  async discoverRecursively(): Promise<WorkspaceDiscovery> {
    const discovery = await discoverWorkspace(this.root, { policy: this.policy });
    this.initialDiscovery = discovery;
    this.loadPageIDs(discovery);
    if (!this.subscription) await this.startWatcher();
    return discovery;
  }

  async setExcludedRoots(roots: readonly string[]): Promise<WorkspaceDiscovery> {
    this.excludedRoots = roots.map((item) => resolve(item));
    this.policy = await loadIgnorePolicy(this.root, { excludedRoots: this.excludedRoots });
    const discovery = await discoverWorkspace(this.root, {
      recursive: this.subscription !== undefined,
      policy: this.policy,
    });
    this.initialDiscovery = discovery;
    this.loadPageIDs(discovery);
    return discovery;
  }

  private isExcludedAbsolute(absolutePath: string): boolean {
    const candidate = resolve(absolutePath);
    return this.excludedRoots.some((root) => candidate === root || candidate.startsWith(`${root}${sep}`));
  }

  subscribe(listener: (event: FsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Changes at paths an ignore rule keeps out of the listing, by physical tree
   * path. They are never nodes here; a synchronizer that still tracks such a
   * path decides whether the change matters.
   */
  subscribeIgnored(listener: (treePath: string) => void): () => void {
    this.ignoredListeners.add(listener);
    return () => this.ignoredListeners.delete(listener);
  }

  /** A changed ignore file made the folder rediscover; listeners see the new result before the tree is invalidated. */
  subscribeRediscovery(listener: (discovery: WorkspaceDiscovery) => void): () => void {
    this.rediscoveryListeners.add(listener);
    return () => this.rediscoveryListeners.delete(listener);
  }

  private async included(treePath: string, isDirectory: boolean): Promise<boolean> {
    return (await this.policy.decision(treePath, isDirectory)).membership === "included";
  }

  private emit(event: FsEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async resolve(inputPath: string): Promise<ResolvedFsNode> {
    const path = canonicalNodePath(inputPath);
    const siblingTreePath = siblingMarkdownTreePath(path);
    const [direct, sibling] = await Promise.all([
      ensureContainedPath(this.root, path, this.root),
      ensureContainedPath(this.root, siblingTreePath, this.root),
    ]);
    if (path !== "/" && (this.isExcludedAbsolute(direct) || this.isExcludedAbsolute(sibling))) {
      return {
        path,
        kind: "missing",
        absolutePath: direct,
        directoryPath: null,
        bodyPath: null,
        bodySource: null,
        writable: false,
        materialization: "available",
        diagnostics: [],
      };
    }
    const directPlaceholder = iCloudPlaceholderPath(direct);
    const siblingPlaceholder = iCloudPlaceholderPath(sibling);
    let [directInfo, siblingInfo, directPlaceholderInfo, siblingPlaceholderInfo] = await Promise.all([
      stat(direct).catch(() => null),
      path === "/" ? Promise.resolve(null) : stat(sibling).catch(() => null),
      path === "/" ? Promise.resolve(null) : stat(directPlaceholder).catch(() => null),
      path === "/" ? Promise.resolve(null) : stat(siblingPlaceholder).catch(() => null),
    ]);

    if (path !== "/" && !this.addressable) {
      // An excluded path is not a node, even when addressed directly.
      if (directInfo && !(await this.included(path, directInfo.isDirectory()))) directInfo = null;
      if (siblingInfo && !(await this.included(siblingTreePath, siblingInfo.isDirectory()))) siblingInfo = null;
      if (directPlaceholderInfo && !(await this.included(path, false))) directPlaceholderInfo = null;
      if (siblingPlaceholderInfo && !(await this.included(siblingTreePath, false))) siblingPlaceholderInfo = null;
    }

    if (path === "/") {
      const indexPath = resolveTreePath(this.root, directoryIndexTreePath("/"));
      const hasIndex = await pathExists(indexPath);
      return {
        path,
        kind: "directory",
        absolutePath: direct,
        directoryPath: direct,
        bodyPath: hasIndex ? indexPath : null,
        bodySource: hasIndex ? "index" : null,
        writable: await this.isWritable(direct) && (!hasIndex || await this.isWritable(indexPath)),
        materialization: "available",
        diagnostics: [],
      };
    }

    if (directInfo?.isDirectory()) {
      const indexPath = join(direct, "_index.md");
      const hasIndex = await pathExists(indexPath);
      const hasSibling = Boolean(siblingInfo?.isFile());
      // `_index.md` takes precedence; a sibling body beside it is reported, not used.
      const diagnostics: Diagnostic[] = hasSibling && hasIndex ? [{
        code: "shadowed-body",
        message: `${path} has a sibling body at ${siblingTreePath} beside ${directoryIndexTreePath(path)}; _index.md is the content and the sibling is ignored.`,
        path,
        severity: "warning",
      }] : [];
      const bodyPath = hasIndex ? indexPath : hasSibling ? sibling : null;
      return {
        path,
        kind: "directory",
        absolutePath: direct,
        directoryPath: direct,
        bodyPath,
        bodySource: hasIndex ? "index" : hasSibling ? "sibling" : null,
        writable: await this.isWritable(direct) && (!bodyPath || await this.isWritable(bodyPath)),
        materialization: "available",
        diagnostics,
      };
    }

    if (siblingInfo?.isFile() || siblingPlaceholderInfo?.isFile()) {
      const placeholder = !siblingInfo?.isFile() && Boolean(siblingPlaceholderInfo?.isFile());
      const physicalBody = placeholder ? siblingPlaceholder : sibling;
      const diagnostics: Diagnostic[] = directInfo ? [{
        code: "duplicate-node-representation",
        message: `${path} is occupied by both a file and a Markdown page.`,
        path,
        severity: "error",
      }] : [];
      return {
        path,
        kind: "markdown",
        absolutePath: physicalBody,
        directoryPath: null,
        bodyPath: physicalBody,
        bodySource: "sibling",
        writable: !placeholder && await this.isWritable(sibling),
        materialization: placeholder ? "placeholder" : "available",
        diagnostics,
      };
    }

    if (directInfo || directPlaceholderInfo?.isFile()) {
      const placeholder = !directInfo && Boolean(directPlaceholderInfo?.isFile());
      return {
        path,
        kind: "file",
        absolutePath: placeholder ? directPlaceholder : direct,
        directoryPath: null,
        bodyPath: null,
        bodySource: null,
        writable: !placeholder && await this.isWritable(direct),
        materialization: placeholder ? "placeholder" : "available",
        diagnostics: [],
      };
    }

    return {
      path,
      kind: "missing",
      absolutePath: direct,
      directoryPath: null,
      bodyPath: null,
      bodySource: null,
      writable: await this.isWritable(dirname(direct)),
      materialization: "available",
      diagnostics: [],
    };
  }

  async read(inputPath: string): Promise<FsReadResult> {
    const resolvedNode = await this.resolve(inputPath);
    const node = resolvedNode.kind === "directory" && resolvedNode.materialization === "available"
      ? {
        ...resolvedNode,
        diagnostics: [
          ...resolvedNode.diagnostics,
          ...directoryPlacementDiagnostics(resolvedNode.path, parseMarkdown(
            resolvedNode.bodyPath ? await readFile(resolvedNode.bodyPath, "utf8").catch(() => "") : "",
          )),
        ],
      }
      : resolvedNode;
    if (node.kind === "missing") return { node, bytes: null, byteRevision: EMPTY_REVISION };
    if (node.materialization === "placeholder") {
      return { node, bytes: null, byteRevision: revisionOf(`placeholder:${node.path}`) };
    }
    const path = node.kind === "directory" ? node.bodyPath : node.kind === "markdown" ? node.bodyPath : node.absolutePath;
    if (node.kind === "file") {
      const bytes = new Uint8Array(await readFile(path!));
      return { node, bytes, byteRevision: revisionOf(bytes) };
    }
    const storedBytes = path ? new Uint8Array(await readFile(path)) : null;
    const storedSource = storedBytes ? new TextDecoder().decode(storedBytes) : "";
    const document = parseMarkdown(storedSource);
    const pageID = isPageID(document.frontmatter.id) ? document.frontmatter.id : null;
    if (pageID && path) {
      if (!this.pagePathsByID.has(pageID)) this.pagePathsByID.set(pageID, node.path);
    }
    const storedByteRevision = revisionOf(storedSource);
    if (node.kind !== "directory") {
      return {
        node,
        bytes: storedBytes,
        storedBytes,
        byteRevision: storedByteRevision,
        storedByteRevision,
        bodyRevision: bodyRevision(document),
        document,
      };
    }
    const entries = await this.list(node.path);
    return {
      node,
      bytes: storedBytes,
      storedBytes,
      byteRevision: directoryContentRevision(storedSource, entries),
      storedByteRevision,
      bodyRevision: bodyRevision(document),
      document,
    };
  }

  async list(inputPath: string): Promise<FsDirectoryEntry[]> {
    const node = await this.resolve(inputPath);
    if (node.kind !== "directory" || !node.directoryPath) throw new Error(`${node.path} is not a directory`);
    const entries = await readdir(node.directoryPath, { withFileTypes: true });
    const paths = new Set<string>();
    for (const entry of entries) {
      if (RESERVED.has(entry.name) || isTransactionTemporary(entry.name)) continue;
      if (this.isExcludedAbsolute(join(node.directoryPath, entry.name))) continue;
      const logicalName = iCloudPlaceholderLogicalName(entry.name) ?? entry.name;
      const physical = `${node.path === "/" ? "" : node.path}/${logicalName}`;
      if (!(await this.included(physical, entry.isDirectory()))) continue;
      paths.add(logicalName.endsWith(".md") ? canonicalNodePath(physical) : normalizeTreePath(physical));
    }
    const children = await Promise.all([...paths].map(async (path): Promise<FsDirectoryEntry | null> => {
      let child: ResolvedFsNode;
      try { child = await this.resolve(path); }
      catch (error) {
        if (error instanceof PathEscapeError) return null;
        throw error;
      }
      if (child.kind === "missing") return null;
      return {
        path: child.path,
        name: nodeDisplayName(child.path),
        kind: child.kind,
        materialization: child.materialization,
        ...await this.pageIDForNode(child).then((pageID) => pageID ? { pageID } : {}),
        diagnostics: child.diagnostics,
      };
    }));
    return children
      .filter((child): child is FsDirectoryEntry => child !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async pageIDForNode(node: ResolvedFsNode): Promise<string | undefined> {
    const known = [...this.pagePathsByID].find(([, owner]) => owner === node.path)?.[0];
    if (known) return known;
    if ((node.kind !== "markdown" && node.kind !== "directory") || !node.bodyPath || node.materialization === "placeholder") {
      return undefined;
    }
    const source = await readFile(node.bodyPath, "utf8").catch(() => null);
    if (source === null) return undefined;
    const value = parseMarkdown(source).frontmatter.id;
    return isPageID(value) ? value : undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const timer of this.watcherTimers.values()) clearTimeout(timer);
    for (const timer of this.pendingDeleteTimers.values()) clearTimeout(timer);
    if (this.policyTimer) clearTimeout(this.policyTimer);
    await this.subscription?.unsubscribe();
    await this.policyReload?.catch(() => {});
  }

  private async startWatcher(): Promise<void> {
    this.subscription = await watcher.subscribe(this.root, async (error, events) => {
      if (error) {
        this.emit({ type: "diagnostic", path: "/", diagnostic: { code: "watcher-error", message: error.message, path: "/", severity: "error" } });
        return;
      }
      for (const event of events) this.queueWatch(event.path, event.type);
    }, { ignore: WORKSPACE_WATCHER_IGNORE_GLOBS });
  }

  private queueWatch(absolute: string, type: watcher.EventType): void {
    if (isTransactionTemporary(absolute)) return;
    if (this.isExcludedAbsolute(absolute)) return;
    let treePath: string;
    const placeholderName = iCloudPlaceholderLogicalName(basename(absolute));
    const logicalAbsolute = placeholderName ? join(dirname(absolute), placeholderName) : absolute;
    let physical: string;
    try {
      physical = toTreePath(this.root, logicalAbsolute);
      treePath = nodePathFromPhysical(physical);
    } catch { return; }
    if (!placeholderName && isIgnoreFileName(basename(absolute))) this.schedulePolicyReload();
    const path = canonicalNodePath(treePath);
    const old = this.watcherTimers.get(path);
    if (old) clearTimeout(old);
    this.watcherTimers.set(path, setTimeout(() => {
      this.watcherTimers.delete(path);
      void this.handleWatch(path, type, physical, logicalAbsolute);
    }, 60));
  }

  /** Membership of an event's path; a vanished path counts as whatever it could have been. */
  private async eventMembership(physical: string, absolute: string): Promise<Membership> {
    const info = await lstat(absolute).catch(() => null);
    const kinds = info ? [info.isDirectory()] : [false, true];
    const decisions = await Promise.all(kinds.map(async (isDirectory) => (await this.policy.decision(physical, isDirectory)).membership));
    return decisions.includes("included") ? "included" : decisions.includes("ignored") ? "ignored" : "mandatory";
  }

  /** Coalesce ignore-file edits into one reload and rediscovery, then invalidate the whole tree. */
  private schedulePolicyReload(): void {
    if (this.policyTimer) clearTimeout(this.policyTimer);
    this.policyTimer = setTimeout(() => {
      this.policyTimer = undefined;
      const previous = this.policyReload ?? Promise.resolve();
      this.policyReload = previous.catch(() => {}).then(() => this.reloadPolicy());
    }, 60);
  }

  private async reloadPolicy(): Promise<void> {
    this.policy = await loadIgnorePolicy(this.root, { excludedRoots: this.excludedRoots });
    const discovery = await discoverWorkspace(this.root, { policy: this.policy });
    this.initialDiscovery = discovery;
    this.pagePathsByID = new Map();
    this.loadPageIDs(discovery);
    for (const listener of this.rediscoveryListeners) listener(discovery);
    for (const diagnostic of discovery.diagnostics) this.emit({ type: "diagnostic", path: diagnostic.path, diagnostic });
    this.emit({ type: "updated", path: "/" });
  }

  private async handleWatch(path: string, type: watcher.EventType, physical: string, absolute: string): Promise<void> {
    const membership = await this.eventMembership(physical, absolute);
    if (membership === "mandatory") return;
    if (membership === "ignored") {
      for (const listener of this.ignoredListeners) listener(physical);
      return;
    }
    const current = await this.read(path).catch(() => null);
    if (!current || current.node.kind === "missing") {
      if ((this.recentExternalMoves.get(path) ?? 0) > Date.now()) {
        this.recentExternalMoves.delete(path);
        return;
      }
      const durableID = [...this.pagePathsByID].find(([, owner]) => owner === path)?.[0];
      if (!durableID) {
        this.emit({ type: "deleted", path });
        return;
      }
      const old = this.pendingDeleteTimers.get(path);
      if (old) clearTimeout(old);
      this.pendingDeleteTimers.set(path, setTimeout(() => {
        this.pendingDeleteTimers.delete(path);
        if (this.pagePathsByID.get(durableID) === path) {
          this.pagePathsByID.delete(durableID);
          this.emit({ type: "deleted", path });
        }
      }, 160));
      return;
    }
    const revision = current.byteRevision;
    if (current.document) {
      const id = current.document.frontmatter.id;
      if (isPageID(id)) {
        const previous = this.pagePathsByID.get(id);
        this.pagePathsByID.set(id, path);
        if (previous && previous !== path) {
          this.recentExternalMoves.set(previous, Date.now() + 500);
          const pending = this.pendingDeleteTimers.get(previous);
          if (pending) {
            clearTimeout(pending);
            this.pendingDeleteTimers.delete(previous);
          }
          this.emit({ type: "moved", path, previousPath: previous, byteRevision: revision, bodyRevision: current.bodyRevision });
          return;
        }
      }
    }
    this.emit({
      type: type === "create" ? "created" : "updated",
      path,
      byteRevision: revision,
      bodyRevision: current.bodyRevision,
    });
  }

  private loadPageIDs(discovery: WorkspaceDiscovery): void {
    for (const [id, path] of discovery.pagePathsByID) {
      this.pagePathsByID.set(id, path);
    }
  }

  private async isWritable(path: string): Promise<boolean> {
    try { await access(path, constants.W_OK); return true; }
    catch { return false; }
  }
}
