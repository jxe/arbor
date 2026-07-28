import { access, cp, mkdir, readdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ArborBlock,
  ChildrenPage,
  CollectionResultPage,
  Diagnostic,
  MutationEffect,
  MutationReceipt,
  MutationRequest,
  NodeSnapshot,
  TreeChild,
  TreeNode,
  WorkspaceOperation,
} from "@arbor/core";
import {
  LOCAL_TREE,
  canonicalJSONString,
  canonicalNodePath,
  directoryIndexTreePath,
  nodeDisplayName,
  normalizeTreePath,
  revisionOf,
  sha256,
  siblingMarkdownTreePath,
} from "@arbor/core";
import { parseMarkdown, serializeMarkdown } from "@arbor/editor";
import {
  IGNORED_WORKSPACE_DIRECTORIES,
  iCloudPlaceholderLogicalName,
  iCloudPlaceholderPath,
  pathExists,
  writeAtomic,
} from "@arbor/fs";
import { CollectionStore } from "@arbor/stores";
import { decodePageCursor, encodePageCursor } from "./cursors.ts";
import type { EventBus } from "./events.ts";
import { ProtocolError } from "./workspace.ts";

const RESERVED = new Set(["schema.ts", "_store.csv", "_store.jsonl", "_store.postgres", "_store.sqlite3", "_index.md"]);
const EMPTY_REVISION = revisionOf("");

interface ResolvedLocalNode {
  path: string;
  kind: "markdown" | "directory" | "file" | "missing";
  absolutePath: string;
  directoryPath: string | null;
  bodyPath: string | null;
  bodySource: "sibling" | "index" | null;
  writable: boolean;
  materialization: "available" | "placeholder";
  diagnostics: Diagnostic[];
}

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && "code" in (error as object);
}

/** Map OS access failures to the protocol's permission-denied. */
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
 * The untracked `local` scope: browse, read, and CAS-edit the plain
 * filesystem with the same logical node shape as a shared tree, but with
 * no journal, no durable identity, no watcher, and no per-tree affordances
 * (search, backlinks, Trash, recovery). Authored mutations still publish
 * events on the shared bus so other tabs revalidate.
 */
export class FilesystemService {
  private collections = new CollectionStore();
  private receipts = new Map<string, { requestHash: string; receipt: MutationReceipt }>();

  constructor(private events: EventBus) {}

