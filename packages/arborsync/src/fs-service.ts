import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ChildrenPage,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeResponse,
  WorkspaceOperation,
} from "@arbor/core";
import {
  LOCAL_TREE,
  applySourceEdits,
  canonicalJSONString,
  canonicalNodePath,
  isPageID,
  normalizeTreePath,
  sha256,
} from "@arbor/core";
import { FsConflictError, type FsMutation, WorkspaceFS } from "@arbor/fs";
import {
  ProjectionProviderError,
  arborPrivateRoot,
} from "@arbor/stores";
import type { EventBus } from "./events.ts";
import { fsErrorCode } from "./fs-errors.ts";
import { ProtocolError } from "./workspace.ts";
import type { ExpandedNode } from "./node-sampling.ts";
import { FilesystemNodeSurface } from "./filesystem-node-surface.ts";
import { writeFilesystemProperties } from "./filesystem-property-write.ts";
import { NodeProviderRouter } from "./node-provider-router.ts";


function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && "code" in (error as object);
}

function mapOsError(error: unknown, path: string): never {
  if (isSystemError(error)) {
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new ProtocolError("permission-denied", `The operating system denied access to ${path}`, 403, { path });
    }
    if (error.code === "ENOENT") {
      throw new ProtocolError("not-found", `Node not found: ${path}`, 404, { path });
    }
  }
  throw error;
}

/**
 * Realpath of the deepest existing ancestor plus the remainder, so scope
 * matching sees through symlinks without requiring the leaf to exist.
 */
export async function realOsPath(inputPath: string): Promise<string> {
  const path = normalizeTreePath(inputPath);
  let prefix = path;
  let remainder = "";
  while (prefix !== "/") {
    try {
      const real = await realpath(prefix);
      return `${real}${remainder}`;
    } catch (error) {
      if (isSystemError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
        throw new ProtocolError("permission-denied", `The operating system denied access to ${inputPath}`, 403, { path: inputPath });
      }
      remainder = `/${basename(prefix)}${remainder}`;
      prefix = dirname(prefix);
    }
  }
  return `${remainder}` || "/";
}

/**
 * Protocol adapter for paths outside every managed workspace. Logical node
 * resolution, Markdown persistence, and atomic structural mutations all use
 * WorkspaceFS in its path-only profile. This adapter adds only absolute-path
 * scope, protocol receipts/events, pagination, and collection projection.
 */
export class FilesystemService implements AsyncDisposable {
  private surface: FilesystemNodeSurface;
  private provider: NodeProviderRouter;
  private receipts = new Map<string, { requestHash: string; receipt: MutationReceipt }>();
  private engine = WorkspaceFS.open("/", {
    stateDirectory: join(arborPrivateRoot(), "system", "untracked-fs"),
    discovery: "none",
    identity: "path-only",
  });

  constructor(private events: EventBus) {
    this.surface = new FilesystemNodeSurface({
      tree: LOCAL_TREE,
      fs: () => this.engine,
      resolveRef: (ref) => this.refPath(ref),
      rootName: "/",
      writable: async (path) => (await (await this.engine).resolve(path)).writable,
      writableNode: (node) => node.writable,
      notFound: (path) => new ProtocolError("not-found", `Node not found: ${path}`, 404, { path }),
      invalidChildren: (path) => new ProtocolError("invalid-reference", `${path} does not have children`, 400, { path }),
    });
    this.provider = new NodeProviderRouter(this.surface);
  }

  private async expandedNode(inputPath: string): Promise<ExpandedNode> {
    return this.surface.expandedNode(inputPath);
  }

