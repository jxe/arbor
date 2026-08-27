import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ChildrenPage,
  Diagnostic,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  NodeRef,
  NodeResponse,
  NodeSummary,
  WorkspaceOperation,
} from "@arbor/core";
import type { TreeChild, TreeNode } from "@arbor/core/internal";
import {
  LOCAL_TREE,
  applySourceEdits,
  canonicalJSONString,
  canonicalNodePath,
  isPageID,
  nodeDisplayName,
  normalizeTreePath,
  parseCanonicalStableKey,
  revisionOf,
  sha256,
} from "@arbor/core";
import { replaceFrontmatter } from "@arbor/editor";
import { FsConflictError, type FsMutation, WorkspaceFS } from "@arbor/fs";
import {
  CollectionCursorError,
  CollectionMutationMismatchError,
  CollectionPropertyConflictError,
  CollectionPropertyWriteError,
  CollectionSourceConflictError,
  arborPrivateRoot,
} from "@arbor/stores";
import { decodePageCursor, encodePageCursor } from "./cursors.ts";
import type { EventBus } from "./events.ts";
import { fsErrorCode } from "./fs-errors.ts";
import { ProtocolError } from "./workspace.ts";
import { nodeProperties, sampleTreeNode, summarizeTreeNode } from "./node-sampling.ts";
import { ChildProvider } from "./child-provider.ts";


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
  private provider: ChildProvider;
  private receipts = new Map<string, { requestHash: string; receipt: MutationReceipt }>();
  private engine = WorkspaceFS.open("/", {
    stateDirectory: join(arborPrivateRoot(), "system", "untracked-fs"),
    discovery: "none",
    identity: "path-only",
  });

  constructor(private events: EventBus) {
    this.provider = new ChildProvider({
      tree: LOCAL_TREE,
      resolve: async (path) => {
        const resolved = await (await this.engine).resolve(path);
        return {
          ...(resolved.directoryPath ? { directoryPath: resolved.directoryPath } : {}),
          writable: resolved.writable,
        };
      },
      snapshot: (ref, observedThrough) => this.snapshotExpanded(ref, observedThrough),
      children: (ref, cursor, observedThrough, additionalItems) => this.childrenExpanded(ref, cursor, observedThrough, additionalItems),
      writable: async (path) => (await (await this.engine).resolve(path)).writable,
    });
  }

  private async node(inputPath: string): Promise<TreeNode> {
    const fs = await this.engine;
    const read = await fs.read(inputPath);
    const resolved = read.node;
    if (resolved.kind === "missing") {
      throw new ProtocolError("not-found", `Node not found: ${resolved.path}`, 404, { path: resolved.path });
    }
    if (resolved.kind === "file" || resolved.materialization === "placeholder") {
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: resolved.kind,
        revision: read.byteRevision,
        writable: resolved.materialization === "placeholder" ? false : resolved.writable,
        materialization: resolved.materialization,
        diagnostics: resolved.diagnostics,
      };
    }
    if (resolved.kind === "markdown") {
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "markdown",
        revision: read.byteRevision,
        writable: resolved.writable,
        materialization: resolved.materialization,
        bodyOrigin: resolved.bodySource ?? undefined,
        document: read.document,
        diagnostics: resolved.diagnostics,
      };
    }
    const collection = await this.provider.summary(resolved.directoryPath!).catch(() => null);
    const children = await this.directoryChildren(resolved.path);
    return {
      path: resolved.path,
      name: resolved.path === "/" ? "/" : nodeDisplayName(resolved.path),
      kind: collection ? "collection" : "directory",
      revision: collection?.revision ? revisionOf(`${read.byteRevision}\0${collection.revision}`) : read.byteRevision,
      contentRevision: read.byteRevision,
      propertiesRevision: read.byteRevision,
      ...(collection?.revision ? { childrenRevision: collection.revision } : {}),
      writable: resolved.writable,
      materialization: resolved.materialization,
      bodyOrigin: resolved.bodySource ?? undefined,
      document: read.document,
      children: children.children,
      collection: collection ?? undefined,
      diagnostics: [...resolved.diagnostics, ...(collection?.diagnostics ?? []), ...children.diagnostics],
    };
  }

  private async directoryChildren(
    path: string,
  ): Promise<{ children: TreeChild[]; diagnostics: Diagnostic[] }> {
    const fs = await this.engine;
    const entries = await fs.list(path);
    const children: TreeChild[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const entry of entries) {
      let kind: TreeChild["kind"] = entry.kind;
      if (entry.kind === "directory") {
        const resolved = await fs.resolve(entry.path);
        if (resolved.directoryPath && await this.provider.summary(resolved.directoryPath).catch(() => null)) kind = "collection";
      }
      children.push({
        tree: LOCAL_TREE,
        name: entry.name,
        path: entry.path,
        kind,
        materialization: entry.materialization,
        ...(entry.pageID ? { pageID: entry.pageID } : {}),
      });
      diagnostics.push(...entry.diagnostics);
    }
    return { children: children.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  private snapshotFromTree(node: TreeNode, observedThrough: string): NodeResponse {
    return sampleTreeNode(node, { tree: LOCAL_TREE, observedThrough });
  }

  private async snapshotExpanded(ref: NodeRef, observedThrough: string): Promise<NodeResponse> {
    return this.snapshotFromTree(await this.node(this.refPath(ref)), observedThrough);
  }

  private async childrenExpanded(
    ref: NodeRef,
    cursor: string | null,
    observedThrough: string,
    additionalItems: readonly NodeSummary[] = [],
  ): Promise<ChildrenPage> {
    const path = this.refPath(ref);
    const node = await this.node(path);
    if (node.kind !== "directory" && node.kind !== "collection") {
      throw new ProtocolError("invalid-reference", `${path} does not have children`, 400, { path });
    }
    const physical = await Promise.all((node.children ?? []).map(async (child) => summarizeTreeNode(
      await this.node(child.path),
      LOCAL_TREE,
      child.materialization === "available" && node.writable,
    )));
    const all = [...physical, ...additionalItems].sort((left, right) => left.name.localeCompare(right.name));
    const offset = decodePageCursor(cursor, `children:local:${path}`);
    const items = all.slice(offset, offset + 100);
    const nextOffset = offset + items.length;
    return {
      parent: { tree: LOCAL_TREE, path, stableKey: null },
      items,
      nextCursor: nextOffset < all.length ? encodePageCursor(`children:local:${path}`, nextOffset) : null,
      observedThrough,
    };
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
        if (error instanceof CollectionCursorError) {
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
    return target?.backing === "markdown" ? target.path : this.refPath(ref);
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
      const snapshot = await this.node(change.path).catch(() => null);
      return {
        kind: change.kind,
        tree: LOCAL_TREE,
        path: change.path,
        previousPath: change.previousPath,
        contentRevision: snapshot?.revision,
        directoryRevision: snapshot && (snapshot.kind === "directory" || snapshot.kind === "collection")
          ? snapshot.revision
          : undefined,
      };
    }));
  }

  async executeMutation(request: MutationRequest): Promise<MutationReceipt> {
    const patchWrite = request.operations.find((operation) => operation.op === "writeMarkdown");
    if (patchWrite?.sourceEdits) {
      const current = await this.node(await this.writableContentPath(patchWrite.ref));
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
          if (target?.backing === "sqlite") {
            try {
              const row = await this.provider.writeSQLiteProperties(
                target,
                write.ref,
                write.basePropertiesRevision,
                write.properties,
                { scope: LOCAL_TREE, id: request.mutationID },
              );
              return [{
                kind: "updated" as const,
                tree: LOCAL_TREE,
                path: `${target.parentPath}/${row.path}`,
                propertiesRevision: row.revision,
              }];
            } catch (error) {
              if (error instanceof CollectionPropertyConflictError) {
                throw new ProtocolError("stale-properties-revision", error.message, 409, {
                  path: write.ref.path,
                  current: await this.snapshot(write.ref).catch(() => undefined),
                });
              }
              if (error instanceof CollectionMutationMismatchError) {
                throw new ProtocolError("mutation-mismatch", error.message, 409, { mutationID: request.mutationID });
              }
              if (error instanceof CollectionPropertyWriteError) {
                throw new ProtocolError("unsupported-operation", error.message, 422, { path: write.ref.path });
              }
              if (error instanceof Error && /constraint/i.test(error.message)) {
                throw new ProtocolError("conflict", error.message, 409, { path: write.ref.path });
              }
              throw error;
            }
          }
          if (target && (target.backing === "csv" || target.backing === "json" || target.backing === "jsonl")) {
            try {
              const prepared = await this.provider.prepareFileProperties(
                target,
                write.ref,
                write.basePropertiesRevision,
                write.properties,
              );
              const saved = await this.provider.commitFileProperties(prepared);
              return [{
                kind: "updated" as const,
                tree: LOCAL_TREE,
                path: saved.path,
                propertiesRevision: saved.revision,
              }];
            } catch (error) {
              if (error instanceof CollectionPropertyConflictError || error instanceof CollectionSourceConflictError) {
                throw new ProtocolError("stale-properties-revision", error.message, 409, {
                  path: write.ref.path,
                  current: await this.snapshot(write.ref).catch(() => undefined),
                });
              }
              if (error instanceof CollectionPropertyWriteError) {
                throw new ProtocolError("unsupported-operation", error.message, 422, { path: write.ref.path });
              }
              throw error;
            }
          }
          const sampled = await this.snapshot(write.ref).catch(() => null);
          if (sampled?.capabilities.properties && !sampled.capabilities.properties.writable) {
            throw new ProtocolError("read-only", "This node's properties are read-only", 422, { path: sampled.ref.path });
          }
          if (target && target.backing !== "markdown") {
            throw new ProtocolError("read-only", `${target.backing} rollup rows are not directly writable yet`, 422, {
              path: write.ref.path,
            });
          }
          const path = target?.path ?? this.refPath(write.ref);
          const current = await this.node(path);
          if (!current.document) throw new ProtocolError("unsupported-operation", `${path} has no editable properties`, 422, { path });
          const currentRevision = target?.revision ?? current.propertiesRevision ?? current.revision;
          if (currentRevision !== write.basePropertiesRevision) {
            throw new ProtocolError("stale-properties-revision", "The node properties changed since they were read", 409, {
              path,
              current: this.snapshotFromTree(current, this.events.currentCursor()),
            });
          }
          let properties = write.properties;
          let identityProperties: readonly string[] = [];
          if (target) {
            try {
              const prepared = await this.provider.prepareMarkdownProperties(target.directory, write.properties);
              properties = prepared.properties;
              identityProperties = prepared.identityRule?.properties ?? [];
            } catch (error) {
              if (error instanceof CollectionPropertyWriteError) {
                throw new ProtocolError("unsupported-operation", error.message, 422, { path });
              }
              throw error;
            }
            for (const name of identityProperties) {
              if (canonicalJSONString(properties[name]) !== canonicalJSONString(target.properties[name])) {
                throw new ProtocolError("invalid-reference", `Identity property ${name} is immutable`, 422, { path });
              }
            }
          }
          const identity = write.ref.stableKey ? parseCanonicalStableKey(write.ref.stableKey) : null;
          for (const [name, value] of identity ?? []) {
            if (canonicalJSONString(properties[name]) !== canonicalJSONString(value)) {
              throw new ProtocolError("invalid-reference", `Identity property ${name} is immutable`, 422, { path });
            }
          }
          const currentProperties = nodeProperties(current);
          if (isPageID(currentProperties.id) && properties.id !== currentProperties.id) {
            throw new ProtocolError("invalid-reference", "Identity property id is immutable", 422, { path });
          }
          const source = `${replaceFrontmatter(current.document.frontmatterSource, properties) ?? ""}${current.document.bodySource}`;
          const result = await (await this.engine).writeMarkdown(path, { baseRevision: current.revision, source });
          return [{
            kind: "updated" as const,
            tree: LOCAL_TREE,
            path: result.node.path,
            contentRevision: result.byteRevision,
            propertiesRevision: result.byteRevision,
            directoryRevision: result.node.kind === "directory" ? result.byteRevision : undefined,
          }];
        }
        const result = write.op === "writeText"
          ? await (await this.engine).writeFile(this.refPath(write.ref), new TextEncoder().encode(write.source), write.baseContentRevision)
          : await (await this.engine).writeMarkdown(await this.writableContentPath(write.ref), {
              baseRevision: write.baseContentRevision,
              source: write.source,
            });
        return [{
          kind: "updated" as const,
          tree: LOCAL_TREE,
          path: result.node.path,
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
        path: effect.path,
        previousPath: effect.previousPath,
        contentRevision: effect.contentRevision,
        propertiesRevision: effect.propertiesRevision,
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
