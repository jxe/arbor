import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import * as watcher from "@parcel/watcher";
import type { Diagnostic, MarkdownDocument } from "@arbor/core";
import {
  compareUTF8,
  parentNodePath,
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
} from "@arbor/core";
import { directoryPlacementDiagnostics, mintPageID, parseMarkdown, patchFrontmatter, serializeMarkdown } from "@arbor/editor";
import { commitPrepared, pathExists, prepareAtomic, removeIfExists, syncDirectory, transactionTemporaryPath, writeAtomic } from "./file-ops.ts";
import {
  discoverWorkspace,
  IGNORED_WORKSPACE_DIRECTORIES,
  type WorkspaceDiscovery,
  WORKSPACE_WATCHER_IGNORE_GLOBS,
} from "./discovery.ts";
import { WriteJournal } from "./journal.ts";
import { iCloudPlaceholderLogicalName, iCloudPlaceholderPath } from "./materialization.ts";
import {
  FsConflictError,
  FsInjectedCrashError,
  type FsChange,
  type FsDirectoryEntry,
  type FsEvent,
  type FsImportEntry,
  type FsMutation,
  type FsMutationRequest,
  type FsMutationResult,
  type FsReadResult,
  type FsWriteResult,
  type MarkdownWriteRequest,
  type ResolvedFsNode,
  type WorkspaceFSOptions,
} from "./types.ts";
import { ensureContainedPath, resolveTreePath, toTreePath } from "@arbor/core/path";

const RESERVED = new Set(["schema.ts", "_store.csv", "_store.json", "_store.jsonl", "_store.postgres", "_store.sqlite3", "_index.md"]);
const IGNORED = IGNORED_WORKSPACE_DIRECTORIES;
const EMPTY_REVISION = revisionOf("");

interface AuthoredRevision {
  revision: string;
  bytes: Uint8Array;
  bodyPath: string;
  generation: number;
}

class NodeCoordinator {
  currentGeneration = 0;
  durableGeneration = 0;
  recent: AuthoredRevision[] = [];
  unsettled = false;
  settleTimer?: ReturnType<typeof setTimeout>;
  private settleCallback?: () => void;
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.reserveGeneration();
    const run = this.tail.then(() => task(generation), () => task(generation));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  reserveGeneration(): number {
    return ++this.currentGeneration;
  }

  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  remember(value: AuthoredRevision, settleDelayMs: number, onSettled: () => void): void {
    this.durableGeneration = Math.max(this.durableGeneration, value.generation);
    this.recent = [value, ...this.recent.filter((item) => item.revision !== value.revision)].slice(0, 8);
    this.unsettled = true;
    this.settleCallback = onSettled;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settle(), settleDelayMs);
  }

  settleEcho(revision: string): boolean {
    if (this.recent[0]?.revision !== revision) return false;
    this.settle();
    return true;
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.unsettled) this.settle();
  }

  private settle(): void {
    this.unsettled = false;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    const callback = this.settleCallback;
    this.settleCallback = undefined;
    callback?.();
  }
}

interface TransactionStep {
  source?: string;
  temporary: string;
  destination: string;
  kind: "file" | "directory";
  fingerprint?: string;
}

interface TransactionRecord {
  id: string;
  mutationID?: string;
  phase: "prepared" | "committing" | "committed" | "interrupted";
  steps: TransactionStep[];
  changes: FsChange[];
  message?: string;
}

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

function validateName(name: string): void {
  const lower = name.toLowerCase();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    [...RESERVED].some((reserved) => reserved.toLowerCase() === lower) ||
    [".git", ".arbor", "trash", "node_modules", ".build", "deriveddata"].includes(lower) ||
    lower.includes(".arbor-txn-") ||
    lower.includes(".arbor-write-")
  ) {
    throw new FsConflictError({ code: "invalid-name", path: name }, `Invalid workspace name: ${name}`);
  }
}

function validateLogicalName(name: string): void {
  validateName(name);
  if (name.toLowerCase().endsWith(".md")) {
    throw new FsConflictError({ code: "invalid-name", path: name }, "Logical page and folder names do not include .md");
  }
}

export class WorkspaceFS implements AsyncDisposable {
  readonly root: string;
  readonly stateDirectory: string;
  readonly journal: WriteJournal;
  private subscription?: watcher.AsyncSubscription;
  private listeners = new Set<(event: FsEvent) => void>();
  private coordinators = new Map<string, NodeCoordinator>();
  private knownIDs = new Set<string>();
  private pagePathsByID = new Map<string, string>();
  private settleDelayMs: number;
  private faultInjector?: WorkspaceFSOptions["faultInjector"];
  private watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recentExternalMoves = new Map<string, number>();
  private suppressedPaths = new Map<string, number>();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private transactionDirectory: string;
  private pendingDiagnostics: Diagnostic[] = [];
  private recoveredMutationResults: Array<{ mutationID: string; result: FsMutationResult }> = [];
  private initialDiscovery?: WorkspaceDiscovery;
  private excludedRoots: string[];
  private durableIdentity: boolean;

  private constructor(root: string, options: WorkspaceFSOptions) {
    this.root = root;
    this.stateDirectory = options.stateDirectory;
    this.journal = new WriteJournal(join(options.stateDirectory, "journal"));
    this.transactionDirectory = join(options.stateDirectory, "fs-transactions");
    this.settleDelayMs = options.settleDelayMs ?? 250;
    this.faultInjector = options.faultInjector;
    this.excludedRoots = (options.excludedRoots ?? []).map((item) => resolve(item));
    this.durableIdentity = options.identity !== "path-only";
  }

