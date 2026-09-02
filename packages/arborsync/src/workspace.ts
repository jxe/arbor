import { stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative } from "node:path";
import type {
  ArborBlock,
  BacklinkEntry,
  BacklinksPage,
  ChildrenPage,
  ContentWorkspaceOperation,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeResponse,
  NodeWriteRequest,
  RecoveryEntry,
  RecoveryPage,
  LocalTreeDescriptor,
  TreeID,
  SearchPage,
  StructuralWorkspaceOperation,
  WorkspaceOperation,
} from "@arbor/core";
import {
  stableJSONString,
  canonicalNodePath,
  applySourceEdits,
  isPageID,
  pageIDFromStableKey,
  pageIDStableKey,
  revisionOf,
  sha256,
} from "@arbor/core";
import {
  type FsEvent,
  FsConflictError,
  FsInjectedCrashError,
  type FsImportEntry,
  type FsMutation,
  type FsMutationRequest,
  type FsWriteResult,
  MutationJournal,
  type WorkspaceDiscovery,
  WorkspaceFS,
} from "@arbor/fs";
import { mintPageID, patchFrontmatter, serializeMarkdown } from "@arbor/editor";
import {
  ProjectionProviderError,
  type ProjectionWriteTarget,
  WorkspaceIndex,
  workspaceState,
} from "@arbor/stores";
import { EventBus } from "./events.ts";
import { rootDisplayName } from "./root-title.ts";
import type { ExpandedNode } from "./node-sampling.ts";
import { decodePageCursor, encodePageCursor } from "./cursors.ts";
import { ProtocolError, RevisionConflictError } from "./protocol-error.ts";
import { generateTreeTypes, generatedTypeDeclarationPath } from "./generated-types.ts";

export { ProtocolError, RevisionConflictError } from "./protocol-error.ts";
import { FilesystemNodeSurface } from "./filesystem-node-surface.ts";
import { writeFilesystemProperties } from "./filesystem-property-write.ts";
import { NodeProviderRouter } from "./node-provider-router.ts";
import { resolveTreePath } from "@arbor/core/path";


const EMPTY_REVISION = revisionOf("");
export interface WorkspaceOptions {
  faultInjector?: (stage: string) => void | Promise<void>;
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
}

export interface ConfirmedSourcePatch {
  baseSource: string;
  resultSource: string;
  edits: NonNullable<Extract<WorkspaceOperation, { op: "writeMarkdown" }>["sourceEdits"]>;
}

export class Workspace implements AsyncDisposable {
  readonly root: string;
  readonly events: EventBus;
  /** This workspace's scope tag. Shared workspaces use a stable TreeID. */
  readonly tree: TreeID;
  tracking: "tracked" | "session";
  readonly fs: WorkspaceFS;
  readonly mutations: MutationJournal;
  private stateDirectory: string;
  private index: WorkspaceIndex;
  private surface: FilesystemNodeSurface;
  private provider: NodeProviderRouter;
  private idOwners = new Map<string, string>();
  private idOwnerSets = new Map<string, readonly string[]>();
  private displayName: string;
  private treeDescriptor: Partial<LocalTreeDescriptor>;
  private discovery: "recursive" | "shallow";
  private excludedRoots: string[];
  /** Inverted unambiguous owner index: path -> pageID. */
  private pathPageIDs = new Map<string, string>();
  private healingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeFS: () => void;
  private faultInjector?: WorkspaceOptions["faultInjector"];

  private constructor(root: string, stateDirectory: string, fs: WorkspaceFS, index: WorkspaceIndex, options: WorkspaceOptions) {
    this.root = root;
    this.events = options.events ?? new EventBus();
    this.tree = options.tree ?? `rt_${sha256(root).slice(0, 10)}`;
    this.displayName = options.displayName ?? basename(root);
    this.treeDescriptor = options.treeDescriptor ?? {};
    this.discovery = options.discovery ?? "recursive";
    this.excludedRoots = [...(options.excludedRoots ?? [])].sort();
    this.tracking = options.tracking ?? "session";
    this.stateDirectory = stateDirectory;
    this.fs = fs;
    this.mutations = new MutationJournal(join(stateDirectory, "journal", "mutations"));
    this.index = index;
    this.faultInjector = options.faultInjector;
    this.unsubscribeFS = fs.subscribe((event) => { void this.handleFsEvent(event); });
    this.surface = new FilesystemNodeSurface({
      tree: this.tree,
      enclosingTree: () => this.descriptor(),
      fs: () => this.fs,
      resolveRef: (ref) => this.resolveRef(ref),
      rootName: basename(this.root),
      writable: async (path) => {
        const resolved = await this.fs.resolve(path);
        return resolved.writable && this.treeDescriptor.access !== "read";
      },
      writableNode: (node) => node.writable && this.treeDescriptor.access !== "read",
      inspectDocument: ({ path, revision, document }) => {
        const pageID = this.registerPageID(path, document.frontmatter.id);
        if (pageID) this.scheduleLinkHealing(path, revision, document);
        return this.pageIDDiagnostics(path, pageID);
      },
      childPageID: (path, discovered) => discovered ?? this.pathPageIDs.get(path),
      notFound: (path) => new ProtocolError("not-found", `Node not found: ${path}`, 404, { path }),
      invalidChildren: (path) => new ProtocolError("invalid-reference", `${path} does not have children`, 400, { path }),
    });
    this.provider = new NodeProviderRouter(this.surface);
  }

  private mutationRef(path: string, pageID?: string, stableKey?: string | null): NodeRef {
    return {
      tree: this.tree,
      path,
      stableKey: stableKey ?? (pageID ? pageIDStableKey(pageID) : this.pathPageIDs.get(path) ? pageIDStableKey(this.pathPageIDs.get(path)!) : null),
    };
  }

