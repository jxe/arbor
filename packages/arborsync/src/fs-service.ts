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
  CollectionStore,
  arborPrivateRoot,
} from "@arbor/stores";
import { decodePageCursor, encodePageCursor } from "./cursors.ts";
import type { EventBus } from "./events.ts";
import { fsErrorCode } from "./fs-errors.ts";
import { ProtocolError } from "./workspace.ts";
import { collectionRowSummary, nodeProperties, sampleTreeNode, summarizeTreeNode } from "./node-sampling.ts";


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
  private collections = new CollectionStore();
  private receipts = new Map<string, { requestHash: string; receipt: MutationReceipt }>();
  private engine = WorkspaceFS.open("/", {
    stateDirectory: join(arborPrivateRoot(), "system", "untracked-fs"),
    discovery: "none",
    identity: "path-only",
  });

  constructor(private events: EventBus) {}

  private async node(inputPath: string): Promise<TreeNode> {
    const fs = await this.engine;
    const read = await fs.read(inputPath);
    const resolved = read.node;
    if (resolved.kind === "missing") {
      const virtual = await this.collectionVirtualNode(resolved.path);
      if (virtual) return virtual;
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
    const collection = await this.collections.summary(resolved.directoryPath!).catch(() => null);
    const children = await this.directoryChildren(resolved.path, collection?.tables ?? []);
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
    virtualTables: string[],
  ): Promise<{ children: TreeChild[]; diagnostics: Diagnostic[] }> {
    const fs = await this.engine;
    const entries = await fs.list(path);
    const children: TreeChild[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const entry of entries) {
      let kind: TreeChild["kind"] = entry.kind;
      if (entry.kind === "directory") {
        const resolved = await fs.resolve(entry.path);
        if (resolved.directoryPath && await this.collections.summary(resolved.directoryPath).catch(() => null)) kind = "collection";
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
    for (const table of virtualTables) {
      children.push({
        tree: LOCAL_TREE,
        name: table,
        path: `${path === "/" ? "" : path}/${table}`,
        kind: "collection",
        materialization: "available",
      });
    }
    return { children: children.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  private async collectionVirtualNode(treePath: string): Promise<TreeNode | null> {
    const slash = treePath.lastIndexOf("/");
    if (slash <= 0) return null;
    const parentPath = treePath.slice(0, slash) || "/";
    const table = treePath.slice(slash + 1);
    const parent = await (await this.engine).resolve(parentPath);
    if (!parent.directoryPath) return null;
    const summary = await this.collections.summary(parent.directoryPath).catch(() => null);
    if (!summary?.tables?.includes(table)) return null;
    const tableSummary = await this.collections.tableSummary(parent.directoryPath, table);
    if (!tableSummary) return null;
    return {
      path: treePath,
      name: table,
      kind: "collection",
      revision: tableSummary.revision ?? revisionOf(""),
      ...(tableSummary.revision ? { childrenRevision: tableSummary.revision } : {}),
      writable: tableSummary.editable && parent.writable,
      materialization: "available",
      collection: tableSummary,
      diagnostics: tableSummary.diagnostics ?? [],
    };
  }

  private snapshotFromTree(node: TreeNode, observedThrough: string): NodeResponse {
    return sampleTreeNode(node, { tree: LOCAL_TREE, observedThrough });
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
      const path = canonicalNodePath(ref.path);
      if (path !== "/") {
        const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
        const parent = await (await this.engine).resolve(parentPath);
        if (parent.directoryPath) {
          const summary = await this.collections.summary(parent.directoryPath).catch(() => null);
          if (summary && summary.backing !== "markdown" && summary.backing !== "postgres" && summary.backing !== "sqlite") {
            const collectionRow = await this.collections.row(parent.directoryPath, parentPath, { path, stableKey: ref.stableKey });
            if (collectionRow) {
              const parentNode = await this.node(parentPath);
              return {
                ...collectionRowSummary(collectionRow.row, { ...collectionRow.page, editable: collectionRow.page.editable && parentNode.writable }, parentPath, LOCAL_TREE),
                observedThrough,
              };
            }
          }
        } else {
          const grandparentPath = parentPath.slice(0, parentPath.lastIndexOf("/")) || "/";
          const table = parentPath.slice(parentPath.lastIndexOf("/") + 1);
          const grandparent = await (await this.engine).resolve(grandparentPath);
          if (grandparent.directoryPath) {
            const summary = await this.collections.summary(grandparent.directoryPath).catch(() => null);
            if (summary?.backing === "sqlite" && summary.tables?.includes(table)) {
              const collectionRow = await this.collections.row(grandparent.directoryPath, parentPath, { path, stableKey: ref.stableKey }, table);
              if (collectionRow) {
                const parentNode = await this.node(parentPath);
                return {
                  ...collectionRowSummary(collectionRow.row, { ...collectionRow.page, editable: collectionRow.page.editable && parentNode.writable }, parentPath, LOCAL_TREE),
                  observedThrough,
                };
              }
            }
          }
        }
      }
      if (ref.stableKey !== null) {
        throw new ProtocolError("invalid-reference", "No local collection row owns the supplied stable key", 404, { path });
      }
      return this.snapshotFromTree(await this.node(path), observedThrough);
    });
  }

  async children(path: string, cursor?: string | null): Promise<ChildrenPage> {
    return this.withErrors(async () => {
      const observedThrough = this.events.currentCursor();
      const node = await this.node(path);
      if (node.kind !== "directory" && node.kind !== "collection") {
        throw new ProtocolError("invalid-reference", `${node.path} does not have children`, 400, { path: node.path });
      }
      if (node.collection && !node.collection.tables?.length) {
        const fs = await this.engine;
        const resolved = await fs.resolve(node.path);
        let absolute = resolved.directoryPath;
        let table: string | undefined;
        if (!absolute) {
          const parent = await fs.resolve(node.path.slice(0, node.path.lastIndexOf("/")) || "/");
          absolute = parent.directoryPath;
          table = node.path.slice(node.path.lastIndexOf("/") + 1);
        }
        if (!absolute) throw new ProtocolError("invalid-reference", `${node.path} is not a collection`, 400, { path: node.path });
        let page;
        try {
          page = await this.collections.page(absolute, node.path, cursor ?? null, 100, table);
        } catch (error) {
          if (error instanceof CollectionCursorError) {
            throw new ProtocolError("invalid-reference", error.message, 400, { path: node.path });
          }
          throw error;
        }
        return {
          parent: sampleTreeNode(node, { tree: LOCAL_TREE, observedThrough }).ref,
          items: page.rows.map((row) => collectionRowSummary(row, { ...page, editable: page.editable && node.writable }, node.path, LOCAL_TREE)),
          nextCursor: page.nextCursor,
          observedThrough,
        };
      }
      const offset = decodePageCursor(cursor, `children:local:${node.path}`);
      const selected = (node.children ?? []).slice(offset, offset + 100);
      const items = await Promise.all(selected.map(async (child) => summarizeTreeNode(
        await this.node(child.path),
        LOCAL_TREE,
        child.materialization === "available" && node.writable,
      )));
      const nextOffset = offset + items.length;
      return {
        parent: { tree: LOCAL_TREE, path: node.path, stableKey: null },
        items,
        nextCursor: nextOffset < (node.children?.length ?? 0)
          ? encodePageCursor(`children:local:${node.path}`, nextOffset)
          : null,
        observedThrough,
      };
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

  private async sqlitePropertyTarget(ref: NodeRef): Promise<{
    directory: string;
    parentPath: string;
    table: string;
  } | null> {
    const path = canonicalNodePath(ref.path);
    if (path === "/") return null;
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const grandparentPath = parentPath.slice(0, parentPath.lastIndexOf("/")) || "/";
    const table = parentPath.slice(parentPath.lastIndexOf("/") + 1);
    const grandparent = await (await this.engine).resolve(grandparentPath);
    if (!grandparent.directoryPath) return null;
    const summary = await this.collections.summary(grandparent.directoryPath).catch(() => null);
    if (summary?.backing !== "sqlite" || !summary.tables?.includes(table)) return null;
    return { directory: grandparent.directoryPath, parentPath, table };
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
      const current = await this.node(this.refPath(patchWrite.ref));
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
          const sqliteTarget = await this.sqlitePropertyTarget(write.ref);
          if (sqliteTarget) {
            try {
              const row = await this.collections.writeProperties(
                sqliteTarget.directory,
                sqliteTarget.parentPath,
                write.ref,
                write.basePropertiesRevision,
                write.properties,
                sqliteTarget.table,
                { scope: LOCAL_TREE, id: request.mutationID },
              );
              return [{
                kind: "updated" as const,
                tree: LOCAL_TREE,
                path: `${sqliteTarget.parentPath}/${row.path}`,
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
          const sampled = await this.snapshot(write.ref).catch(() => null);
          if (sampled?.capabilities.properties && !sampled.capabilities.properties.writable) {
            throw new ProtocolError("read-only", "This node's properties are read-only", 422, { path: sampled.ref.path });
          }
          const path = this.refPath(write.ref);
          const current = await this.node(path);
          if (!current.document) throw new ProtocolError("unsupported-operation", `${path} has no editable properties`, 422, { path });
          const currentRevision = current.propertiesRevision ?? current.revision;
          if (currentRevision !== write.basePropertiesRevision) {
            throw new ProtocolError("stale-properties-revision", "The node properties changed since they were read", 409, {
              path,
              current: this.snapshotFromTree(current, this.events.currentCursor()),
            });
          }
          const identity = write.ref.stableKey ? parseCanonicalStableKey(write.ref.stableKey) : null;
          for (const [name, value] of identity ?? []) {
            if (write.properties[name] !== value) throw new ProtocolError("invalid-reference", `Identity property ${name} is immutable`, 422, { path });
          }
          const currentProperties = nodeProperties(current);
          if (isPageID(currentProperties.id) && write.properties.id !== currentProperties.id) {
            throw new ProtocolError("invalid-reference", "Identity property id is immutable", 422, { path });
          }
          const source = `${replaceFrontmatter(current.document.frontmatterSource, write.properties) ?? ""}${current.document.bodySource}`;
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
          : await (await this.engine).writeMarkdown(this.refPath(write.ref), {
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
    await (await this.engine)[Symbol.asyncDispose]();
  }
}
