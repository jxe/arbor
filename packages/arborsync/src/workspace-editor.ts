import type {
  ArborBlock,
  ChildrenPage,
  ContentWorkspaceOperation,
  LocalTreeDescriptor,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeResponse,
  NodeWriteRequest,
  StructuralWorkspaceOperation,
  TreeID,
  WorkspaceOperation,
} from "@arbor/core";
import {
  applySourceEdits,
  canonicalNodePath,
  isPageID,
  pageIDFromStableKey,
  pageIDStableKey,
  resolveLogicalURL,
  rewriteLocalLinkPath,
  sha256,
  stableJSONString,
} from "@arbor/core";
import { mintPageID, patchFrontmatter, serializeMarkdown } from "@arbor/editor";
import {
  FsConflictError,
  FsInjectedCrashError,
  type FsMutation,
  type FsWriteResult,
  MutationJournal,
  type WorkspaceDiscovery,
  WorkspaceFS,
} from "@arbor/fs";
import {
  ProjectionProviderError,
  type ProjectionWriteTarget,
} from "@arbor/stores";
import { basename, join, posix } from "node:path";
import { EventBus } from "./events.ts";
import { FilesystemNodeSurface } from "./filesystem-node-surface.ts";
import { writeFilesystemProperties } from "./filesystem-property-write.ts";
import { generateTreeTypes, generatedTypeDeclarationPath } from "./generated-types.ts";
import { NodeProviderRouter } from "./node-provider-router.ts";
import type { ExpandedNode } from "./node-sampling.ts";
import { ProtocolError } from "@arbor/core";
import { RevisionConflictError } from "./node-sampling.ts";

export interface ConfirmedSourcePatch {
  baseSource: string;
  resultSource: string;
  edits: NonNullable<Extract<WorkspaceOperation, { op: "writeMarkdown" }>["sourceEdits"]>;
}

/** Node projection and durable editor mutations over the folder's shared filesystem. */
export class WorkspaceEditor implements AsyncDisposable {
  private readonly mutations: MutationJournal;
  private surface: FilesystemNodeSurface;
  private provider: NodeProviderRouter;
  private idOwners = new Map<string, string>();
  private idOwnerSets = new Map<string, readonly string[]>();
  private pathPageIDs = new Map<string, string>();
  private healingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(readonly root: string, private readonly stateDirectory: string,
    readonly fs: WorkspaceFS, readonly tree: TreeID, readonly events: EventBus,
    private readonly descriptor: () => LocalTreeDescriptor,
    private readonly faultInjector?: (stage: string) => void | Promise<void>) {
    this.mutations = new MutationJournal(join(stateDirectory, "journal", "mutations"));
    this.surface = new FilesystemNodeSurface({
      tree: this.tree,
      enclosingTree: () => this.descriptor(),
      fs: () => this.fs,
      resolveRef: (ref) => this.resolveRef(ref),
      rootName: basename(this.root),
      writable: async (path) => {
        const resolved = await this.fs.resolve(path);
        return resolved.writable && this.descriptor().access !== "read";
      },
      writableNode: (node) => node.writable && this.descriptor().access !== "read",
      inspectDocument: ({ path, revision, document }) => {
        const pageID = this.registerPageID(path, document.frontmatter.id);
        this.scheduleLinkHealing(path, revision, document);
        return this.pageIDDiagnostics(path, pageID);
      },
      childPageID: (path, discovered) => discovered ?? this.pathPageIDs.get(path),
      notFound: (path) => new ProtocolError("not-found", `Node not found: ${path}`, 404, { path }),
      invalidChildren: (path) => new ProtocolError("invalid-reference", `${path} does not have children`, 400, { path }),
    });
    this.provider = new NodeProviderRouter(this.surface);
  }
  /** Recovery always runs during folder open, even with no editor client attached. */
  async initialize(discovery: WorkspaceDiscovery, recursive: boolean): Promise<void> {
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    if (recursive) await this.generateTypes(discovery);
    await this.finishRecoveredMutations();
  }
  /** Stop delayed authored writes before the folder drains its object audit. */
  cancelPendingHealing(): void {
    for (const timer of this.healingTimers.values()) clearTimeout(timer);
    this.healingTimers.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.cancelPendingHealing();
    await this.provider[Symbol.asyncDispose]();
  }
  mutationRef(path: string, pageID?: string, stableKey?: string | null): NodeRef {
    return {
      tree: this.tree,
      path,
      stableKey: stableKey ?? (pageID ? pageIDStableKey(pageID) : this.pathPageIDs.get(path) ? pageIDStableKey(this.pathPageIDs.get(path)!) : null),
    };
  }