  static async open(path: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const state = await workspaceState(path);
    const stateDirectory = state.directory;
    const fs = await WorkspaceFS.open(path, {
      stateDirectory,
      faultInjector: options.faultInjector,
      discovery: options.discovery,
      excludedRoots: options.excludedRoots,
    });
    const discovery = fs.startupDiscovery();
    const index = new WorkspaceIndex(fs.root, join(stateDirectory, "index.sqlite"));
    const workspace = new Workspace(fs.root, stateDirectory, fs, index, {
      ...options,
      tree: options.tree ?? state.identity.rootID,
      displayName: options.displayName ?? await rootDisplayName(fs.root),
    });
    workspace.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    const startupTasks: Promise<unknown>[] = [index.rebuild(discovery)];
    if (workspace.discovery === "recursive") startupTasks.push(workspace.generateTypes(discovery));
    await Promise.all(startupTasks);
    await workspace.finishRecoveredMutations();
    return workspace;
  }

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

  describeWireRollup(directory: string, sourceName: string) {
    return this.provider.fileRollupDescriptor(directory, sourceName);
  }

  updateTreeDescriptor(descriptor: Partial<LocalTreeDescriptor>): void {
    this.treeDescriptor = { ...this.treeDescriptor, ...descriptor };
  }

  async activateRecursiveDiscovery(): Promise<void> {
    if (this.discovery === "recursive") return;
    const discovery = await this.fs.discoverRecursively();
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    await Promise.all([this.index.rebuild(discovery), this.generateTypes(discovery)]);
    this.discovery = "recursive";
  }

  async updateExcludedRoots(roots: readonly string[]): Promise<void> {
    const next = [...roots].sort();
    if (next.length === this.excludedRoots.length && next.every((root, index) => root === this.excludedRoots[index])) return;
    this.excludedRoots = next;
    const discovery = await this.fs.setExcludedRoots(next);
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    if (this.discovery === "recursive") {
      await Promise.all([this.index.rebuild(discovery), this.generateTypes(discovery)]);
    }
  }

  async refreshDisplayName(): Promise<string> {
    this.displayName = await rootDisplayName(this.root);
    return this.displayName;
  }

  async snapshot(ref: NodeRef): Promise<NodeResponse> {
    const observedThrough = this.events.currentCursor();
    return this.provider.snapshot(ref, observedThrough);
  }