  private async withErrors<T>(run: () => Promise<T>, operation?: WorkspaceOperation): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (error instanceof FsConflictError) {
        const mapped = fsErrorCode(error);
        const current = error.details.current
          ? await this.snapshot({ tree: LOCAL_TREE, path: error.details.current.node.path, stableKey: null }).catch(() => undefined)
          : undefined;
        throw new ProtocolError(mapped.code, error.message, mapped.status, {
          path: error.details.path,
          retryable: mapped.retryable ?? false,
          current,
        });
      }
      if (isSystemError(error)) mapOsError(error, operation && "path" in operation ? operation.path : "/");
      throw error;
    }
  }

  async snapshot(ref: NodeRef): Promise<NodeResponse> {
    return this.withErrors(async () => {
      const observedThrough = this.events.currentCursor();
      return this.provider.snapshot(ref, observedThrough);
    });
  }

  async children(path: string, cursor?: string | null): Promise<ChildrenPage> {
    return this.withErrors(async () => {
      const observedThrough = this.events.currentCursor();
      try {
        return await this.provider.children({ tree: LOCAL_TREE, path, stableKey: null }, cursor ?? null, observedThrough);
      } catch (error) {
        if (error instanceof ProjectionProviderError && error.code === "invalid-cursor") {
          throw new ProtocolError("invalid-reference", error.message, 400, { path });
        }
        throw error;
      }
    });
  }

  async fileSurface(inputPath: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    return this.withErrors(async () => {
      const read = await (await this.engine).read(inputPath);
      if (read.node.kind === "file" && read.bytes) {
        return { bytes: read.bytes, revision: read.byteRevision, path: read.node.absolutePath };
      }
      if (raw && (read.node.kind === "markdown" || read.node.kind === "directory") && read.bytes && read.node.bodyPath) {
        return { bytes: read.bytes, revision: read.byteRevision, path: read.node.bodyPath };
      }
      return null;
    });
  }

  private refPath(ref: NodeRef): string {
    if (ref.stableKey !== null) {
      throw new ProtocolError("invalid-reference", "Durable identity resolution requires a managed workspace", 400);
    }
    return canonicalNodePath(ref.path);
  }

  private async writableContentPath(ref: NodeRef): Promise<string> {
    const target = await this.provider.writeTarget(ref);
    if (target && !target.writable) {
      throw new ProtocolError("read-only", "This collection row is read-only", 422, { path: ref.path });
    }
    return target?.storage === "physical" ? target.path : this.refPath(ref);
  }

  private unsupported(what: string): never {
    throw new ProtocolError("unsupported-operation", `${what} is unavailable outside a managed workspace`, 422);
  }

  private toFsOperation(operation: WorkspaceOperation): FsMutation {
    switch (operation.op) {
      case "createDirectory": return { op: "createDirectory", path: operation.path };
      case "createMarkdown": return { op: "createMarkdown", path: operation.path, source: operation.source };
      case "rename": return { op: "rename", path: this.refPath(operation.ref), name: operation.name };
      case "move": return {
        op: "move",
        paths: operation.refs.map((ref) => this.refPath(ref)),
        destination: this.refPath(operation.destination),
      };
      case "copy": return {
        op: "copy",
        paths: operation.refs.map((ref) => this.refPath(ref)),
        destination: this.refPath(operation.destination),
      };
      case "trash": return this.unsupported("Trash");
      case "restore": return this.unsupported("Restore");
      case "restoreRecovery": return this.unsupported("Recovery");
      case "ensureDocumentIdentity": return this.unsupported("Durable document identity");
      default: throw new ProtocolError("unsupported-operation", `Unsupported operation: ${(operation as { op: string }).op}`, 422);
    }
  }

  private async effectsFromChanges(changes: Awaited<ReturnType<WorkspaceFS["mutate"]>>["changes"]): Promise<MutationEffect[]> {
    return Promise.all(changes.map(async (change) => {
      const snapshot = await this.expandedNode(change.path).catch(() => null);
      return {
        kind: change.kind,
        ref: { tree: LOCAL_TREE, path: change.path, stableKey: null },
        previousPath: change.previousPath,
        contentRevision: snapshot?.revision,
        directoryRevision: snapshot?.kind === "directory"
          ? snapshot.revision
          : undefined,
      };
    }));
  }

  async executeMutation(request: MutationRequest): Promise<MutationReceipt> {
    const patchWrite = request.operations.find((operation) => operation.op === "writeMarkdown");
    if (patchWrite?.sourceEdits) {
      const current = await this.expandedNode(await this.writableContentPath(patchWrite.ref));
      if (current.revision !== patchWrite.baseContentRevision) {
        throw new ProtocolError("stale-content-revision", "The file changed since it was opened", 409, { path: current.path });
      }
      let result: string;
      try {
        result = applySourceEdits(current.document?.source ?? "", patchWrite.sourceEdits);
      } catch (error) {
        throw new ProtocolError("invalid-reference", error instanceof Error ? error.message : "sourceEdits are invalid", 400, {
          path: current.path,
        });
      }
      if (result !== patchWrite.source) {
        throw new ProtocolError("invalid-reference", "sourceEdits do not produce the submitted exact source", 400, {
          path: current.path,
        });
      }
    }
    const requestHash = sha256(canonicalJSONString(request));
    const existing = this.receipts.get(request.mutationID);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ProtocolError("mutation-mismatch", "This mutation ID was already used for a different request", 409, {
          mutationID: request.mutationID,
        });
      }
      return existing.receipt;
    }
    const content = request.operations.filter((operation) => operation.op === "writeProperties" || operation.op === "writeMarkdown" || operation.op === "writeText");
    if (content.length && (content.length !== 1 || request.operations.length !== 1)) {
      throw new ProtocolError("unsupported-operation", "A content mutation cannot be mixed with structural operations", 422);
    }
    const operation = request.operations[0];
    const effects: MutationEffect[] = await this.withErrors(async (): Promise<MutationEffect[]> => {
      if (content.length === 1) {
        const write = content[0]!;
        if (write.op === "writeProperties") {
          const target = await this.provider.writeTarget(write.ref);
          if (target && !target.writable) {
            throw new ProtocolError("read-only", "This collection row is read-only", 422, { path: write.ref.path });
          }
          const path = target?.storage === "physical" ? target.path : target?.parentPath ?? this.refPath(write.ref);
          return [await writeFilesystemProperties(write, path, target, {
            tree: LOCAL_TREE,
            mutationID: request.mutationID,
            provider: this.provider,
            fs: () => this.engine,
            expandedNode: (nodePath) => this.expandedNode(nodePath),
            snapshot: (ref) => this.snapshot(ref),
            snapshotCurrent: (node) => this.surface.snapshotFromExpanded(node, this.events.currentCursor()),
            mutationRef: (nodePath, _pageID, stableKey) => ({
              tree: LOCAL_TREE,
              path: nodePath,
              stableKey: stableKey ?? write.ref.stableKey,
            }),
            writeMarkdown: async (nodePath, writeRequest, options) => {
              await (await this.engine).writeMarkdown(nodePath, writeRequest, options);
              return this.expandedNode(nodePath);
            },
            error: (code, message, status, details = {}) => new ProtocolError(code, message, status, details),
            assertWritableProperties: async (ref) => {
              const sampled = await this.snapshot(ref).catch(() => null);
              if (sampled?.capabilities.properties && !sampled.capabilities.properties.writable) {
                throw new ProtocolError("read-only", "This node\'s properties are read-only", 422, { path: sampled.ref.path });
              }
            },
          })];
        }
        const result = write.op === "writeText"
          ? await (await this.engine).writeFile(this.refPath(write.ref), new TextEncoder().encode(write.source), write.baseContentRevision)
          : await (await this.engine).writeMarkdown(await this.writableContentPath(write.ref), {
              baseRevision: write.baseContentRevision,
              source: write.source,
            });
        return [{
          kind: "updated" as const,
          ref: { tree: LOCAL_TREE, path: result.node.path, stableKey: write.ref.stableKey },
          contentRevision: result.byteRevision,
          directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
        }];
      }
      const fsOperations = request.operations.map((item) => this.toFsOperation(item));
      return this.effectsFromChanges((await (await this.engine).mutate({ operations: fsOperations })).changes);
    }, operation);
    let observedThrough = this.events.currentCursor();
    for (const effect of effects) {
      observedThrough = this.events.emit({
        tree: LOCAL_TREE,
        kind: effect.kind,
        ref: effect.ref,
        previousPath: effect.previousPath,
        contentRevision: effect.contentRevision,
        propertiesRevision: effect.propertiesRevision,
        changedProperties: effect.changedProperties,
        directoryRevision: effect.directoryRevision,
        origin: "api",
        mutationID: request.mutationID,
      }).cursor;
    }
    const receipt: MutationReceipt = { mutationID: request.mutationID, observedThrough, effects };
    this.receipts.set(request.mutationID, { requestHash, receipt });
    return receipt;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.provider[Symbol.asyncDispose]();
    await (await this.engine)[Symbol.asyncDispose]();
  }
}