  static async open(path: string, options: WorkspaceFSOptions): Promise<WorkspaceFS> {
    const root = await realpath(path);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("WorkspaceFS requires a directory");
    const instance = new WorkspaceFS(root, options);
    await mkdir(instance.transactionDirectory, { recursive: true });
    await instance.recoverTransactions();
    instance.initialDiscovery = options.discovery === "none"
      ? { root, files: [], directories: [], pagePathsByID: new Map(), pageIDOwners: new Map() }
      : await discoverWorkspace(root, {
        recursive: options.discovery !== "shallow",
        excludedRoots: instance.excludedRoots,
      });
    instance.loadPageIDs(instance.initialDiscovery);
    if (options.discovery !== "shallow" && options.discovery !== "none") await instance.startWatcher();
    return instance;
  }

  startupDiscovery(): WorkspaceDiscovery {
    if (!this.initialDiscovery) throw new Error("Workspace discovery is unavailable");
    return this.initialDiscovery;
  }

  async discoverRecursively(): Promise<WorkspaceDiscovery> {
    const discovery = await discoverWorkspace(this.root, { excludedRoots: this.excludedRoots });
    this.initialDiscovery = discovery;
    this.loadPageIDs(discovery);
    if (!this.subscription) await this.startWatcher();
    return discovery;
  }