  async children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    const observedThrough = this.events.currentCursor();
    try {
      return await this.provider.children(ref, cursor ?? null, observedThrough);
    } catch (error) {
      if (error instanceof ProjectionProviderError && error.code === "invalid-cursor") {
        throw new ProtocolError("invalid-reference", error.message, 400, { path: ref.path });
      }
      throw error;
    }
  }

  async searchPage(query: string, cursor?: string | null): Promise<SearchPage> {
    const observedThrough = this.events.currentCursor();
    const offset = decodePageCursor(cursor, `search:${query}`);
    const results = this.index.search(query, 30, offset).map((result) => {
      const pageID = this.pathPageIDs.get(result.path);
      return {
        ...result,
        ref: {
          tree: this.tree,
          path: result.path,
          stableKey: pageID ? pageIDStableKey(pageID) : null,
        },
      };
    });
    return {
      results,
      nextCursor: results.length === 30 ? encodePageCursor(`search:${query}`, offset + results.length) : null,
      observedThrough,
    };
  }

  async backlinksPage(ref: NodeRef, cursor?: string | null): Promise<BacklinksPage> {
    const observedThrough = this.events.currentCursor();
    const path = await this.resolveRef(ref);
    const target = await this.expandedNode(path);
    const pageID = isPageID(target.document?.frontmatter.id)
      ? target.document.frontmatter.id
      : this.pathPageIDs.get(path);
    const offset = decodePageCursor(cursor, `backlinks:${path}:${pageID ?? ""}`);
    const entries = this.index.backlinks(path, pageID, this.tree, true, 30, offset).map((entry) => {
      const sourcePageID = this.pathPageIDs.get(entry.path);
      return {
        ref: {
          tree: this.tree,
          path: entry.path,
          stableKey: sourcePageID ? pageIDStableKey(sourcePageID) : null,
        },
        title: entry.title,
        context: entry.context,
      };
    });
    return {
      target: { tree: this.tree, path, stableKey: pageID ? pageIDStableKey(pageID) : null },
      entries,
      nextCursor: entries.length === 30
        ? encodePageCursor(`backlinks:${path}:${pageID ?? ""}`, offset + entries.length)
        : null,
      observedThrough,
    };
  }

  backlinksTo(target: { tree: string; path: string; pageID?: string }, limit = 30): BacklinkEntry[] {
    return this.index.backlinks(target.path, target.pageID, target.tree, false, limit, 0).map((entry) => {
      const sourcePageID = this.pathPageIDs.get(entry.path);
      return {
        ref: {
          tree: this.tree,
          path: entry.path,
          stableKey: sourcePageID ? pageIDStableKey(sourcePageID) : null,
        },
        title: entry.title,
        context: entry.context,
      };
    });
  }

  async recoveryPage(
    ref: NodeRef,
    recursive = false,
    cursor?: string | null,
  ): Promise<RecoveryPage> {
    const observedThrough = this.events.currentCursor();
    const path = await this.resolveRef(ref);
    const snapshot = await this.expandedNode(path);
    if (recursive && snapshot.kind !== "directory") {
      throw new ProtocolError("invalid-reference", "Recursive recovery requires a directory", 400, { path });
    }
    const key = `recovery:${path}:${recursive ? "subtree" : "node"}`;
    const offset = decodePageCursor(cursor, key);
    const allEntries = recursive
      ? await this.subtreeRecoveryEntries(path)
      : await this.blockRecoveryEntries(path);
    allEntries.sort((a, b) => b.changedAt - a.changedAt || a.ref.path.localeCompare(b.ref.path));
    const entries = allEntries.slice(offset, offset + 100);
    const nextOffset = offset + entries.length;
    return {
      ref: {
        tree: this.tree,
        path,
        stableKey: isPageID(snapshot.document?.frontmatter.id) ? pageIDStableKey(snapshot.document.frontmatter.id) : null,
      },
      entries,
      nextCursor: nextOffset < allEntries.length ? encodePageCursor(key, nextOffset) : null,
      observedThrough,
    };
  }

  async executeMutation(request: MutationRequest): Promise<MutationReceipt> {
    this.requireWriteAccess();
    if (!request.mutationID || !Array.isArray(request.operations) || request.operations.length === 0) {
      throw new ProtocolError("invalid-reference", "A mutation requires a non-empty mutation ID and operations array", 400);
    }
    const contentOperations = request.operations.filter((operation) =>
      operation.op === "writeProperties" || operation.op === "writeMarkdown" || operation.op === "writeText" || operation.op === "restoreRecovery"
    );
    if (contentOperations.length > 0 && (contentOperations.length !== 1 || request.operations.length !== 1)) {
      throw new ProtocolError(
        "unsupported-operation",
        "A content mutation contains exactly one operation and cannot be mixed with structural operations",
        422,
      );
    }
    await this.prepareSourcePatch(request.operations);
    const requestHash = sha256(stableJSONString(request));
    const existing = await this.mutations.prepare(request.mutationID, requestHash, request);
    await this.protocolFault("protocol:intent-recorded");
    if (existing.requestHash !== requestHash) {
      throw new ProtocolError("mutation-mismatch", "This mutation ID was already used for a different request", 409, {
        mutationID: request.mutationID,
      });
    }
    if (existing.receipt) return existing.receipt;
    if (existing.state === "materialized" && existing.effects) {
      return this.completeMaterialized(request.mutationID, requestHash, existing.effects, "recovery");
    }

    await this.protocolFault("protocol:preparation");
    let materializationFaulted = false;
    const effects = await this.performProtocolOperations(
      request.operations,
      async (materialized) => {
        await this.mutations.markMaterialized(request.mutationID, requestHash, materialized);
        materializationFaulted = true;
        await this.protocolFault("protocol:materialized");
      },
      request.mutationID,
      async (expected) => {
        await this.mutations.markExpected(request.mutationID, requestHash, expected);
      },
    );
    await this.refreshDerivedViews(request.operations, effects);
    await this.mutations.markMaterialized(request.mutationID, requestHash, effects);
    if (!materializationFaulted) await this.protocolFault("protocol:materialized");
    return this.completeMaterialized(request.mutationID, requestHash, effects, "api");
  }

  /** Validate editor provenance before the durable mutation-intent boundary. */
  async prepareSourcePatch(operations: readonly WorkspaceOperation[]): Promise<ConfirmedSourcePatch | undefined> {
    const operation = operations.find((candidate) => candidate.op === "writeMarkdown");
    if (!operation || !operation.sourceEdits) return undefined;
    const path = await this.resolveRef(operation.ref);
    const current = await this.expandedNode(path);
    if (!current.document) {
      throw new ProtocolError("unsupported-operation", `${current.path} is not a document`, 422);
    }
    if (current.revision !== operation.baseContentRevision) throw new RevisionConflictError(current);
    let result: string;
    try {
      result = applySourceEdits(current.document.source, operation.sourceEdits);
    } catch (error) {
      throw new ProtocolError(
        "invalid-reference",
        error instanceof Error ? error.message : "sourceEdits are invalid",
        400,
        { path: current.path },
      );
    }
    if (result !== operation.source) {
      throw new ProtocolError(
        "invalid-reference",
        "sourceEdits do not produce the submitted exact source",
        400,
        { path: current.path },
      );
    }
    return { baseSource: current.document.source, resultSource: operation.source, edits: operation.sourceEdits };
  }

  async protocolFault(stage: string): Promise<void> {
    try {
      await this.faultInjector?.(stage);
    } catch (error) {
      throw new FsInjectedCrashError(stage, { cause: error });
    }
  }

  /**
   * A successful mutation receipt is also the read-after-write boundary for
   * search, backlinks, PageID resolution, and generated collection types.
   * Filesystem notifications remain important for external edits, but local
   * API callers must not race the asynchronous watcher after acknowledgement.
   */
  private async refreshDerivedViews(
    operations: WorkspaceOperation[],
    effects: MutationEffect[],
  ): Promise<void> {
    const contentOnly = operations.every((operation) =>
      operation.op === "writeMarkdown"
      || operation.op === "writeProperties"
      || operation.op === "writeText"
      || operation.op === "restoreRecovery"
      || operation.op === "ensureDocumentIdentity"
    );
    if (contentOnly) {
      for (const effect of effects) {
        const resolved = await this.fs.resolve(effect.ref.path);
        if (resolved.kind === "missing") continue;
        const absolute = resolved.kind === "directory" || resolved.kind === "markdown"
          ? resolved.bodyPath
          : resolved.absolutePath;
        if (absolute) await this.index.updateAbsolute(absolute);
      }
      return;
    }
    const discovery = await this.fs.discoverRecursively();
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    await Promise.all([this.index.rebuild(discovery), this.generateTypes(discovery)]);
  }

  async importV1(
    mutationID: string,
    destinationRef: NodeRef,
    entries: FsImportEntry[],
  ): Promise<MutationReceipt> {
    this.requireWriteAccess();
    return this.executeTransfer(
      mutationID,
      { kind: "import", destination: destinationRef, entries: entries.map(({ path, kind, bytes }) => ({ path, kind, digest: bytes ? sha256(bytes) : undefined })) },
      async (markMaterialized) => {
        const destination = await this.resolveRef(destinationRef);
        return this.effectsFromFsResult(await this.fs.mutate(
          { operations: [{ op: "import", destination, entries }] },
          {
            mutationID,
            onMaterialized: async (result) => markMaterialized(await this.effectsFromFsResult(result)),
          },
        ));
      },
    );
  }

  async assetV1(
    mutationID: string,
    directoryRef: NodeRef,
    filename: string,
    bytes: Uint8Array,
  ): Promise<{ receipt: MutationReceipt; path: string; markdownPath: string }> {
    this.requireWriteAccess();
    const extension = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "")}` : "";
    const assetPath = `/Assets/${sha256(bytes).slice(0, 16)}${extension}`;
    let output: { path: string; markdownPath: string } | null = null;
    const receipt = await this.executeTransfer(
      mutationID,
      { kind: "asset", directory: directoryRef, filename, digest: sha256(bytes) },
      async (_, markExpected) => {
        const directory = await this.resolveRef(directoryRef);
        const assetsDirectory = await this.fs.resolve("/Assets");
        const existingAsset = await this.fs.resolve(assetPath);
        const expectedEffects: MutationEffect[] = [
          ...(assetsDirectory.kind === "missing" ? [{
            kind: "created" as const,
            ref: this.mutationRef("/Assets"),
            contentRevision: EMPTY_REVISION,
            directoryRevision: EMPTY_REVISION,
          }] : []),
          {
            kind: existingAsset.kind === "missing" ? "created" : "updated",
            ref: this.mutationRef(assetPath),
            contentRevision: revisionOf(bytes),
          },
        ];
        await markExpected(expectedEffects);
        output = await this.addAsset(directory, filename, bytes);
        return expectedEffects;
      },
    );
    if (!output) {
      const path = receipt.effects.find((effect) => effect.ref.path !== "/Assets")?.ref.path;
      if (!path) throw new ProtocolError("internal-error", "Stored asset receipt has no path", 500);
      const directory = await this.resolveRef(directoryRef).catch(() => canonicalNodePath(directoryRef.path));
      const resolved = await this.fs.resolve(directory);
      const physicalDirectory = resolved.directoryPath ?? dirname(resolved.bodyPath ?? this.root);
      output = {
        path,
        markdownPath: relative(physicalDirectory, resolveTreePath(this.root, path)).split("/").join("/"),
      };
    }
    return { receipt, ...output };
  }

  private async expandedNode(inputPath: string): Promise<ExpandedNode> {
    return this.surface.expandedNode(inputPath);
  }

  search(query: string, limit = 30) { return this.index.search(query, limit); }

  private async write(
    inputPath: string,
    request: NodeWriteRequest,
    options: Parameters<WorkspaceFS["writeMarkdown"]>[2] = {},
  ): Promise<ExpandedNode> {
    try {
      await this.fs.writeMarkdown(inputPath, request, options);
      return this.expandedNode(inputPath);
    } catch (error) {
      if (error instanceof FsConflictError && error.details.code === "stale-revision") {
        throw new RevisionConflictError(await this.expandedNode(inputPath));
      }
      throw error;
    }
  }

  async mutate(request: FsMutationRequest) {
    return this.fs.mutate(request);
  }

  async import(destination: string, entries: FsImportEntry[]) {
    return this.fs.mutate({ operations: [{ op: "import", destination, entries }] });
  }

  async delete(inputPath: string): Promise<{ trashPath: string }> {
    const path = canonicalNodePath(inputPath);
    if (path === "/" || path.startsWith("/Trash/")) throw new Error("This node cannot be trashed");
    await this.fs.mutate({ operations: [{ op: "trash", paths: [path] }] });
    return { trashPath: `/Trash${path}` };
  }

  async restore(trashPathInput: string): Promise<{ path: string }> {
    const trashPath = canonicalNodePath(trashPathInput);
    const result = await this.fs.mutate({ operations: [{ op: "restore", paths: [trashPath] }] });
    return { path: result.changes[0]?.path ?? trashPath.slice("/Trash".length) };
  }

  async addAsset(directoryInput: string, filename: string, bytes: Uint8Array): Promise<{ path: string; markdownPath: string }> {
    const extension = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "")}` : "";
    const safeName = `${sha256(bytes).slice(0, 16)}${extension}`;
    const assets = await this.fs.resolve("/Assets");
    if (assets.kind === "missing") await this.fs.mutate({ operations: [{ op: "createDirectory", path: "/Assets" }] });
    const path = `/Assets/${safeName}`;
    const existing = await this.fs.resolve(path);
    if (existing.kind === "missing") await this.fs.mutate({ operations: [{ op: "createFile", path, bytes }] });
    // Tree-rooted spelling: the one form on which the DOM's relative-URL
    // rule and Arbor's logical resolution agree at any document depth.
    return { path, markdownPath: path };
  }

  /**
   * The byte surface for a logical route: ordinary files serve their bytes
   * by default; document-shaped nodes serve their stored body only under
   * the explicit `raw` override. Null means the route belongs to the
   * browsing surface instead.
   */
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

  recovery(inputPath: string) { return this.fs.recovery(inputPath); }

  private async blockRecoveryEntries(path: string): Promise<RecoveryEntry[]> {
    const pageID = this.pathPageIDs.get(path);
    const ref = { tree: this.tree, path, stableKey: pageID ? pageIDStableKey(pageID) : null };
    return (await this.recovery(path)).map((entry) => ({
      kind: "block" as const,
      ref,
      ...entry,
    }));
  }

  private async subtreeRecoveryEntries(path: string): Promise<RecoveryEntry[]> {
    const entries: RecoveryEntry[] = [];
    const visitDocuments = async (currentPath: string): Promise<void> => {
      const resolved = await this.fs.resolve(currentPath);
      if (resolved.kind === "missing" || resolved.materialization === "placeholder") return;
      if (resolved.kind === "markdown" || resolved.kind === "directory") {
        entries.push(...await this.blockRecoveryEntries(currentPath));
      }
      if (resolved.kind !== "directory") return;
      for (const child of await this.fs.list(currentPath)) {
        await visitDocuments(child.path);
      }
    };
    await visitDocuments(path);

    const trashBase = path === "/" ? "/Trash" : `/Trash${path}`;
    const trashNode = await this.fs.resolve(trashBase);
    if (trashNode.kind !== "directory") return entries;
    const visitTrash = async (currentPath: string): Promise<void> => {
      const resolved = await this.fs.resolve(currentPath);
      if (resolved.kind === "missing") return;
      const info = await stat(resolved.absolutePath).catch(() => null);
      const pageID = this.pathPageIDs.get(currentPath);
      entries.push({
        kind: "trash",
        ref: { tree: this.tree, path: currentPath, stableKey: pageID ? pageIDStableKey(pageID) : null },
        originalPath: currentPath.slice("/Trash".length) || "/",
        nodeKind: resolved.kind === "markdown" || resolved.kind === "directory" || resolved.kind === "file"
          ? resolved.kind
          : "file",
        changedAt: (info?.mtimeMs ?? 0) / 1_000,
      });
      if (resolved.kind !== "directory") return;
      for (const child of await this.fs.list(currentPath)) {
        await visitTrash(child.path);
      }
    };
    for (const child of await this.fs.list(trashBase)) {
      await visitTrash(child.path);
    }
    return entries;
  }

  private async restoreBlock(
    inputPath: string,
    hash: string,
    options: {
      onPrepared?: (result: FsWriteResult) => void | Promise<void>;
      onMaterialized?: (result: FsWriteResult) => void | Promise<void>;
    } = {},
  ): Promise<ExpandedNode> {
    await this.fs.restoreBlock(inputPath, hash, options);
    return this.expandedNode(inputPath);
  }

  private async performProtocolOperations(
    operations: WorkspaceOperation[],
    onMaterialized?: (effects: MutationEffect[]) => void | Promise<void>,
    mutationID?: string,
    onExpected?: (effects: MutationEffect[]) => void | Promise<void>,
  ): Promise<MutationEffect[]> {
    const isContentOp = (operation: WorkspaceOperation): operation is ContentWorkspaceOperation =>
      operation.op === "writeProperties" || operation.op === "writeMarkdown" || operation.op === "writeText" || operation.op === "restoreRecovery"
      || operation.op === "ensureDocumentIdentity";
    const contentOperations = operations.filter(isContentOp);
    const structuralOperations = operations.filter(
      (operation): operation is StructuralWorkspaceOperation => !isContentOp(operation),
    );
    if (contentOperations.length === 1) {
      const operation = contentOperations[0]!;
      const target = await this.provider.writeTarget(operation.ref);
      if (target && !target.writable) {
        throw new ProtocolError("read-only", "This collection row has invalid or duplicated declared identity", 422, {
          path: operation.ref.path,
        });
      }
      const path = (target?.storage === "physical" ? target.path : target?.parentPath)
        ?? await this.resolveRef(operation.ref);
      return [await this.performContentOperation(operation, path, target, onMaterialized, onExpected, mutationID)];
    }

    try {
      const fsOperations: FsMutation[] = [];
      for (const operation of structuralOperations) fsOperations.push(await this.protocolFsOperation(operation));
      return await this.effectsFromFsResult(await this.fs.mutate(
        { operations: fsOperations },
        {
          mutationID,
          onMaterialized: onMaterialized
            ? async (result) => onMaterialized(await this.effectsFromFsResult(result))
            : undefined,
        },
      ));
    } catch (error) { throw error; }
  }

  private async performContentOperation(
    operation: ContentWorkspaceOperation,
    path: string,
    target?: ProjectionWriteTarget | null,
    onMaterialized?: (effects: MutationEffect[]) => void | Promise<void>,
    onExpected?: (effects: MutationEffect[]) => void | Promise<void>,
    mutationID?: string,
  ): Promise<MutationEffect> {
    if (operation.op === "writeProperties") {
      return writeFilesystemProperties(operation, path, target, {
        tree: this.tree,
        mutationID: mutationID!,
        provider: this.provider,
        fs: () => this.fs,
        expandedNode: (nodePath) => this.expandedNode(nodePath),
        snapshot: (ref) => this.snapshot(ref),
        snapshotCurrent: (node) => this.snapshotFromExpanded(node, this.events.currentCursor()),
        mutationRef: (nodePath, pageID, stableKey) => this.mutationRef(nodePath, pageID, stableKey),
        writeMarkdown: (nodePath, request, options) => this.write(nodePath, request, options),
        error: (code, message, status, details = {}) => new ProtocolError(code, message, status, details),
        onExpected,
        onMaterialized,
        afterProviderCommit: () => this.protocolFault("protocol:provider-committed"),
      });
    }
    if (operation.op === "ensureDocumentIdentity") {
      const current = await this.expandedNode(path);
      const existingID = isPageID(current.document?.frontmatter.id) ? current.document.frontmatter.id : undefined;
      if (existingID) {
        // Identity already exists: no write, the receipt echoes current state.
        return {
          kind: "updated",
          ref: this.mutationRef(current.path, existingID),
          contentRevision: current.revision,
          directoryRevision: current.kind === "directory" ? current.revision : undefined,
        };
      }
      if (!current.document) {
        throw new ProtocolError("unsupported-operation", `${current.path} is not a document; ordinary files remain path-only`, 422);
      }
      if (current.revision !== operation.baseContentRevision) {
        throw new RevisionConflictError(current);
      }
      const pageID = mintPageID(new Set(this.idOwners.keys()));
      const source = `${patchFrontmatter(current.document.frontmatterSource, { id: pageID }) ?? ""}${current.document.bodySource}`;
      const saved = await this.write(path, {
        baseRevision: operation.baseContentRevision,
        source,
      }, {
        onPrepared: onExpected
          ? async (result) => onExpected([{
            kind: "updated",
            ref: this.mutationRef(result.node.path, result.pageID),
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
        onMaterialized: onMaterialized
          ? async (result) => onMaterialized([{
            kind: "updated",
            ref: this.mutationRef(result.node.path, result.pageID),
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
      });
      return {
        kind: "updated",
        ref: this.mutationRef(saved.path, isPageID(saved.document?.frontmatter.id) ? saved.document.frontmatter.id : undefined),
        contentRevision: saved.revision,
        directoryRevision: saved.kind === "directory" ? saved.revision : undefined,
      };
    }
    let saved: ExpandedNode;
    if (operation.op === "writeText") {
      const current = await this.fs.read(path);
      if (current.node.kind !== "file") {
        throw new ProtocolError("unsupported-operation", `${path} is not an ordinary UTF-8 file`, 422, { path });
      }
      const result = await this.fs.writeFile(path, new TextEncoder().encode(operation.source), operation.baseContentRevision);
      return {
        kind: "updated",
        ref: this.mutationRef(result.node.path),
        contentRevision: result.byteRevision,
      };
    } else if (operation.op === "writeMarkdown") {
      saved = await this.write(path, {
        baseRevision: operation.baseContentRevision,
        source: operation.source,
      }, {
        onPrepared: onExpected
          ? async (result) => onExpected([{
            kind: "updated",
            ref: this.mutationRef(result.node.path, result.pageID),
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
        onMaterialized: onMaterialized
          ? async (result) => onMaterialized([{
            kind: "updated",
            ref: this.mutationRef(result.node.path, result.pageID),
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
      });
    } else {
      const current = await this.expandedNode(path);
      if (operation.baseContentRevision && current.revision !== operation.baseContentRevision) {
        throw new RevisionConflictError(current);
      }
      saved = await this.restoreBlock(path, operation.hash, {
        onPrepared: onExpected
          ? async (result) => onExpected([{
            kind: "updated",
            ref: this.mutationRef(result.node.path, result.pageID),
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
        onMaterialized: onMaterialized
          ? async (result) => onMaterialized([{
            kind: "updated",
            ref: this.mutationRef(result.node.path, result.pageID),
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
      });
    }
    return {
      kind: "updated",
      ref: this.mutationRef(saved.path, isPageID(saved.document?.frontmatter.id) ? saved.document.frontmatter.id : undefined),
      contentRevision: saved.revision,
      directoryRevision: saved.kind === "directory" ? saved.revision : undefined,
    };
  }

  private async protocolFsOperation(operation: WorkspaceOperation): Promise<FsMutation> {
    switch (operation.op) {
      case "createDirectory":
      case "createMarkdown":
        return operation;
      case "rename":
        return { op: "rename", path: await this.resolveRef(operation.ref), name: operation.name };
      case "move":
        return {
          op: "move",
          paths: await Promise.all(operation.refs.map((ref) => this.resolveRef(ref))),
          destination: await this.resolveRef(operation.destination),
        };
      case "copy":
        return {
          op: "copy",
          paths: await Promise.all(operation.refs.map((ref) => this.resolveRef(ref))),
          destination: await this.resolveRef(operation.destination),
        };
      case "trash":
      case "restore":
        return {
          op: operation.op,
          paths: await Promise.all(operation.refs.map((ref) => this.resolveRef(ref))),
        };
      default:
        throw new ProtocolError("unsupported-operation", `Unsupported operation: ${operation.op}`, 422);
    }
  }

  private async effectsFromFsResult(result: Awaited<ReturnType<WorkspaceFS["mutate"]>>): Promise<MutationEffect[]> {
    const discovery = await this.fs.discoverRecursively();
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    return Promise.all(result.changes.map(async (change) => {
      let snapshot: ExpandedNode | null = null;
      try { snapshot = await this.expandedNode(change.path); } catch {}
      return {
        kind: change.kind,
        ref: this.mutationRef(
          change.path,
          change.pageID
            ?? (isPageID(snapshot?.document?.frontmatter.id) ? snapshot.document.frontmatter.id : undefined),
        ),
        previousPath: change.previousPath,
        contentRevision: snapshot?.revision,
        directoryRevision: snapshot?.kind === "directory"
          ? snapshot.revision
          : undefined,
      };
    }));
  }

  private async executeTransfer(
    mutationID: string,
    request: unknown,
    perform: (
      markMaterialized: (effects: MutationEffect[]) => Promise<void>,
      markExpected: (effects: MutationEffect[]) => Promise<void>,
    ) => Promise<MutationEffect[]>,
  ): Promise<MutationReceipt> {
    if (!mutationID) throw new ProtocolError("invalid-reference", "A mutation ID is required", 400);
    const requestHash = sha256(stableJSONString({ mutationID, request }));
    const existing = await this.mutations.prepare(mutationID, requestHash, request);
    await this.protocolFault("protocol:intent-recorded");
    if (existing.requestHash !== requestHash) {
      throw new ProtocolError("mutation-mismatch", "This mutation ID was already used for different transfer bytes", 409, { mutationID });
    }
    if (existing.receipt) return existing.receipt;
    if (existing.state === "materialized" && existing.effects) {
      return this.completeMaterialized(mutationID, requestHash, existing.effects, "recovery");
    }
    await this.protocolFault("protocol:preparation");
    let materializationFaulted = false;
    const effects = await perform(async (materialized) => {
      await this.mutations.markMaterialized(mutationID, requestHash, materialized);
      materializationFaulted = true;
      await this.protocolFault("protocol:materialized");
    }, async (expected) => {
      await this.mutations.markExpected(mutationID, requestHash, expected);
    });
    await this.mutations.markMaterialized(mutationID, requestHash, effects);
    if (!materializationFaulted) await this.protocolFault("protocol:materialized");
    return this.completeMaterialized(mutationID, requestHash, effects, "api");
  }

  private async completeMaterialized(
    mutationID: string,
    requestHash: string,
    rawEffects: MutationEffect[],
    origin: "api" | "recovery",
  ): Promise<MutationReceipt> {
    const effects = rawEffects;
    let observedThrough = this.events.currentCursor();
    for (const effect of effects) {
      observedThrough = this.events.emit({
        tree: effect.ref.tree,
        kind: effect.kind,
        ref: effect.ref,
        previousPath: effect.previousPath,
        contentRevision: effect.contentRevision,
        propertiesRevision: effect.propertiesRevision,
        changedProperties: effect.changedProperties,
        directoryRevision: effect.directoryRevision,
        origin,
        mutationID,
      }).cursor;
    }
    await this.protocolFault("protocol:event-published");
    const receipt: MutationReceipt = { mutationID, observedThrough, effects };
    await this.mutations.complete(mutationID, requestHash, receipt);
    await this.protocolFault("protocol:receipt-completed");
    return receipt;
  }

  private async finishRecoveredMutations(): Promise<void> {
    for (const recovered of this.fs.takeRecoveredMutationResults()) {
      const record = await this.mutations.get(recovered.mutationID);
      if (!record || record.state === "completed") continue;
      if (record.state === "materialized") continue;
      await this.mutations.markMaterialized(
        recovered.mutationID,
        record.requestHash,
        await this.effectsFromFsResult(recovered.result),
      );
    }
    for (const record of await this.mutations.pending()) {
      if (record.state === "pending" && record.expectedEffects?.length) {
        const request = record.request as { operations?: Array<{ ref?: NodeRef }> };
        const matches = await Promise.all(record.expectedEffects.map(async (effect) => {
          try {
            const operationRefs = request.operations?.flatMap((operation) => operation.ref ? [operation.ref] : []) ?? [];
            const operationRef = operationRefs.find((ref) => ref.path === effect.ref.path)
              ?? (operationRefs.length === 1 ? operationRefs[0] : undefined);
            const current = await this.snapshot({
              tree: effect.ref.tree,
              path: effect.ref.path,
              stableKey: effect.ref.stableKey ?? operationRef?.stableKey ?? null,
            });
            return (!effect.contentRevision
                || current.capabilities.content?.revision === effect.contentRevision
                || current.revision === effect.contentRevision)
              && (!effect.propertiesRevision
                || current.capabilities.properties?.revision === effect.propertiesRevision)
              && (!effect.directoryRevision
                || current.capabilities.children?.revision === effect.directoryRevision
                || current.revision === effect.directoryRevision);
          } catch {
            return false;
          }
        }));
        if (matches.every(Boolean)) {
          await this.mutations.markMaterialized(record.mutationID, record.requestHash, record.expectedEffects);
          await this.completeMaterialized(record.mutationID, record.requestHash, record.expectedEffects, "recovery");
          continue;
        }
      }
      if (record.state !== "materialized" || !record.effects) continue;
      await this.completeMaterialized(record.mutationID, record.requestHash, record.effects, "recovery");
    }
  }

  /** Current owners of a durable page ID in this root, for cross-root fan-out. */
  pageIDOwners(pageID: string): readonly string[] {
    const owners = this.idOwnerSets.get(pageID);
    if (owners?.length) return owners;
    const owner = this.idOwners.get(pageID);
    return owner ? [owner] : [];
  }

  private async resolveRef(ref: NodeRef): Promise<string> {
    const pageID = pageIDFromStableKey(ref.stableKey);
    if (!ref.stableKey) return canonicalNodePath(ref.path);
    if (!pageID) {
      throw new ProtocolError("invalid-reference", "This workspace cannot resolve the supplied stable key", 400);
    }
    const owners = this.idOwnerSets.get(pageID) ?? [];
    if (owners.length > 1) {
      throw new ProtocolError("duplicate-page-id", `Stable key ${ref.stableKey} has multiple owners`, 409, {
        owners: [...owners],
      });
    }
    const owner = owners[0] ?? this.idOwners.get(pageID);
    if (!owner) {
      throw new ProtocolError("not-found", `No node owns stable key ${ref.stableKey}`, 404, {
        path: ref.path,
      });
    }
    return owner;
  }

  private snapshotFromExpanded(node: ExpandedNode, observedThrough: string): NodeResponse {
    return this.surface.snapshotFromExpanded(node, observedThrough);
  }

  private requireWriteAccess(): void {
    if (this.treeDescriptor.access === "read") {
      throw new ProtocolError("read-only", "This tree placement is read-only", 422);
    }
  }

  async generateTypes(discovery?: WorkspaceDiscovery): Promise<void> {
    return generateTreeTypes({ root: this.root, stateDirectory: this.stateDirectory, fs: this.fs, provider: this.provider, discovery });
  }

  /** Extra root file for Arbor-owned TypeScript compiler and language-service hosts. */
  generatedTypeDeclarationPath(): string {
    return generatedTypeDeclarationPath(this.stateDirectory);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const timer of this.healingTimers.values()) clearTimeout(timer);
    this.unsubscribeFS();
    this.index.close();
    await this.provider[Symbol.asyncDispose]();
    await this.fs[Symbol.asyncDispose]();
  }

  private registerPageID(path: string, candidate: unknown): string | null {
    if (!isPageID(candidate)) return null;
    const owners = [...(this.idOwnerSets.get(candidate) ?? [])];
    if (!owners.includes(path)) owners.push(path);
    owners.sort();
    this.idOwnerSets.set(candidate, owners);
    if (!this.idOwners.has(candidate)) this.idOwners.set(candidate, path);
    if (owners.length === 1) this.pathPageIDs.set(path, candidate);
    else for (const owner of owners) if (this.pathPageIDs.get(owner) === candidate) this.pathPageIDs.delete(owner);
    return candidate;
  }

  private adoptIDMaps(pagePathsByID: ReadonlyMap<string, string>, pageIDOwners: ReadonlyMap<string, readonly string[]>): void {
    this.idOwners = new Map(pagePathsByID);
    this.idOwnerSets = new Map(pageIDOwners);
    this.pathPageIDs = new Map();
    for (const [pageID, path] of this.idOwners) {
      if ((this.idOwnerSets.get(pageID)?.length ?? 1) <= 1) this.pathPageIDs.set(path, pageID);
    }
  }

  private pageIDDiagnostics(path: string, pageID: string | null): ExpandedNode["diagnostics"] {
    return pageID && this.idOwners.get(pageID) !== path
      ? [{ code: "duplicate-page-id", message: `Page ID ${pageID} is also used by ${this.idOwners.get(pageID)}`, path, severity: "error" }]
      : [];
  }

  private async handleFsEvent(event: FsEvent): Promise<void> {
    if (event.path === "/") this.displayName = await rootDisplayName(this.root);
    const publish = event.origin !== "local-api";
    const updateIndex = async (path: string) => {
      const resolved = await this.fs.resolve(path);
      const absolute = resolved.kind === "directory" ? resolved.bodyPath : resolved.kind === "markdown" ? resolved.bodyPath : resolved.absolutePath;
      if (absolute) await this.index.updateAbsolute(absolute);
      else if (event.previousPath) {
        const oldBody = resolveTreePath(this.root, `${event.previousPath}.md`);
        await this.index.updateAbsolute(oldBody);
      }
    };
    if (event.type === "batch") {
      try {
        const discovery = await this.fs.discoverRecursively();
        this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
        await Promise.all([
          this.index.rebuild(discovery),
          this.generateTypes(discovery),
        ]);
      } catch {}
    } else if (event.type === "moved" || event.type === "deleted") await this.index.rebuild().catch(() => {});
    else if (event.type !== "diagnostic") await updateIndex(event.path).catch(() => {});
    if (!publish) return;
    if (event.type === "batch") {
      for (const change of event.changes ?? []) {
        this.events.emit({
          tree: this.tree,
          kind: change.kind,
          ref: this.mutationRef(change.path),
          previousPath: change.previousPath,
          origin: event.origin === "sync" ? "sync" : "external",
        });
      }
      return;
    }
    this.events.emit({
      tree: this.tree,
      kind: event.type,
      ref: this.mutationRef(event.path),
      previousPath: event.previousPath,
      contentRevision: event.byteRevision,
      origin: event.origin === "sync" ? "sync" : "external",
    });
  }

  private scheduleLinkHealing(treePath: string, revision: string, document: NonNullable<ExpandedNode["document"]>): void {
    if (this.healingTimers.has(treePath)) return;
    const healBlock = (block: ArborBlock): ArborBlock => {
      if (block.type === "rawMarkdown") return block;
      let changed = false;
      const content = (block.content ?? "").replace(/\]\(([^)#]+)#([^)\\s]+)\)/g, (match, oldPath: string, encodedID: string) => {
        let id: string;
        try { id = decodeURIComponent(encodedID); } catch { return match; }
        const owner = this.idOwners.get(id);
        if (!owner) return match;
        let desired = posix.relative(posix.dirname(treePath), owner);
        if (!desired) desired = posix.basename(owner);
        if (oldPath === desired) return match;
        changed = true;
        return `](${desired}#${id})`;
      });
      const children = block.children.map(healBlock);
      if (children.some((child, index) => child !== block.children[index])) changed = true;
      return changed ? { ...block, content, children } : block;
    };
    const blocks = document.blocks.map(healBlock);
    if (!blocks.some((block, index) => block !== document.blocks[index])) return;
    const timer = setTimeout(async () => {
      this.healingTimers.delete(treePath);
      try { await this.write(treePath, { baseRevision: revision, source: serializeMarkdown(document, blocks) }); } catch {}
    }, 750);
    this.healingTimers.set(treePath, timer);
  }
}
