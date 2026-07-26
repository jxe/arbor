import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative } from "node:path";
import type {
  ArborBlock,
  ArbordErrorCode,
  ChildrenPage,
  CollectionPage,
  CollectionResultPage,
  ContentWorkspaceOperation,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeSnapshot,
  NodeWriteRequest,
  RecoveryPage,
  SearchResult,
  SearchPage,
  StructuralWorkspaceOperation,
  TreeChild,
  TreeNode,
  WorkspaceOperation,
} from "@arbor/core";
import {
  canonicalJSONString,
  canonicalNodePath,
  isPageID,
  nodeDisplayName,
  resolveTreePath,
  revisionOf,
  sha256,
} from "@arbor/core";
import {
  discoverWorkspace,
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
import { CollectionStore, WorkspaceIndex, workspaceStateDirectory } from "@arbor/stores";
import { EventBus } from "./events.ts";

const EMPTY_REVISION = revisionOf("");
export interface WorkspaceOptions {
  faultInjector?: (stage: string) => void | Promise<void>;
}

export class RevisionConflictError extends Error {
  constructor(public current: TreeNode) { super("The file changed since it was opened"); }
}

export class ProtocolError extends Error {
  constructor(
    public code: ArbordErrorCode,
    message: string,
    public status: number,
    public details: Partial<{
      path: string;
      current: NodeSnapshot;
      owners: string[];
      anchor: { beforePath?: string; beforeBlockID?: string };
      mutationID: string;
      retryable: boolean;
    }> = {},
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class Workspace implements AsyncDisposable {
  readonly root: string;
  readonly events = new EventBus();
  readonly fs: WorkspaceFS;
  readonly mutations: MutationJournal;
  private stateDirectory: string;
  private index: WorkspaceIndex;
  private collections = new CollectionStore();
  private idOwners = new Map<string, string>();
  private idOwnerSets = new Map<string, readonly string[]>();
  private healingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeFS: () => void;
  private faultInjector?: WorkspaceOptions["faultInjector"];

  private constructor(root: string, stateDirectory: string, fs: WorkspaceFS, index: WorkspaceIndex, options: WorkspaceOptions) {
    this.root = root;
    this.stateDirectory = stateDirectory;
    this.fs = fs;
    this.mutations = new MutationJournal(join(stateDirectory, "journal", "mutations"));
    this.index = index;
    this.faultInjector = options.faultInjector;
    this.unsubscribeFS = fs.subscribe((event) => { void this.handleFsEvent(event); });
  }

  static async open(path: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const stateDirectory = await workspaceStateDirectory(path);
    const fs = await WorkspaceFS.open(path, { stateDirectory, faultInjector: options.faultInjector });
    const discovery = fs.startupDiscovery();
    const index = new WorkspaceIndex(fs.root, join(stateDirectory, "index.sqlite"));
    const workspace = new Workspace(fs.root, stateDirectory, fs, index, options);
    workspace.idOwners = new Map(discovery.pagePathsByID);
    workspace.idOwnerSets = new Map(discovery.pageIDOwners);
    await Promise.all([index.rebuild(discovery), workspace.generateTypes(discovery)]);
    await workspace.finishRecoveredMutations();
    return workspace;
  }

  async snapshot(ref: NodeRef): Promise<NodeSnapshot> {
    const observedThrough = this.events.currentCursor();
    const path = await this.resolveRef(ref);
    return this.snapshotFromTree(await this.node(path), observedThrough);
  }

  async children(ref: NodeRef, cursor?: string | null): Promise<ChildrenPage> {
    const observedThrough = this.events.currentCursor();
    const path = await this.resolveRef(ref);
    const node = await this.node(path);
    if (node.kind !== "directory" && node.kind !== "collection") {
      throw new ProtocolError("invalid-reference", `${path} does not have children`, 400, { path });
    }
    const offset = this.decodePageCursor(cursor, `children:${path}`);
    const items = (node.children ?? []).slice(offset, offset + 100);
    const nextOffset = offset + items.length;
    return {
      parent: { path, ...(isPageID(node.document?.frontmatter.id) ? { pageID: node.document.frontmatter.id } : {}) },
      items,
      nextCursor: nextOffset < (node.children?.length ?? 0) ? this.encodePageCursor(`children:${path}`, nextOffset) : null,
      observedThrough,
    };
  }

  async searchPage(query: string, cursor?: string | null): Promise<SearchPage> {
    const observedThrough = this.events.currentCursor();
    const offset = this.decodePageCursor(cursor, `search:${query}`);
    const results = this.index.search(query, 30, offset).map((result) => {
      const pageID = [...this.idOwners].find(([, path]) => path === result.path)?.[0];
      return { ...result, ...(pageID ? { pageID } : {}) };
    });
    return {
      results,
      nextCursor: results.length === 30 ? this.encodePageCursor(`search:${query}`, offset + results.length) : null,
      observedThrough,
    };
  }

  async collectionPage(ref: NodeRef, cursor?: string | null, table?: string): Promise<CollectionResultPage> {
    const observedThrough = this.events.currentCursor();
    const path = await this.resolveRef(ref);
    const offset = this.decodePageCursor(cursor, `collection:${path}:${table ?? ""}`);
    return { ...(await this.collection(path, offset, 100, table)), observedThrough };
  }

  async recoveryPage(ref: NodeRef): Promise<RecoveryPage> {
    const observedThrough = this.events.currentCursor();
    const path = await this.resolveRef(ref);
    const snapshot = await this.node(path);
    return {
      ref: { path, ...(isPageID(snapshot.document?.frontmatter.id) ? { pageID: snapshot.document.frontmatter.id } : {}) },
      entries: await this.recovery(path),
      observedThrough,
    };
  }

  async executeMutation(request: MutationRequest): Promise<MutationReceipt> {
    if (!request.mutationID || !Array.isArray(request.operations) || request.operations.length === 0) {
      throw new ProtocolError("invalid-reference", "A mutation requires a non-empty mutation ID and operations array", 400);
    }
    const contentOperations = request.operations.filter((operation) =>
      operation.op === "writeMarkdown" || operation.op === "restoreRecovery"
    );
    if (contentOperations.length > 0 && (contentOperations.length !== 1 || request.operations.length !== 1)) {
      throw new ProtocolError(
        "unsupported-operation",
        "A content mutation contains exactly one operation and cannot be mixed with structural operations",
        422,
      );
    }
    const requestHash = sha256(canonicalJSONString(request));
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
    await this.mutations.markMaterialized(request.mutationID, requestHash, effects);
    if (!materializationFaulted) await this.protocolFault("protocol:materialized");
    return this.completeMaterialized(request.mutationID, requestHash, effects, "api");
  }

  async protocolFault(stage: string): Promise<void> {
    try {
      await this.faultInjector?.(stage);
    } catch (error) {
      throw new FsInjectedCrashError(stage, { cause: error });
    }
  }

  async importV1(
    mutationID: string,
    destinationRef: NodeRef,
    entries: FsImportEntry[],
  ): Promise<MutationReceipt> {
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
            path: "/Assets",
            contentRevision: EMPTY_REVISION,
            directoryRevision: EMPTY_REVISION,
          }] : []),
          {
            kind: existingAsset.kind === "missing" ? "created" : "updated",
            path: assetPath,
            contentRevision: revisionOf(bytes),
          },
        ];
        await markExpected(expectedEffects);
        output = await this.addAsset(directory, filename, bytes);
        return expectedEffects;
      },
    );
    if (!output) {
      const path = receipt.effects.find((effect) => effect.path !== "/Assets")?.path;
      if (!path) throw new ProtocolError("internal-error", "Stored asset receipt has no path", 500);
      const directory = await this.resolveRef(directoryRef).catch(() =>
        "path" in directoryRef
          ? canonicalNodePath(directoryRef.path)
          : canonicalNodePath(directoryRef.pathHint ?? "/")
      );
      const resolved = await this.fs.resolve(directory);
      const physicalDirectory = resolved.directoryPath ?? dirname(resolved.bodyPath ?? this.root);
      output = {
        path,
        markdownPath: relative(physicalDirectory, resolveTreePath(this.root, path)).split("/").join("/"),
      };
    }
    return { receipt, ...output };
  }

  async node(inputPath: string): Promise<TreeNode> {
    const read = await this.fs.read(inputPath);
    const resolved = read.node;
    if (resolved.kind === "missing") {
      const virtual = await this.postgresVirtualNode(resolved.path);
      if (virtual) return virtual;
      throw new ProtocolError("not-found", `Node not found: ${resolved.path}`, 404, {
        path: resolved.path,
      });
    }

    if (resolved.kind === "file") {
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "file",
        revision: read.byteRevision,
        writable: resolved.writable,
        materialization: resolved.materialization,
        diagnostics: resolved.diagnostics,
      };
    }

    if (resolved.kind === "markdown") {
      const document = read.document!;
      const pageID = this.registerPageID(resolved.path, document.frontmatter.id);
      if (pageID) this.scheduleLinkHealing(resolved.path, read.byteRevision, document);
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "markdown",
        revision: read.byteRevision,
        writable: resolved.writable,
        materialization: resolved.materialization,
        document,
        diagnostics: [
          ...resolved.diagnostics,
          ...this.pageIDDiagnostics(resolved.path, pageID),
        ],
      };
    }

    const collection = await this.collections.summary(resolved.directoryPath!).catch(() => null);
    const children = await this.directoryChildren(resolved.path, collection?.tables ?? []);
    const document = read.document!;
    const pageID = this.registerPageID(resolved.path, document.frontmatter.id);
    if (pageID) this.scheduleLinkHealing(resolved.path, read.byteRevision, document);
    return {
      path: resolved.path,
      name: resolved.path === "/" ? basename(this.root) : nodeDisplayName(resolved.path),
      kind: collection ? "collection" : "directory",
      revision: read.byteRevision,
      writable: resolved.writable,
      materialization: resolved.materialization,
      document,
      children: children.children,
      collection: collection ?? undefined,
      diagnostics: [
        ...resolved.diagnostics,
        ...this.pageIDDiagnostics(resolved.path, pageID),
        ...children.diagnostics,
      ],
    };
  }

  async collection(inputPath: string, cursor = 0, limit = 100, table?: string): Promise<CollectionPage> {
    const treePath = canonicalNodePath(inputPath);
    const resolved = await this.fs.resolve(treePath);
    let absolute = resolved.directoryPath;
    if (!absolute) {
      const parent = await this.fs.resolve(treePath.slice(0, treePath.lastIndexOf("/")) || "/");
      absolute = parent.directoryPath;
      table ??= treePath.slice(treePath.lastIndexOf("/") + 1);
    }
    if (!absolute) throw new Error("Collection path is not a directory");
    return this.collections.page(absolute, treePath, cursor, limit, table);
  }

  search(query: string, limit = 30): SearchResult[] { return this.index.search(query, limit); }

  async write(
    inputPath: string,
    request: NodeWriteRequest,
    options: Parameters<WorkspaceFS["writeMarkdown"]>[2] = {},
  ): Promise<TreeNode> {
    try {
      await this.fs.writeMarkdown(inputPath, request, options);
      return this.node(inputPath);
    } catch (error) {
      if (error instanceof FsConflictError && error.details.code === "stale-revision") {
        throw new RevisionConflictError(await this.node(inputPath));
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
    const directory = (await this.fs.resolve(directoryInput)).directoryPath
      ?? dirname((await this.fs.resolve(directoryInput)).bodyPath ?? this.root);
    return { path, markdownPath: relative(directory, resolveTreePath(this.root, path)).split("/").join("/") };
  }

  recovery(inputPath: string) { return this.fs.recovery(inputPath); }

  async restoreBlock(
    inputPath: string,
    hash: string,
    options: {
      onPrepared?: (result: FsWriteResult) => void | Promise<void>;
      onMaterialized?: (result: FsWriteResult) => void | Promise<void>;
    } = {},
  ): Promise<TreeNode> {
    await this.fs.restoreBlock(inputPath, hash, options);
    return this.node(inputPath);
  }

  private async performProtocolOperations(
    operations: WorkspaceOperation[],
    onMaterialized?: (effects: MutationEffect[]) => void | Promise<void>,
    mutationID?: string,
    onExpected?: (effects: MutationEffect[]) => void | Promise<void>,
  ): Promise<MutationEffect[]> {
    const isContentOp = (operation: WorkspaceOperation): operation is ContentWorkspaceOperation =>
      operation.op === "writeMarkdown" || operation.op === "restoreRecovery"
      || operation.op === "ensureDocumentIdentity";
    const contentOperations = operations.filter(isContentOp);
    const structuralOperations = operations.filter(
      (operation): operation is StructuralWorkspaceOperation => !isContentOp(operation),
    );
    if (contentOperations.length === 1) {
      const operation = contentOperations[0]!;
      const path = await this.resolveRef(operation.ref);
      return [await this.performContentOperation(operation, path, onMaterialized, onExpected)];
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
    } catch (error) {
      if (
        error instanceof FsConflictError
        && error.details.code === "missing-insertion-anchor"
      ) {
        const operation = structuralOperations.find((candidate) =>
          candidate.op === "move"
          && (candidate.beforePath !== undefined || candidate.beforeBlockID !== undefined)
        ) as Extract<WorkspaceOperation, { op: "move" }> | undefined;
        throw new ProtocolError("missing-insertion-anchor", error.message, 409, {
          path: error.details.path,
          anchor: operation ? {
            beforePath: operation.beforePath,
            beforeBlockID: operation.beforeBlockID,
          } : undefined,
        });
      }
      if (
        error instanceof FsConflictError
        && error.details.code === "stale-revision"
        && structuralOperations.some((operation) => operation.op === "move" && operation.baseDirectoryRevision !== undefined)
      ) {
        const current = await this.snapshot({ path: error.details.path }).catch(() => undefined);
        throw new ProtocolError("stale-directory-revision", error.message, 409, {
          path: error.details.path,
          current,
        });
      }
      throw error;
    }
  }

  private async performContentOperation(
    operation: ContentWorkspaceOperation,
    path: string,
    onMaterialized?: (effects: MutationEffect[]) => void | Promise<void>,
    onExpected?: (effects: MutationEffect[]) => void | Promise<void>,
  ): Promise<MutationEffect> {
    if (operation.op === "ensureDocumentIdentity") {
      // Implemented with the identity milestone; typed into the contract first.
      throw new ProtocolError("unsupported-operation", "ensureDocumentIdentity is not implemented yet", 422);
    }
    let saved: TreeNode;
    if (operation.op === "writeMarkdown") {
      saved = await this.write(path, {
        baseRevision: operation.baseContentRevision,
        frontmatterPatch: operation.frontmatterPatch,
        blocks: operation.blocks,
      }, {
        onPrepared: onExpected
          ? async (result) => onExpected([{
            kind: "updated",
            path: result.node.path,
            pageID: result.pageID,
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
        onMaterialized: onMaterialized
          ? async (result) => onMaterialized([{
            kind: "updated",
            path: result.node.path,
            pageID: result.pageID,
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
      });
    } else {
      const current = await this.node(path);
      if (operation.baseContentRevision && current.revision !== operation.baseContentRevision) {
        throw new RevisionConflictError(current);
      }
      saved = await this.restoreBlock(path, operation.hash, {
        onPrepared: onExpected
          ? async (result) => onExpected([{
            kind: "updated",
            path: result.node.path,
            pageID: result.pageID,
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
        onMaterialized: onMaterialized
          ? async (result) => onMaterialized([{
            kind: "updated",
            path: result.node.path,
            pageID: result.pageID,
            contentRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }])
          : undefined,
      });
    }
    return {
      kind: "updated",
      path: saved.path,
      pageID: isPageID(saved.document?.frontmatter.id) ? saved.document.frontmatter.id : undefined,
      contentRevision: saved.revision,
      directoryRevision: saved.kind === "directory" || saved.kind === "collection" ? saved.revision : undefined,
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
          beforePath: operation.beforePath,
          beforeBlockId: operation.beforeBlockID,
          directoryRevision: operation.baseDirectoryRevision,
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
    const discovery = await discoverWorkspace(this.root);
    this.idOwners = new Map(discovery.pagePathsByID);
    this.idOwnerSets = new Map(discovery.pageIDOwners);
    return Promise.all(result.changes.map(async (change) => {
      let snapshot: TreeNode | null = null;
      try { snapshot = await this.node(change.path); } catch {}
      return {
        kind: change.kind,
        path: change.path,
        previousPath: change.previousPath,
        pageID: isPageID(snapshot?.document?.frontmatter.id) ? snapshot.document.frontmatter.id : undefined,
        contentRevision: snapshot?.revision,
        directoryRevision: snapshot && (snapshot.kind === "directory" || snapshot.kind === "collection")
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
    const requestHash = sha256(canonicalJSONString({ mutationID, request }));
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
    effects: MutationEffect[],
    origin: "api" | "recovery",
  ): Promise<MutationReceipt> {
    let eventCursor = this.events.currentCursor();
    for (const effect of effects) {
      eventCursor = this.events.emit({
        kind: effect.kind,
        path: effect.path,
        previousPath: effect.previousPath,
        pageID: effect.pageID,
        contentRevision: effect.contentRevision,
        directoryRevision: effect.directoryRevision,
        origin,
        mutationID,
      }).cursor;
    }
    await this.protocolFault("protocol:event-published");
    const receipt: MutationReceipt = { mutationID, eventCursor, effects };
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
        const matches = await Promise.all(record.expectedEffects.map(async (effect) => {
          try {
            const current = await this.node(effect.path);
            return !effect.contentRevision || current.revision === effect.contentRevision;
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

  private async resolveRef(ref: NodeRef): Promise<string> {
    if ("path" in ref) return canonicalNodePath(ref.path);
    if (!isPageID(ref.pageID)) {
      throw new ProtocolError("invalid-reference", "A page reference requires a non-empty page ID", 400);
    }
    const owners = this.idOwnerSets.get(ref.pageID) ?? [];
    if (owners.length > 1) {
      throw new ProtocolError("duplicate-page-id", `Page ID ${ref.pageID} has multiple owners`, 409, {
        owners: [...owners],
      });
    }
    const owner = owners[0] ?? this.idOwners.get(ref.pageID);
    if (!owner) {
      throw new ProtocolError("not-found", `No page owns ID ${ref.pageID}`, 404, {
        path: ref.pathHint,
      });
    }
    return owner;
  }

  private snapshotFromTree(node: TreeNode, observedThrough: string): NodeSnapshot {
    const pageID = isPageID(node.document?.frontmatter.id) ? node.document.frontmatter.id : undefined;
    return {
      ref: { path: node.path, ...(pageID ? { pageID } : {}) },
      path: node.path,
      name: node.name,
      kind: node.kind === "postgres" ? "database" : node.kind,
      writable: node.writable,
      materialization: node.materialization,
      contentRevision: node.revision,
      directoryRevision: node.kind === "directory" || node.kind === "collection" ? node.revision : undefined,
      document: node.document,
      collection: node.collection,
      diagnostics: node.diagnostics,
      observedThrough,
    };
  }

  private encodePageCursor(key: string, offset: number): string {
    return Buffer.from(JSON.stringify({ key: sha256(key), offset })).toString("base64url");
  }

  private decodePageCursor(cursor: string | null | undefined, key: string): number {
    if (!cursor) return 0;
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { key?: string; offset?: number };
      if (value.key !== sha256(key) || !Number.isSafeInteger(value.offset) || value.offset! < 0) throw new Error();
      return value.offset!;
    } catch {
      throw new ProtocolError("invalid-reference", "The page cursor does not belong to this query", 400);
    }
  }

  async generateTypes(discovery?: WorkspaceDiscovery): Promise<void> {
    const imports: string[] = [];
    const declarations: string[] = [];
    const mappings: string[] = [];
    let schemaIndex = 0;
    let databaseIndex = 0;
    let temporaryFailure = false;
    const snapshot = discovery ?? await discoverWorkspace(this.root);
    for (const directory of snapshot.directories) {
      if (directory.absolutePath === this.root) continue;
      if (directory.childNames.has("schema.ts") || directory.childNames.has("_store.postgres")) {
        const absolute = directory.absolutePath;
        const summary = await this.collections.summary(absolute).catch(() => { temporaryFailure = true; return null; });
        if (summary) {
          const treePath = directory.treePath;
          const schemaPath = join(absolute, "schema.ts");
          if (summary.backing === "postgres") {
            try {
              const schema = await this.collections.postgresSchema(absolute);
              const name = `PostgresDatabase${databaseIndex++}`;
              declarations.push(`interface ${name} {`);
              for (const [table, columns] of Object.entries(schema)) {
                declarations.push(`  ${JSON.stringify(table)}: { ${Object.entries(columns).map(([column, type]) => `${JSON.stringify(column)}: ${type}`).join("; ")} };`);
                mappings.push(`    ${JSON.stringify(`${treePath}/${table}`)}: Collection<${name}[${JSON.stringify(table)}]>;`);
              }
              declarations.push("}");
              mappings.push(`    ${JSON.stringify(treePath)}: Database<${name}>;`);
            } catch {
              temporaryFailure = true;
              mappings.push(`    ${JSON.stringify(treePath)}: Database<Record<string, Record<string, unknown>>>;`);
            }
          } else {
            try {
              await stat(schemaPath);
              const name = `Schema${schemaIndex++}`;
              imports.push(`import type { schema as ${name} } from ${JSON.stringify(`../${relative(this.root, schemaPath).split("/").join("/")}`)};`);
              mappings.push(`    ${JSON.stringify(treePath)}: Collection<z.infer<typeof ${name}>>;`);
            } catch { mappings.push(`    ${JSON.stringify(treePath)}: Collection<Record<string, unknown>>;`); }
          }
        }
      }
    }
    const source = [
      "// Generated by arbor dev. Do not edit.",
      'import type { z } from "zod";',
      ...imports,
      "type Collection<T> = { readonly __row?: T };",
      "type Database<T> = { readonly __tables?: T };",
      ...declarations,
      'declare module "arbor/runtime" {',
      "  interface TreeRegistry {",
      ...mappings,
      "  }",
      "}",
      "export {};",
      "",
    ].join("\n");
    const target = join(this.root, ".arbor", "tree.gen.d.ts");
    if (temporaryFailure) {
      try { await stat(target); return; } catch {}
    }
    await mkdir(join(this.root, ".arbor"), { recursive: true });
    await this.fs.writeFile("/.arbor/tree.gen.d.ts", new TextEncoder().encode(source));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const timer of this.healingTimers.values()) clearTimeout(timer);
    this.unsubscribeFS();
    this.index.close();
    await this.fs[Symbol.asyncDispose]();
  }

  private async directoryChildren(treePath: string, virtualTables: string[]): Promise<{ children: TreeChild[]; diagnostics: TreeNode["diagnostics"] }> {
    const entries = await this.fs.list(treePath);
    const children: TreeChild[] = [];
    const diagnostics: TreeNode["diagnostics"] = [];
    for (const entry of entries) {
      let kind: TreeChild["kind"] = entry.kind;
      if (entry.kind === "directory") {
        const resolved = await this.fs.resolve(entry.path);
        if (resolved.directoryPath && await this.collections.summary(resolved.directoryPath).catch(() => null)) kind = "collection";
      }
      children.push({ name: entry.name, path: entry.path, kind, materialization: entry.materialization });
      diagnostics.push(...entry.diagnostics);
    }
    for (const table of virtualTables) {
      const path = `${treePath === "/" ? "" : treePath}/${table}`;
      children.push({ name: table, path, kind: "collection", materialization: "available" });
    }
    return { children: children.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  private async postgresVirtualNode(treePath: string): Promise<TreeNode | null> {
    const slash = treePath.lastIndexOf("/");
    if (slash <= 0) return null;
    const parentPath = treePath.slice(0, slash) || "/";
    const table = treePath.slice(slash + 1);
    const parent = await this.fs.resolve(parentPath);
    if (!parent.directoryPath) return null;
    const summary = await this.collections.summary(parent.directoryPath).catch(() => null);
    if (summary?.backing !== "postgres" || !summary.tables?.includes(table)) return null;
    return {
      path: treePath,
      name: table,
      kind: "collection",
      revision: EMPTY_REVISION,
      writable: false,
      materialization: "available",
      collection: { ...summary, tables: undefined },
      diagnostics: [],
    };
  }

  private registerPageID(path: string, candidate: unknown): string | null {
    if (!isPageID(candidate)) return null;
    const owners = [...(this.idOwnerSets.get(candidate) ?? [])];
    if (!owners.includes(path)) owners.push(path);
    owners.sort();
    this.idOwnerSets.set(candidate, owners);
    if (!this.idOwners.has(candidate)) this.idOwners.set(candidate, path);
    return candidate;
  }

  private pageIDDiagnostics(path: string, pageID: string | null): TreeNode["diagnostics"] {
    return pageID && this.idOwners.get(pageID) !== path
      ? [{ code: "duplicate-page-id", message: `Page ID ${pageID} is also used by ${this.idOwners.get(pageID)}`, path, severity: "error" }]
      : [];
  }

  private async handleFsEvent(event: FsEvent): Promise<void> {
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
        const discovery = await discoverWorkspace(this.root);
        this.idOwners = new Map(discovery.pagePathsByID);
        this.idOwnerSets = new Map(discovery.pageIDOwners);
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
          kind: change.kind,
          path: change.path,
          previousPath: change.previousPath,
          origin: event.origin === "sync" ? "sync" : "external",
        });
      }
      return;
    }
    this.events.emit({
      kind: event.type,
      path: event.path,
      previousPath: event.previousPath,
      contentRevision: event.byteRevision,
      origin: event.origin === "sync" ? "sync" : "external",
    });
  }

  private scheduleLinkHealing(treePath: string, revision: string, document: NonNullable<TreeNode["document"]>): void {
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
      try { await this.write(treePath, { baseRevision: revision, blocks }); } catch {}
    }, 750);
    this.healingTimers.set(treePath, timer);
  }
}