  async setExcludedRoots(roots: readonly string[]): Promise<WorkspaceDiscovery> {
    this.excludedRoots = roots.map((item) => resolve(item));
    const discovery = await discoverWorkspace(this.root, {
      recursive: this.subscription !== undefined,
      excludedRoots: this.excludedRoots,
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
    for (const diagnostic of this.pendingDiagnostics) listener({ type: "diagnostic", path: diagnostic.path, origin: "local-api", diagnostic });
    return () => this.listeners.delete(listener);
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
    const [directInfo, siblingInfo, directPlaceholderInfo, siblingPlaceholderInfo] = await Promise.all([
      stat(direct).catch(() => null),
      path === "/" ? Promise.resolve(null) : stat(sibling).catch(() => null),
      path === "/" ? Promise.resolve(null) : stat(directPlaceholder).catch(() => null),
      path === "/" ? Promise.resolve(null) : stat(siblingPlaceholder).catch(() => null),
    ]);

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
      const diagnostics: Diagnostic[] = hasSibling && hasIndex ? [{
        code: "duplicate-body-representation",
        message: `${path} has competing bodies at ${siblingTreePath} and ${directoryIndexTreePath(path)}; keep only one.`,
        path,
        severity: "error",
      }] : [];
      const bodyPath = hasSibling ? sibling : hasIndex ? indexPath : null;
      return {
        path,
        kind: "directory",
        absolutePath: direct,
        directoryPath: direct,
        bodyPath,
        bodySource: hasSibling ? "sibling" : hasIndex ? "index" : null,
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
    let storedBytes = path ? new Uint8Array(await readFile(path)) : null;
    let storedSource = storedBytes ? new TextDecoder().decode(storedBytes) : "";
    let document = parseMarkdown(storedSource);
    const pageID = isPageID(document.frontmatter.id) ? document.frontmatter.id : null;
    if (pageID && this.durableIdentity && path) {
      this.knownIDs.add(pageID);
      if (!this.pagePathsByID.has(pageID)) this.pagePathsByID.set(pageID, node.path);
      const mtime = (await stat(path)).mtimeMs / 1_000;
      const reconciled = await this.journal.reconcile(pageID, document.blocks, mtime);
      if (reconciled.restored) {
        const repaired = serializeMarkdown(document, reconciled.blocks);
        await writeAtomic(path, repaired);
        await this.journal.markMaterialized(pageID);
        storedBytes = new TextEncoder().encode(repaired);
        storedSource = repaired;
        document = parseMarkdown(repaired);
      }
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
      if (IGNORED.has(entry.name) || RESERVED.has(entry.name) || isTransactionTemporary(entry.name)) continue;
      if (this.isExcludedAbsolute(join(node.directoryPath, entry.name))) continue;
      const logicalName = iCloudPlaceholderLogicalName(entry.name) ?? entry.name;
      const physical = `${node.path === "/" ? "" : node.path}/${logicalName}`;
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

  writeMarkdown(
    inputPath: string,
    request: MarkdownWriteRequest,
    options: {
      onPrepared?: (result: FsWriteResult) => void | Promise<void>;
      onMaterialized?: (result: FsWriteResult) => void | Promise<void>;
    } = {},
  ): Promise<FsWriteResult> {
    return this.writeMarkdownInternal(inputPath, request, undefined, options.onMaterialized, options.onPrepared);
  }

  private async writeMarkdownInternal(
    inputPath: string,
    request: MarkdownWriteRequest,
    transactionId?: string,
    onMaterialized?: (result: FsWriteResult) => void | Promise<void>,
    onPrepared?: (result: FsWriteResult) => void | Promise<void>,
  ): Promise<FsWriteResult> {
    const path = canonicalNodePath(inputPath);
    const coordinator = this.coordinator(path);
    const execute = async (generation: number) => {
      const resolved = await this.resolve(path);
      this.assertMutable(resolved);
      if (resolved.kind === "file") throw new Error("Only Markdown and directory nodes accept Markdown writes");
      const target = resolved.kind === "directory"
        ? resolved.bodyPath ?? resolveTreePath(this.root, directoryIndexTreePath(path))
        : resolved.kind === "markdown"
          ? resolved.bodyPath!
          : resolveTreePath(this.root, siblingMarkdownTreePath(path));
      const current = await this.read(path);
      if (request.baseRevision !== current.byteRevision) {
        throw new FsConflictError({ code: "stale-revision", path, current: await this.read(path) }, "The file changed since it was opened");
      }
      const previousDocument = current.document ?? parseMarkdown("");
      let output = request.source;
      let parsed = parseMarkdown(output);
      let children: FsDirectoryEntry[] = [];
      if (resolved.kind === "directory") {
        children = await this.list(path);
      }
      const pageID = isPageID(parsed.frontmatter.id) ? parsed.frontmatter.id : undefined;
      if (pageID && this.durableIdentity) this.pagePathsByID.set(pageID, path);
      if (pageID && this.durableIdentity && this.coordinators.get(path) === coordinator) {
        this.coordinators.delete(path);
        this.coordinators.set(`id:${pageID}`, coordinator);
      }
      const bytes = new TextEncoder().encode(output);
      const byteRevision = resolved.kind === "directory"
        ? directoryContentRevision(output, children)
        : revisionOf(bytes);
      const preview = {
        node: await this.resolve(path),
        bytes,
        storedBytes: bytes,
        byteRevision,
        storedByteRevision: revisionOf(bytes),
        bodyRevision: bodyRevision(parsed),
        document: parsed,
        pageID,
        generation,
      };
      await onPrepared?.(preview);
      const temporary = await prepareAtomic(target, bytes);
      await this.fault("write:prepared");
      const justBefore = await this.read(path);
      if (justBefore.byteRevision !== current.byteRevision) {
        await removeIfExists(temporary);
        throw new FsConflictError({ code: "stale-revision", path, current: await this.read(path) }, "The file changed while the write was being prepared");
      }
      // Journal after the final source CAS check but before materialization.
      // Reading after an add record is durable intentionally performs crash
      // recovery, so committing earlier would make our own CAS read restore the
      // pending blocks into the still-old file.
      if (pageID && this.durableIdentity) await this.journal.commit(pageID, previousDocument.blocks, parsed.blocks);
      await commitPrepared(temporary, target);
      await this.fault("write:replaced");
      if (pageID && this.durableIdentity) await this.journal.markMaterialized(pageID);
      const accepted = await this.read(path);
      const result = { ...accepted, pageID, generation };
      await onMaterialized?.(result);
      coordinator.remember({ revision: result.byteRevision, bytes: result.bytes ?? bytes, bodyPath: target, generation }, this.settleDelayMs, transactionId
        ? () => {}
        : () => this.emit({
          type: current.storedBytes ? "updated" : "created",
          path,
          byteRevision: result.byteRevision,
          bodyRevision: result.bodyRevision,
          origin: "local-api",
          classification: "echo",
          generation,
          settledGeneration: coordinator.durableGeneration,
        }));
      if (transactionId) this.suppress(path);
      return result;
    };
    return transactionId ? execute(coordinator.reserveGeneration()) : coordinator.enqueue(execute);
  }

  async writeFile(inputPath: string, bytes: Uint8Array, baseRevision?: string): Promise<FsReadResult> {
    const path = normalizeTreePath(inputPath);
    const logicalPath = canonicalNodePath(path);
    return this.coordinator(logicalPath).exclusive(async () => {
      const absolute = await ensureContainedPath(this.root, path);
      const current = await readFile(absolute).catch(() => new Uint8Array());
      if (baseRevision !== undefined && revisionOf(current) !== baseRevision) {
        throw new FsConflictError({ code: "stale-revision", path, current: await this.read(path) }, "The file changed since it was opened");
      }
      await writeAtomic(absolute, bytes);
      this.suppress(logicalPath);
      this.emit({ type: current.length ? "updated" : "created", path: logicalPath, byteRevision: revisionOf(bytes), origin: "local-api", classification: "echo" });
      return this.read(path);
    });
  }

  mutate(
    request: FsMutationRequest,
    options: {
      mutationID?: string;
      onMaterialized?: (result: FsMutationResult) => void | Promise<void>;
    } = {},
  ): Promise<FsMutationResult> {
    const execute = () => this.withNodeLocks(
      this.affectedMutationPaths(request),
      () => this.performMutation(request, options),
    );
    const run = this.mutationTail.then(execute, execute);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  takeRecoveredMutationResults(): Array<{ mutationID: string; result: FsMutationResult }> {
    return this.recoveredMutationResults.splice(0);
  }

  async recovery(inputPath: string) {
    const current = await this.read(inputPath);
    const id = current.document?.frontmatter.id;
    if (!isPageID(id)) return [];
    return this.journal.list(id, current.document!.blocks);
  }

  async restoreBlock(
    inputPath: string,
    hash: string,
    options: {
      onPrepared?: (result: FsWriteResult) => void | Promise<void>;
      onMaterialized?: (result: FsWriteResult) => void | Promise<void>;
    } = {},
  ): Promise<FsWriteResult> {
    const current = await this.read(inputPath);
    const id = current.document?.frontmatter.id;
    if (!isPageID(id)) throw new Error("Page has no durable identity");
    const blocks = await this.journal.restore(id, hash, current.document!.blocks);
    const source = serializeMarkdown(current.document!, blocks);
    return this.writeMarkdown(inputPath, { baseRevision: current.byteRevision, source }, options);
  }

  async restoreMarkdownBytesForRollback(inputPath: string, bytes: Uint8Array | null): Promise<void> {
    const path = canonicalNodePath(inputPath);
    const resolved = await this.resolve(path);
    const target = resolved.kind === "directory"
      ? resolved.bodyPath ?? resolveTreePath(this.root, directoryIndexTreePath(path))
      : resolved.kind === "markdown"
        ? resolved.bodyPath!
        : resolveTreePath(this.root, siblingMarkdownTreePath(path));
    if (bytes) {
      await writeAtomic(target, bytes);
      const document = parseMarkdown(new TextDecoder().decode(bytes));
      if (isPageID(document.frontmatter.id)) await this.journal.markMaterialized(document.frontmatter.id);
    } else {
      await removeIfExists(target);
    }
    this.suppress(path);
  }

  async drain(): Promise<void> {
    await this.mutationTail;
    await Promise.all([...this.coordinators.values()].map((coordinator) => coordinator.drain()));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.drain();
    for (const timer of this.watcherTimers.values()) clearTimeout(timer);
    for (const timer of this.pendingDeleteTimers.values()) clearTimeout(timer);
    for (const coordinator of this.coordinators.values()) if (coordinator.settleTimer) clearTimeout(coordinator.settleTimer);
    await this.subscription?.unsubscribe();
  }

  private assertMutable(node: ResolvedFsNode): void {
    const duplicate = node.diagnostics.find((item) => item.code === "duplicate-body-representation" || item.code === "duplicate-node-representation");
    if (duplicate) throw new FsConflictError({ code: "duplicate-body", path: node.path }, duplicate.message);
    if (!node.writable) throw new FsConflictError({ code: node.materialization === "placeholder" ? "offline" : "read-only", path: node.path }, `${node.path} is not writable`);
  }

  private coordinator(path: string): NodeCoordinator {
    const canonical = canonicalNodePath(path);
    const id = [...this.pagePathsByID].find(([, owner]) => owner === canonical)?.[0];
    const key = id ? `id:${id}` : canonical;
    let value = this.coordinators.get(key);
    if (!value) {
      value = new NodeCoordinator();
      this.coordinators.set(key, value);
    }
    return value;
  }

  private withNodeLocks<T>(paths: string[], task: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(paths.map(canonicalNodePath))].sort();
    const acquire = (index: number): Promise<T> => index === ordered.length
      ? task()
      : this.coordinator(ordered[index]!).exclusive(() => acquire(index + 1));
    return acquire(0);
  }

  private affectedMutationPaths(request: FsMutationRequest): string[] {
    const result = new Set<string>();
    const add = (path: string) => { const canonical = canonicalNodePath(path); result.add(canonical); result.add(parentNodePath(canonical)); };
    for (const operation of request.operations) {
      if (operation.op === "createDirectory" || operation.op === "createMarkdown" || operation.op === "createFile") add(operation.path);
      else if (operation.op === "rename") add(operation.path);
      else if (operation.op === "move" || operation.op === "copy") {
        operation.paths.forEach(add); add(operation.destination);
      } else if (operation.op === "trash" || operation.op === "restore") operation.paths.forEach(add);
      else if (operation.op === "import") add(operation.destination);
    }
    return [...result];
  }

  private existingCoordinator(path: string): NodeCoordinator | undefined {
    const canonical = canonicalNodePath(path);
    const id = [...this.pagePathsByID].find(([, owner]) => owner === canonical)?.[0];
    return this.coordinators.get(id ? `id:${id}` : canonical) ?? this.coordinators.get(canonical);
  }

  private async performMutation(
    request: FsMutationRequest,
    options: {
      mutationID?: string;
      onMaterialized?: (result: FsMutationResult) => void | Promise<void>;
    },
  ): Promise<FsMutationResult> {
    if (!request.operations.length) throw new FsConflictError({ code: "unsupported-entry", path: "/" }, "A mutation must contain at least one operation");
    const destructiveSources = request.operations.flatMap((operation) =>
      operation.op === "rename" ? [canonicalNodePath(operation.path)]
        : operation.op === "move" || operation.op === "trash" || operation.op === "restore" ? operation.paths.map(canonicalNodePath)
          : []
    ).sort();
    for (let index = 0; index < destructiveSources.length; index += 1) {
      const path = destructiveSources[index]!;
      const next = destructiveSources[index + 1];
      if (next === path || next?.startsWith(`${path}/`)) {
        throw new FsConflictError({ code: "unsupported-entry", path }, "A mutation cannot contain duplicate or nested source nodes");
      }
    }
    for (const path of this.affectedMutationPaths(request)) {
      const node = await this.resolve(path);
      if (node.kind !== "missing") this.assertMutable(node);
    }
    const id = crypto.randomUUID();
    const steps: TransactionStep[] = [];
    const changes: FsChange[] = [];
    const destinations = new Set<string>();

    for (const operation of request.operations) {
      await this.planOperation(operation, id, steps, changes, destinations);
    }
    for (const step of steps) step.fingerprint = await this.fingerprint(step.source ?? step.temporary, step.kind);

    const record: TransactionRecord = {
      id,
      mutationID: options.mutationID,
      phase: "prepared",
      steps,
      changes,
    };
    const recordPath = this.transactionPath(id);
    await writeAtomic(recordPath, JSON.stringify(record));
    await this.fault("mutation:prepared");

    try {
      record.phase = "committing";
      await writeAtomic(recordPath, JSON.stringify(record));
      for (const step of steps) {
        if (step.source) {
          await rename(step.source, step.temporary);
          await syncDirectory(dirname(step.source));
        }
        await this.fault("mutation:source-staged");
      }
      for (const step of steps) {
        await mkdir(dirname(step.destination), { recursive: true });
        await rename(step.temporary, step.destination);
        await syncDirectory(dirname(step.destination));
        if (dirname(step.temporary) !== dirname(step.destination)) await syncDirectory(dirname(step.temporary));
        await this.fault("mutation:destination-committed");
      }
      record.phase = "committed";
      await writeAtomic(recordPath, JSON.stringify(record));
      await this.fault("mutation:committed");
      const materializedResult = this.mutationResult(id, changes);
      await options.onMaterialized?.(materializedResult);
      await rm(recordPath, { force: true });
    } catch (error) {
      if (error instanceof FsInjectedCrashError) throw error;
      let rollbackFailed = false;
      for (const step of [...steps].reverse()) {
        try {
          if (step.source && await pathExists(step.destination)) {
            await mkdir(dirname(step.source), { recursive: true });
            await rename(step.destination, step.source);
          } else if (step.source && await pathExists(step.temporary)) {
            await mkdir(dirname(step.source), { recursive: true });
            await rename(step.temporary, step.source);
          } else if (!step.source) {
            await removeIfExists(step.destination);
            await removeIfExists(step.temporary);
          }
        } catch { rollbackFailed = true; }
      }
      if (rollbackFailed) {
        record.phase = "interrupted";
        record.message = error instanceof Error ? error.message : String(error);
        await writeAtomic(recordPath, JSON.stringify(record));
      } else await rm(recordPath, { force: true });
      throw error;
    }

    for (const change of changes) {
      if (change.previousPath) this.suppress(change.previousPath);
      this.suppress(change.path);
    }
    this.emit({ type: "batch", path: "/", transactionId: id, origin: "local-api", classification: "echo", changes });
    return this.mutationResult(id, changes);
  }

  private mutationResult(transactionId: string, changes: FsChange[]): FsMutationResult {
    return {
      transactionId,
      changes,
      created: changes.filter((change) => change.kind === "created").map((change) => change.path),
      updated: changes.filter((change) => change.kind === "updated").map((change) => change.path),
      moved: changes.filter((change) => change.kind === "moved" && change.previousPath).map((change) => ({ from: change.previousPath!, to: change.path })),
      deleted: changes.filter((change) => change.kind === "deleted").map((change) => change.path),
    };
  }

  private async planOperation(
    operation: FsMutation,
    transactionId: string,
    steps: TransactionStep[],
    changes: FsChange[],
    destinations: Set<string>,
  ): Promise<void> {
    if (operation.op === "createDirectory") {
      const path = normalizeTreePath(operation.path);
      validateLogicalName(basename(path));
      const destination = await ensureContainedPath(this.root, path);
      await this.assertDestinationFree(path, [destination], destinations);
      const stagedParent = await this.stagedParent(dirname(destination), transactionId, steps, destinations);
      if (stagedParent) {
        this.recordParentMaterialization(dirname(destination), changes);
        await mkdir(join(stagedParent, basename(destination)), { recursive: true });
      }
      else {
        const temporary = transactionTemporaryPath(destination, transactionId);
        await mkdir(temporary, { recursive: true });
        steps.push({ temporary, destination, kind: "directory" });
      }
      changes.push({ path: canonicalNodePath(path), kind: "created" });
      return;
    }
    if (operation.op === "createMarkdown") {
      const path = canonicalNodePath(operation.path);
      validateLogicalName(nodeDisplayName(path));
      const destination = resolveTreePath(this.root, siblingMarkdownTreePath(path));
      await this.assertDestinationFree(path, [destination, resolveTreePath(this.root, path)], destinations);
      const output = operation.source ?? "";
      const stagedParent = await this.stagedParent(dirname(destination), transactionId, steps, destinations);
      if (stagedParent) {
        this.recordParentMaterialization(dirname(destination), changes);
        const stagedDestination = join(stagedParent, basename(destination));
        const prepared = await prepareAtomic(stagedDestination, output);
        await commitPrepared(prepared, stagedDestination);
      } else {
        const temporary = transactionTemporaryPath(destination, transactionId);
        await prepareAtomic(destination, output, temporary);
        steps.push({ temporary, destination, kind: "file" });
      }
      changes.push({ path, kind: "created" });
      return;
    }
    if (operation.op === "createFile") {
      const path = normalizeTreePath(operation.path);
      validateName(nodeDisplayName(path));
      const destination = await ensureContainedPath(this.root, path);
      await this.assertDestinationFree(path, [destination], destinations);
      const stagedParent = await this.stagedParent(dirname(destination), transactionId, steps, destinations);
      if (stagedParent) {
        this.recordParentMaterialization(dirname(destination), changes);
        const stagedDestination = join(stagedParent, basename(destination));
        const prepared = await prepareAtomic(stagedDestination, operation.bytes);
        await commitPrepared(prepared, stagedDestination);
      } else {
        const temporary = transactionTemporaryPath(destination, transactionId);
        await prepareAtomic(destination, operation.bytes, temporary);
        steps.push({ temporary, destination, kind: "file" });
      }
      changes.push({ path: canonicalNodePath(path), kind: "created" });
      return;
    }
    if (operation.op === "import") {
      await this.planImport(operation.destination, operation.entries, transactionId, steps, changes, destinations);
      return;
    }
    if (operation.op === "rename") {
      validateLogicalName(operation.name);
      const source = canonicalNodePath(operation.path);
      await this.ensureIdentityBeforePathChange(source, transactionId, { materializeImplicit: false });
      await this.planMove([source], parentNodePath(source), operation.name, transactionId, steps, changes, destinations);
      return;
    }
    if (operation.op === "move") {
      const paths = operation.paths.map(canonicalNodePath);
      const destination = canonicalNodePath(operation.destination);
      const destinationNode = await this.resolve(destination);
      if (destinationNode.kind !== "directory") throw new FsConflictError({ code: "not-found", path: destination }, `Move destination is not a directory: ${destination}`);
      for (const path of paths) {
        await this.ensureIdentityBeforePathChange(path, transactionId, { materializeImplicit: false });
      }
      await this.planMove(paths, destination, undefined, transactionId, steps, changes, destinations);
      return;
    }
    if (operation.op === "trash") {
      const paths = operation.paths.map(canonicalNodePath);
      for (const path of paths) {
        await this.ensureIdentityBeforePathChange(path, transactionId, { materializeImplicit: false });
      }
      await this.planMove(paths, "/Trash", undefined, transactionId, steps, changes, destinations, true);
      return;
    }
    if (operation.op === "restore") {
      for (const pathInput of operation.paths) {
        const path = canonicalNodePath(pathInput);
        if (!path.startsWith("/Trash/")) throw new FsConflictError({ code: "invalid-name", path }, "Restore paths must be inside Trash");
        const destination = path.slice("/Trash".length) || "/";
        await this.planMove([path], parentNodePath(destination), nodeDisplayName(destination), transactionId, steps, changes, destinations);
      }
      return;
    }
    if (operation.op === "copy") {
      const destination = canonicalNodePath(operation.destination);
      const destinationNode = await this.resolve(destination);
      if (destinationNode.kind !== "directory") throw new FsConflictError({ code: "not-found", path: destination }, `Copy destination is not a directory: ${destination}`);
      for (const pathInput of operation.paths) {
        const node = await this.resolve(pathInput);
        if (node.kind === "missing") throw new FsConflictError({ code: "not-found", path: node.path }, `Node not found: ${node.path}`);
        const target = canonicalNodePath(`${destination === "/" ? "" : destination}/${nodeDisplayName(node.path)}`);
        const parts = this.physicalParts(node, target);
        await this.assertDestinationFree(target, parts.map((part) => part.destination), destinations);
        for (const part of parts) {
          const temporary = transactionTemporaryPath(part.destination, transactionId);
          await cp(part.source, temporary, { recursive: true, errorOnExist: true });
          await this.remintCopiedPageIDs(temporary, part.kind, part.destination);
          steps.push({ temporary, destination: part.destination, kind: part.kind });
        }
        changes.push({ path: target, kind: "created" });
      }
      return;
    }
    throw new FsConflictError({ code: "unsupported-entry", path: "/" }, `Unsupported filesystem mutation: ${(operation as { op?: unknown }).op}`);
  }

  private async planMove(
    sourcePaths: string[],
    destinationDirectory: string,
    renameTo: string | undefined,
    transactionId: string,
    steps: TransactionStep[],
    changes: FsChange[],
    destinations: Set<string>,
    trash = false,
  ): Promise<void> {
    for (const sourcePath of sourcePaths) {
      const node = await this.resolve(sourcePath);
      if (node.kind === "missing") throw new FsConflictError({ code: "not-found", path: node.path }, `Node not found: ${node.path}`);
      this.assertMutable(node);
      const name = renameTo ?? nodeDisplayName(node.path);
      validateLogicalName(name);
      const baseDirectory = trash ? `/Trash${parentNodePath(node.path) === "/" ? "" : parentNodePath(node.path)}` : destinationDirectory;
      const target = canonicalNodePath(`${baseDirectory === "/" ? "" : baseDirectory}/${name}`);
      if (node.kind === "directory" && (target === node.path || target.startsWith(`${node.path}/`))) {
        if (target === node.path) continue;
        throw new FsConflictError({ code: "recursive-move", path: node.path }, "A directory cannot be moved into itself");
      }
      const parts = this.physicalParts(node, target);
      await this.assertDestinationFree(target, parts.map((part) => part.destination), destinations);
      for (const part of parts) {
        steps.push({
          source: part.source,
          temporary: transactionTemporaryPath(part.source, transactionId),
          destination: part.destination,
          kind: part.kind,
        });
      }
      let pageID: string | undefined;
      if (node.kind === "markdown" || node.kind === "directory") {
        const read = await this.read(node.path).catch(() => null);
        const id = read?.document?.frontmatter.id;
        if (isPageID(id)) pageID = id;
      }
      changes.push(trash
        ? { path: node.path, kind: "deleted", pageID }
        : { path: target, previousPath: node.path, kind: "moved", pageID });
    }
  }

  private async stagedParent(
    physicalParent: string,
    transactionId: string,
    steps: TransactionStep[],
    destinations: Set<string>,
  ): Promise<string | null> {
    const existing = await stat(physicalParent).catch(() => null);
    if (existing?.isDirectory()) return null;
    if (existing) throw new FsConflictError({ code: "unsupported-entry", path: toTreePath(this.root, physicalParent) }, "A file cannot contain workspace children");
    const planned = steps.find((step) => !step.source && step.kind === "directory" && step.destination === physicalParent);
    if (planned) return planned.temporary;
    const logicalParent = canonicalNodePath(toTreePath(this.root, physicalParent));
    const node = await this.resolve(logicalParent);
    if (node.kind !== "markdown") {
      throw new FsConflictError({ code: "not-found", path: logicalParent }, `Parent directory does not exist: ${logicalParent}`);
    }
    if (destinations.has(physicalParent)) {
      throw new FsConflictError({ code: "occupied-destination", path: logicalParent }, `Destination already exists: ${logicalParent}`);
    }
    destinations.add(physicalParent);
    const temporary = transactionTemporaryPath(physicalParent, transactionId);
    await mkdir(temporary, { recursive: true });
    steps.push({ temporary, destination: physicalParent, kind: "directory" });
    return temporary;
  }

  private recordParentMaterialization(physicalParent: string, changes: FsChange[]): void {
    const path = canonicalNodePath(toTreePath(this.root, physicalParent));
    if (!changes.some((change) => change.path === path && change.kind === "updated")) changes.push({ path, kind: "updated" });
  }

  private physicalParts(node: ResolvedFsNode, target: string): Array<{ source: string; destination: string; kind: "file" | "directory" }> {
    if (node.kind === "directory") {
      const result: Array<{ source: string; destination: string; kind: "file" | "directory" }> = [
        { source: node.directoryPath!, destination: resolveTreePath(this.root, target), kind: "directory" },
      ];
      if (node.bodySource === "sibling" && node.bodyPath) result.unshift({ source: node.bodyPath, destination: resolveTreePath(this.root, siblingMarkdownTreePath(target)), kind: "file" as const });
      return result;
    }
    if (node.kind === "markdown") return [{ source: node.bodyPath!, destination: resolveTreePath(this.root, siblingMarkdownTreePath(target)), kind: "file" }];
    return [{ source: node.absolutePath, destination: resolveTreePath(this.root, target), kind: "file" }];
  }

  /**
   * Ensure a Markdown-bodied document carries a durable page ID before its
   * path changes, minting one (and materializing a frontmatter-only
   * `_index.md` for an implicit directory) when absent. The write happens
   * before staging; a later rollback leaves the harmless ID in place.
   */
  private async ensureIdentityBeforePathChange(path: string, transactionId: string, options: { materializeImplicit: boolean }): Promise<string | null> {
    const read = await this.read(path);
    if (!read.document) return null;
    const existing = read.document.frontmatter.id;
    if (isPageID(existing)) return existing;
    if (!this.durableIdentity) return null;
    if (read.node.bodySource === null && !options.materializeImplicit) return null;
    const pageID = mintPageID(this.knownIDs);
    this.knownIDs.add(pageID);
    const source = `${patchFrontmatter(read.document.frontmatterSource, { id: pageID }) ?? ""}${read.document.bodySource}`;
    const result = await this.writeMarkdownInternal(
      path,
      { baseRevision: read.byteRevision, source },
      transactionId,
    );
    return result.pageID ?? null;
  }

  private async assertDestinationFree(logicalPath: string, physicalPaths: string[], destinations: Set<string>): Promise<void> {
    const logical = await this.resolve(logicalPath);
    if (logical.kind !== "missing") throw new FsConflictError({ code: "occupied-destination", path: logicalPath }, `Destination already exists: ${logicalPath}`);
    for (const path of physicalPaths) {
      if (destinations.has(path) || await pathExists(path)) throw new FsConflictError({ code: "occupied-destination", path: logicalPath }, `Destination already exists: ${logicalPath}`);
      destinations.add(path);
    }
  }

  private async remintCopiedPageIDs(
    physicalPath: string,
    kind: "file" | "directory",
    destinationPath: string,
  ): Promise<void> {
    if (!this.durableIdentity) return;
    if (kind === "directory") {
      const entries = await readdir(physicalPath, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        await this.remintCopiedPageIDs(
          join(physicalPath, entry.name),
          entry.isDirectory() ? "directory" : "file",
          join(destinationPath, entry.name),
        );
      }
      return;
    }
    if (extname(destinationPath).toLowerCase() !== ".md") return;
    const source = await readFile(physicalPath, "utf8");
    const document = parseMarkdown(source);
    if (!isPageID(document.frontmatter.id)) return;
    const pageID = mintPageID(this.knownIDs);
    this.knownIDs.add(pageID);
    const output = `${patchFrontmatter(document.frontmatterSource, { id: pageID }) ?? ""}${document.bodySource}`;
    await writeAtomic(physicalPath, output);
  }

  private async planImport(
    destinationInput: string,
    entries: FsImportEntry[],
    transactionId: string,
    steps: TransactionStep[],
    changes: FsChange[],
    destinations: Set<string>,
  ): Promise<void> {
    const destination = canonicalNodePath(destinationInput);
    const destinationNode = await this.resolve(destination);
    if (destinationNode.kind !== "directory" || !destinationNode.directoryPath) throw new FsConflictError({ code: "not-found", path: destination }, "Import destination is not a directory");
    const normalized = entries.map((entry) => {
      const parts = entry.path.replaceAll("\\", "/").split("/").filter(Boolean);
      if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
        throw new FsConflictError({ code: "unsafe-path", path: entry.path }, `Unsafe import path: ${entry.path}`);
      }
      parts.forEach(validateName);
      return { ...entry, parts };
    });
    const topNames = [...new Set(normalized.map((entry) => entry.parts[0]!))];
    for (const name of topNames) {
      const targetLogical = canonicalNodePath(`${destination === "/" ? "" : destination}/${name}`);
      const target = resolveTreePath(this.root, `${destination === "/" ? "" : destination}/${name}`);
      await this.assertDestinationFree(targetLogical, [target], destinations);
      const temporary = transactionTemporaryPath(target, transactionId);
      const topEntries = normalized.filter((entry) => entry.parts[0] === name);
      const topIsFile = topEntries.length === 1 && topEntries[0]!.kind === "file" && topEntries[0]!.parts.length === 1;
      if (topIsFile) await prepareAtomic(target, topEntries[0]!.bytes ?? new Uint8Array(), temporary);
      else {
        await mkdir(temporary, { recursive: true });
        for (const entry of topEntries) {
          const relativeParts = entry.parts.slice(1);
          const absolute = join(temporary, ...relativeParts);
          if (entry.kind === "directory") await mkdir(absolute, { recursive: true });
          else {
            await mkdir(dirname(absolute), { recursive: true });
            const prepared = await prepareAtomic(absolute, entry.bytes ?? new Uint8Array());
            await commitPrepared(prepared, absolute);
          }
        }
      }
      steps.push({ temporary, destination: target, kind: topIsFile ? "file" : "directory" });
      changes.push({ path: targetLogical, kind: "created" });
    }
  }

  private async startWatcher(): Promise<void> {
    this.subscription = await watcher.subscribe(this.root, async (error, events) => {
      if (error) {
        this.emit({ type: "diagnostic", path: "/", origin: "local-external", diagnostic: { code: "watcher-error", message: error.message, path: "/", severity: "error" } });
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
    try { treePath = nodePathFromPhysical(toTreePath(this.root, logicalAbsolute)); } catch { return; }
    const path = canonicalNodePath(treePath);
    const old = this.watcherTimers.get(path);
    if (old) clearTimeout(old);
    this.watcherTimers.set(path, setTimeout(() => {
      this.watcherTimers.delete(path);
      void this.handleWatch(path, type);
    }, 60));
  }

  private async handleWatch(path: string, type: watcher.EventType): Promise<void> {
    if ((this.suppressedPaths.get(path) ?? 0) > Date.now()) return;
    const current = await this.read(path).catch(() => null);
    if (!current || current.node.kind === "missing") {
      if ((this.recentExternalMoves.get(path) ?? 0) > Date.now()) {
        this.recentExternalMoves.delete(path);
        return;
      }
      const durableID = [...this.pagePathsByID].find(([, owner]) => owner === path)?.[0];
      if (!durableID) {
        this.emit({ type: "deleted", path, origin: "local-external", classification: "external" });
        return;
      }
      const old = this.pendingDeleteTimers.get(path);
      if (old) clearTimeout(old);
      this.pendingDeleteTimers.set(path, setTimeout(() => {
        this.pendingDeleteTimers.delete(path);
        if (this.pagePathsByID.get(durableID) === path) {
          this.pagePathsByID.delete(durableID);
          this.emit({ type: "deleted", path, origin: "local-external", classification: "external" });
        }
      }, 160));
      return;
    }
    const coordinator = this.existingCoordinator(path);
    const revision = current.byteRevision;
    if (coordinator?.settleEcho(revision)) return;
    const oldAuthored = coordinator?.recent.find((item) => item.revision === revision);
    if (coordinator?.unsettled && oldAuthored && coordinator.recent[0] && oldAuthored !== coordinator.recent[0]) {
      const latest = coordinator.recent[0];
      await writeAtomic(latest.bodyPath, latest.bytes);
      this.emit({
        type: "updated",
        path,
        byteRevision: latest.revision,
        generation: latest.generation,
        settledGeneration: coordinator.durableGeneration,
        origin: "local-api",
        classification: "stomp",
      });
      return;
    }
    if (current.document) {
      const id = current.document.frontmatter.id;
      if (isPageID(id)) {
        await this.journal.observe(id, current.document.blocks);
        const previous = this.pagePathsByID.get(id);
        this.pagePathsByID.set(id, path);
        if (previous && previous !== path) {
          this.recentExternalMoves.set(previous, Date.now() + 500);
          const pending = this.pendingDeleteTimers.get(previous);
          if (pending) {
            clearTimeout(pending);
            this.pendingDeleteTimers.delete(previous);
          }
          this.emit({ type: "moved", path, previousPath: previous, byteRevision: revision, bodyRevision: current.bodyRevision, origin: "local-external", classification: "external" });
          return;
        }
      }
    }
    this.emit({
      type: type === "create" ? "created" : "updated",
      path,
      byteRevision: revision,
      bodyRevision: current.bodyRevision,
      origin: "local-external",
      classification: "external",
    });
  }

  private suppress(path: string): void {
    this.suppressedPaths.set(canonicalNodePath(path), Date.now() + Math.max(500, this.settleDelayMs * 2));
  }

  private loadPageIDs(discovery: WorkspaceDiscovery): void {
    for (const [id, path] of discovery.pagePathsByID) {
      this.knownIDs.add(id);
      this.pagePathsByID.set(id, path);
    }
  }

  private async recoverTransactions(): Promise<void> {
    for (const entry of await readdir(this.transactionDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.transactionDirectory, entry.name);
      let record: TransactionRecord;
      try { record = JSON.parse(await readFile(path, "utf8")) as TransactionRecord; }
      catch { continue; }
      if (record.phase === "prepared") {
        let unfamiliar = false;
        for (const step of record.steps) {
          if (!await pathExists(step.temporary)) continue;
          if (step.fingerprint && await this.fingerprint(step.temporary, step.kind) !== step.fingerprint) unfamiliar = true;
          else await removeIfExists(step.temporary);
        }
        if (unfamiliar) {
          record.phase = "interrupted";
          record.message = "Prepared transaction staging contains unfamiliar bytes";
          this.pendingDiagnostics.push(this.interruptedDiagnostic(record));
          await writeAtomic(path, JSON.stringify(record));
        } else await rm(path, { force: true });
        continue;
      }
      if (record.phase === "committed") {
        if (record.mutationID) {
          this.recoveredMutationResults.push({
            mutationID: record.mutationID,
            result: this.mutationResult(record.id, record.changes),
          });
        }
        await rm(path, { force: true });
        continue;
      }
      let interrupted = false;
      for (const step of record.steps) {
        const candidates = [step.source, step.temporary, step.destination].filter((candidate): candidate is string => Boolean(candidate));
        const existing = [];
        for (const candidate of candidates) if (await pathExists(candidate)) existing.push(candidate);
        if (existing.length !== 1) { interrupted = true; continue; }
        const candidate = existing[0]!;
        if (step.fingerprint && await this.fingerprint(candidate, step.kind) !== step.fingerprint) { interrupted = true; continue; }
        if (candidate === step.destination) continue;
        if (candidate === step.temporary) {
          await mkdir(dirname(step.destination), { recursive: true });
          await rename(step.temporary, step.destination);
        } else if (step.source && candidate === step.source) {
          await mkdir(dirname(step.destination), { recursive: true });
          await rename(step.source, step.destination);
        } else interrupted = true;
      }
      if (interrupted) {
        this.pendingDiagnostics.push(this.interruptedDiagnostic(record));
        record.phase = "interrupted";
        await writeAtomic(path, JSON.stringify(record));
      } else {
        if (record.mutationID) {
          this.recoveredMutationResults.push({
            mutationID: record.mutationID,
            result: this.mutationResult(record.id, record.changes),
          });
        }
        await rm(path, { force: true });
      }
    }
  }

  private interruptedDiagnostic(record: TransactionRecord): Diagnostic {
    return {
      code: "interrupted-fs-transaction",
      message: `Filesystem transaction ${record.id} could not be recovered automatically; every discoverable version was preserved.`,
      path: "/",
      severity: "error",
    };
  }

  private async fingerprint(path: string, kind: "file" | "directory"): Promise<string> {
    if (kind === "file") return sha256(new Uint8Array(await readFile(path)));
    const parts: string[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          parts.push(`d:${relativePath}`);
          await walk(absolute, relativePath);
        } else if (entry.isFile()) parts.push(`f:${relativePath}:${sha256(new Uint8Array(await readFile(absolute)))}`);
        else parts.push(`u:${relativePath}`);
      }
    };
    await walk(path, "");
    return sha256(parts.join("\n"));
  }

  private async isWritable(path: string): Promise<boolean> {
    try { await access(path, constants.W_OK); return true; }
    catch { return false; }
  }

  private transactionPath(id: string): string {
    return join(this.transactionDirectory, `${id}.json`);
  }

  private async fault(point: string): Promise<void> {
    try { await this.faultInjector?.(point); }
    catch (error) { throw new FsInjectedCrashError(point, { cause: error }); }
  }
}