  describeWireCollectionFile(directory: string, sourceName: string) {
    return this.provider.collectionFileDescriptor(directory, sourceName);
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
    await this.refreshDerivedViews(request.operations);
    await this.mutations.markMaterialized(request.mutationID, requestHash, effects);
    if (!materializationFaulted) await this.protocolFault("protocol:materialized");
    return this.completeMaterialized(request.mutationID, requestHash, effects, "api");
  }

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

  private async refreshDerivedViews(operations: WorkspaceOperation[]): Promise<void> {
    const contentOnly = operations.every((operation) =>
      operation.op === "writeMarkdown"
      || operation.op === "writeProperties"
      || operation.op === "writeText"
      || operation.op === "restoreRecovery"
      || operation.op === "ensureDocumentIdentity"
    );
    if (contentOnly) return;
    const discovery = await this.fs.discoverRecursively();
    this.adoptIDMaps(discovery.pagePathsByID, discovery.pageIDOwners);
    await this.generateTypes(discovery);
  }

  private async expandedNode(inputPath: string): Promise<ExpandedNode> {
    return this.surface.expandedNode(inputPath);
  }

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
    if (this.descriptor().access === "read") {
      throw new ProtocolError("read-only", "This tree placement is read-only", 422);
    }
  }

  async generateTypes(discovery?: WorkspaceDiscovery): Promise<void> {
    return generateTreeTypes({ root: this.root, stateDirectory: this.stateDirectory, fs: this.fs, provider: this.provider, discovery });
  }

  generatedTypeDeclarationPath(): string {
    return generatedTypeDeclarationPath(this.stateDirectory);
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

  adoptIDMaps(pagePathsByID: ReadonlyMap<string, string>, pageIDOwners: ReadonlyMap<string, readonly string[]>): void {
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

  private scheduleLinkHealing(treePath: string, revision: string, document: NonNullable<ExpandedNode["document"]>): void {
    const base = posix.dirname(treePath);
    const healTarget = (target: string): string => {
      const resolved = resolveLogicalURL(base, target);
      if (resolved?.kind !== "local") return target;
      let id = pageIDFromStableKey(resolved.stableKey) ?? resolved.legacyStableKeyCandidate;
      if (!id) return target;
      try { id = decodeURIComponent(id); } catch { return target; }
      const owner = this.idOwners.get(id);
      if (!owner) return target;
      return rewriteLocalLinkPath(base, target, owner) ?? target;
    };
    const healBlock = (block: ArborBlock): ArborBlock => {
      let changed = false;
      const content = (block.content ?? "").replace(/\]\(([^)]+)\)/g, (match, target: string) => {
        const healed = healTarget(target);
        if (healed === target) return match;
        changed = true;
        return `](${healed})`;
      });
      let props = block.props;
      if (block.type === "standaloneLink" && typeof block.props?.path === "string") {
        const originalPath = block.props.path;
        const path = healTarget(originalPath);
        if (path !== originalPath) {
          changed = true;
          props = { ...block.props, path };
        }
      }
      const children = block.children.map(healBlock);
      if (children.some((child, index) => child !== block.children[index])) changed = true;
      return changed ? { ...block, content, props, children } : block;
    };
    const blocks = document.blocks.map(healBlock);
    if (!blocks.some((block, index) => block !== document.blocks[index])) return;
    const pending = this.healingTimers.get(treePath);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(async () => {
      this.healingTimers.delete(treePath);
      try { await this.write(treePath, { baseRevision: revision, source: serializeMarkdown(document, blocks) }); } catch {}
    }, 750);
    this.healingTimers.set(treePath, timer);
  }
}