  private async isWritable(path: string): Promise<boolean> {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async resolve(inputPath: string): Promise<ResolvedLocalNode> {
    const path = canonicalNodePath(inputPath);
    const sibling = siblingMarkdownTreePath(path);
    const directPlaceholder = iCloudPlaceholderPath(path);
    const siblingPlaceholder = iCloudPlaceholderPath(sibling);
    let directInfo = null;
    try {
      directInfo = await stat(path);
    } catch (error) {
      if (isSystemError(error) && (error.code === "EACCES" || error.code === "EPERM")) mapOsError(error, path);
    }
    let siblingInfo = null;
    if (path !== "/") {
      try {
        siblingInfo = await stat(sibling);
      } catch {}
    }
    const directPlaceholderInfo = path === "/" ? null : await stat(directPlaceholder).catch(() => null);
    const siblingPlaceholderInfo = path === "/" ? null : await stat(siblingPlaceholder).catch(() => null);

    if (directInfo?.isDirectory()) {
      const indexPath = join(path, "_index.md");
      const hasIndex = await pathExists(indexPath);
      const hasSibling = Boolean(siblingInfo?.isFile());
      const diagnostics: Diagnostic[] = hasSibling && hasIndex ? [{
        code: "duplicate-body-representation",
        message: `${path} has competing bodies at ${sibling} and ${directoryIndexTreePath(path)}; keep only one.`,
        path,
        severity: "error",
      }] : [];
      const bodyPath = hasSibling ? sibling : hasIndex ? indexPath : null;
      return {
        path,
        kind: "directory",
        absolutePath: path,
        directoryPath: path,
        bodyPath,
        bodySource: hasSibling ? "sibling" : hasIndex ? "index" : null,
        writable: await this.isWritable(path) && (!bodyPath || await this.isWritable(bodyPath)),
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
        absolutePath: placeholder ? directPlaceholder : path,
        directoryPath: null,
        bodyPath: null,
        bodySource: null,
        writable: !placeholder && await this.isWritable(path),
        materialization: placeholder ? "placeholder" : "available",
        diagnostics: [],
      };
    }

    return {
      path,
      kind: "missing",
      absolutePath: path,
      directoryPath: null,
      bodyPath: null,
      bodySource: null,
      writable: await this.isWritable(dirname(path)),
      materialization: "available",
      diagnostics: [],
    };
  }

  private async node(inputPath: string): Promise<TreeNode> {
    const resolved = await this.resolve(inputPath);
    if (resolved.kind === "missing") {
      throw new ProtocolError("not-found", `Node not found: ${resolved.path}`, 404, { path: resolved.path });
    }
    if (resolved.materialization === "placeholder") {
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: resolved.kind,
        revision: revisionOf(`placeholder:${resolved.path}`),
        writable: false,
        materialization: "placeholder",
        diagnostics: resolved.diagnostics,
      };
    }
    if (resolved.kind === "file") {
      const bytes = await readFile(resolved.absolutePath).catch((error) => mapOsError(error, resolved.path));
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "file",
        revision: revisionOf(new Uint8Array(bytes)),
        writable: resolved.writable,
        materialization: resolved.materialization,
        diagnostics: resolved.diagnostics,
      };
    }
    const source = resolved.bodyPath
      ? await readFile(resolved.bodyPath, "utf8").catch((error) => mapOsError(error, resolved.path))
      : "";
    const document = parseMarkdown(source);
    const revision = revisionOf(source);
    if (resolved.kind === "markdown") {
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "markdown",
        revision,
        writable: resolved.writable,
        materialization: resolved.materialization,
        bodyOrigin: resolved.bodySource ?? undefined,
        document,
        diagnostics: resolved.diagnostics,
      };
    }
    const collection = await this.collections.summary(resolved.directoryPath!).catch(() => null);
    const children = await this.directoryChildren(resolved.path, collection?.tables ?? []);
    return {
      path: resolved.path,
      name: resolved.path === "/" ? "/" : nodeDisplayName(resolved.path),
      kind: collection ? "collection" : "directory",
      revision,
      writable: resolved.writable,
      materialization: resolved.materialization,
      bodyOrigin: resolved.bodySource ?? undefined,
      document,
      children: children.children,
      collection: collection ?? undefined,
      diagnostics: [...resolved.diagnostics, ...children.diagnostics],
    };
  }

  private async directoryChildren(
    path: string,
    virtualTables: string[],
  ): Promise<{ children: TreeChild[]; diagnostics: Diagnostic[] }> {
    const entries = await readdir(path, { withFileTypes: true }).catch((error) => mapOsError(error, path));
    const paths = new Set<string>();
    for (const entry of entries) {
      if (IGNORED_WORKSPACE_DIRECTORIES.has(entry.name) || RESERVED.has(entry.name)) continue;
      if (entry.name.includes(".arbor-txn-") || entry.name.includes(".arbor-write-")) continue;
      const logicalName = iCloudPlaceholderLogicalName(entry.name) ?? entry.name;
      const physical = `${path === "/" ? "" : path}/${logicalName}`;
      try {
        paths.add(logicalName.endsWith(".md") ? canonicalNodePath(physical) : normalizeTreePath(physical));
      } catch {}
    }
    const children: TreeChild[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const childPath of paths) {
      let child: ResolvedLocalNode;
      try {
        child = await this.resolve(childPath);
      } catch {
        continue;
      }
      if (child.kind === "missing") continue;
      let kind: TreeChild["kind"] = child.kind;
      if (child.kind === "directory" && child.directoryPath) {
        if (await this.collections.summary(child.directoryPath).catch(() => null)) kind = "collection";
      }
      children.push({
        name: nodeDisplayName(child.path),
        path: child.path,
        kind,
        materialization: child.materialization,
      });
      diagnostics.push(...child.diagnostics);
    }
    for (const table of virtualTables) {
      children.push({
        name: table,
        path: `${path === "/" ? "" : path}/${table}`,
        kind: "collection",
        materialization: "available",
      });
    }
    return { children: children.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  private snapshotFromTree(node: TreeNode, observedThrough: string): NodeSnapshot {
    return {
      ref: { tree: LOCAL_TREE, path: node.path },
      tree: LOCAL_TREE,
      path: node.path,
      name: node.name,
      kind: node.kind === "postgres" ? "database" : node.kind,
      writable: node.writable,
      materialization: node.materialization,
      contentRevision: node.revision,
      directoryRevision: node.kind === "directory" || node.kind === "collection" ? node.revision : undefined,
      ...(node.document ? { bodyState: node.bodyOrigin ? "stored" as const : "implicit" as const } : {}),
      ...(node.bodyOrigin ? { bodyOrigin: node.bodyOrigin } : {}),
      document: node.document,
      collection: node.collection,
      diagnostics: node.diagnostics,
      observedThrough,
    };
  }

  async snapshot(path: string): Promise<NodeSnapshot> {
    const observedThrough = this.events.currentCursor();
    return this.snapshotFromTree(await this.node(path), observedThrough);
  }

  async children(path: string, cursor?: string | null): Promise<ChildrenPage> {
    const observedThrough = this.events.currentCursor();
    const node = await this.node(path);
    if (node.kind !== "directory" && node.kind !== "collection") {
      throw new ProtocolError("invalid-reference", `${node.path} does not have children`, 400, { path: node.path });
    }
    const offset = decodePageCursor(cursor, `children:local:${node.path}`);
    const items = (node.children ?? []).slice(offset, offset + 100);
    const nextOffset = offset + items.length;
    return {
      parent: { tree: LOCAL_TREE, path: node.path },
      items,
      nextCursor: nextOffset < (node.children?.length ?? 0)
        ? encodePageCursor(`children:local:${node.path}`, nextOffset)
        : null,
      observedThrough,
    };
  }

  async collectionPage(path: string, cursor?: string | null, table?: string): Promise<CollectionResultPage> {
    const observedThrough = this.events.currentCursor();
    const treePath = canonicalNodePath(path);
    const resolved = await this.resolve(treePath);
    let absolute = resolved.directoryPath;
    let effectiveTable = table;
    if (!absolute) {
      const parent = await this.resolve(treePath.slice(0, treePath.lastIndexOf("/")) || "/");
      absolute = parent.directoryPath;
      effectiveTable ??= treePath.slice(treePath.lastIndexOf("/") + 1);
    }
    if (!absolute) throw new ProtocolError("invalid-reference", `${treePath} is not a collection`, 400, { path: treePath });
    const offset = decodePageCursor(cursor, `collection:local:${treePath}:${effectiveTable ?? ""}`);
    return { ...(await this.collections.page(absolute, treePath, offset, 100, effectiveTable)), observedThrough };
  }

  /** Ordinary-file bytes (or a document's stored body under `raw`). */
  async fileSurface(inputPath: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    let resolved: ResolvedLocalNode;
    try {
      resolved = await this.resolve(inputPath);
    } catch {
      return null;
    }
    if (resolved.materialization === "placeholder") return null;
    if (resolved.kind === "file") {
      const bytes = new Uint8Array(await readFile(resolved.absolutePath).catch((error) => mapOsError(error, resolved.path)));
      return { bytes, revision: revisionOf(bytes), path: resolved.absolutePath };
    }
    if (raw && (resolved.kind === "markdown" || resolved.kind === "directory") && resolved.bodyPath) {
      const bytes = new Uint8Array(await readFile(resolved.bodyPath).catch((error) => mapOsError(error, resolved.path)));
      return { bytes, revision: revisionOf(bytes), path: resolved.bodyPath };
    }
    return null;
  }

  async executeMutation(request: MutationRequest): Promise<MutationReceipt> {
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
    const effects: MutationEffect[] = [];
    for (const operation of request.operations) {
      effects.push(...await this.performOperation(operation));
    }
    let eventCursor = this.events.currentCursor();
    for (const effect of effects) {
      eventCursor = this.events.emit({
        tree: LOCAL_TREE,
        kind: effect.kind,
        path: effect.path,
        previousPath: effect.previousPath,
        contentRevision: effect.contentRevision,
        directoryRevision: effect.directoryRevision,
        origin: "api",
        mutationID: request.mutationID,
      }).cursor;
    }
    const receipt: MutationReceipt = { mutationID: request.mutationID, eventCursor, effects };
    this.receipts.set(request.mutationID, { requestHash, receipt });
    return receipt;
  }

  private unsupported(what: string): never {
    throw new ProtocolError(
      "unsupported-operation",
      `${what} requires a shared tree: give the enclosing subtree a URL to enable it`,
      422,
    );
  }

  private async performOperation(operation: WorkspaceOperation): Promise<MutationEffect[]> {
    switch (operation.op) {
      case "writeMarkdown": {
        if (!("path" in operation.ref)) {
          throw new ProtocolError("invalid-reference", "Durable identity resolution requires a live root", 400);
        }
        return [await this.writeMarkdown(operation.ref.path, operation.baseContentRevision, operation.blocks, operation.frontmatterPatch)];
      }
      case "createMarkdown": {
        const path = canonicalNodePath(operation.path);
        const target = siblingMarkdownTreePath(path);
        if ((await this.resolve(path)).kind !== "missing" || await pathExists(target)) {
          throw new ProtocolError("occupied-destination", `${path} already exists`, 409, { path });
        }
        const document = parseMarkdown("");
        const output = serializeMarkdown(document, operation.blocks ?? []);
        try {
          await writeAtomic(target, output);
        } catch (error) {
          mapOsError(error, path);
        }
        return [{ kind: "created", tree: LOCAL_TREE, path, contentRevision: revisionOf(output) }];
      }
      case "createDirectory": {
        const path = normalizeTreePath(operation.path);
        if ((await this.resolve(path)).kind !== "missing") {
          throw new ProtocolError("occupied-destination", `${path} already exists`, 409, { path });
        }
        try {
          await mkdir(path, { recursive: false });
        } catch (error) {
          mapOsError(error, path);
        }
        return [{
          kind: "created",
          tree: LOCAL_TREE,
          path,
          contentRevision: EMPTY_REVISION,
          directoryRevision: EMPTY_REVISION,
        }];
      }
      case "rename": {
        if (!("path" in operation.ref)) {
          throw new ProtocolError("invalid-reference", "Durable identity resolution requires a live root", 400);
        }
        const resolved = await this.resolve(operation.ref.path);
        if (resolved.kind === "missing") {
          throw new ProtocolError("not-found", `Node not found: ${resolved.path}`, 404, { path: resolved.path });
        }
        const destination = `${dirname(resolved.path) === "/" ? "" : dirname(resolved.path)}/${operation.name}`;
        return this.relocate(resolved, canonicalNodePath(destination));
      }
      case "move": {
        if (operation.placement === "authored" || operation.beforePath !== undefined || operation.beforeBlockID !== undefined || operation.baseDirectoryRevision !== undefined) {
          this.unsupported("Authored placement");
        }
        const destination = operation.destination;
        if (!("path" in destination)) {
          throw new ProtocolError("invalid-reference", "Durable identity resolution requires a live root", 400);
        }
        const destinationNode = await this.resolve(destination.path);
        if (destinationNode.kind !== "directory") {
          throw new ProtocolError("invalid-reference", `${destination.path} is not a directory`, 400, { path: destination.path });
        }
        const effects: MutationEffect[] = [];
        for (const ref of operation.refs) {
          if (!("path" in ref)) {
            throw new ProtocolError("invalid-reference", "Durable identity resolution requires a live root", 400);
          }
          const source = await this.resolve(ref.path);
          if (source.kind === "missing") {
            throw new ProtocolError("not-found", `Node not found: ${source.path}`, 404, { path: source.path });
          }
          const target = canonicalNodePath(
            `${destinationNode.path === "/" ? "" : destinationNode.path}/${basename(source.path)}`,
          );
          effects.push(...await this.relocate(source, target));
        }
        return effects;
      }
      case "copy": {
        const destination = operation.destination;
        if (!("path" in destination)) {
          throw new ProtocolError("invalid-reference", "Durable identity resolution requires a live root", 400);
        }
        const destinationNode = await this.resolve(destination.path);
        if (destinationNode.kind !== "directory") {
          throw new ProtocolError("invalid-reference", `${destination.path} is not a directory`, 400, { path: destination.path });
        }
        const effects: MutationEffect[] = [];
        for (const ref of operation.refs) {
          if (!("path" in ref)) {
            throw new ProtocolError("invalid-reference", "Durable identity resolution requires a live root", 400);
          }
          const source = await this.resolve(ref.path);
          if (source.kind === "missing") {
            throw new ProtocolError("not-found", `Node not found: ${source.path}`, 404, { path: source.path });
          }
          const target = canonicalNodePath(
            `${destinationNode.path === "/" ? "" : destinationNode.path}/${basename(source.path)}`,
          );
          if ((await this.resolve(target)).kind !== "missing") {
            throw new ProtocolError("occupied-destination", `${target} already exists`, 409, { path: target });
          }
          try {
            for (const pair of this.physicalPair(source, target)) {
              if (await pathExists(pair.from)) await cp(pair.from, pair.to, { recursive: true, errorOnExist: true, force: false });
            }
          } catch (error) {
            mapOsError(error, target);
          }
          effects.push({ kind: "created", tree: LOCAL_TREE, path: target });
        }
        return effects;
      }
      case "trash":
      case "restore":
        this.unsupported("Trash");
        break;
      case "restoreRecovery":
        this.unsupported("Recovery");
        break;
      case "ensureDocumentIdentity":
        this.unsupported("Durable document identity");
        break;
      default:
        throw new ProtocolError("unsupported-operation", `Unsupported operation: ${(operation as { op: string }).op}`, 422);
    }
  }

  /** The physical representations that travel together for a logical node. */
  private physicalPair(source: ResolvedLocalNode, target: string): Array<{ from: string; to: string }> {
    if (source.kind === "markdown") {
      const pairs = [{ from: source.bodyPath!, to: siblingMarkdownTreePath(target) }];
      return pairs;
    }
    if (source.kind === "directory") {
      const pairs = [{ from: source.directoryPath!, to: target }];
      if (source.bodySource === "sibling") pairs.push({ from: source.bodyPath!, to: siblingMarkdownTreePath(target) });
      return pairs;
    }
    return [{ from: source.absolutePath, to: target }];
  }

  private async relocate(source: ResolvedLocalNode, target: string): Promise<MutationEffect[]> {
    if (target === source.path) return [];
    if (source.kind === "directory" && (target === source.path || target.startsWith(`${source.path}/`))) {
      throw new ProtocolError("unsafe-path", "A directory cannot move into itself", 400, { path: source.path });
    }
    if ((await this.resolve(target)).kind !== "missing") {
      throw new ProtocolError("occupied-destination", `${target} already exists`, 409, { path: target });
    }
    try {
      for (const pair of this.physicalPair(source, target)) {
        if (await pathExists(pair.from)) await rename(pair.from, pair.to);
      }
    } catch (error) {
      mapOsError(error, target);
    }
    return [{ kind: "moved", tree: LOCAL_TREE, path: target, previousPath: source.path }];
  }

  private async writeMarkdown(
    inputPath: string,
    baseContentRevision: string,
    blocks: ArborBlock[],
    frontmatterPatch?: Record<string, unknown | null>,
  ): Promise<MutationEffect> {
    const resolved = await this.resolve(inputPath);
    if (resolved.kind === "file") {
      throw new ProtocolError("unsupported-operation", "Only Markdown and directory nodes accept Markdown writes", 422);
    }
    if (!resolved.writable && resolved.kind !== "missing") {
      throw new ProtocolError("read-only", `${resolved.path} is not writable`, 422, { path: resolved.path });
    }
    const target = resolved.kind === "directory"
      ? resolved.bodyPath ?? directoryIndexTreePath(resolved.path)
      : resolved.kind === "markdown"
        ? resolved.bodyPath!
        : siblingMarkdownTreePath(resolved.path);
    const current = await readFile(target, "utf8").catch((error) => {
      if (isSystemError(error) && error.code === "ENOENT") return "";
      mapOsError(error, resolved.path);
    }) ?? "";
    if (revisionOf(current) !== baseContentRevision) {
      const snapshot = await this.snapshot(resolved.path).catch(() => undefined);
      throw new ProtocolError("stale-content-revision", "The file changed since it was opened", 409, {
        path: resolved.path,
        current: snapshot,
      });
    }
    const document = parseMarkdown(current);
    const output = serializeMarkdown(document, blocks, frontmatterPatch ?? {});
    try {
      await writeAtomic(target, output);
    } catch (error) {
      mapOsError(error, resolved.path);
    }
    const revision = revisionOf(output);
    return {
      kind: "updated",
      tree: LOCAL_TREE,
      path: resolved.path,
      contentRevision: revision,
      directoryRevision: resolved.kind === "directory" ? revision : undefined,
    };
  }
}
