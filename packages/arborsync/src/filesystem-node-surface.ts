import type {
  ChildrenPage,
  Diagnostic,
  LocalTreeDescriptor,
  MarkdownDocument,
  NodeRef,
  NodeResponse,
  NodeSummary,
  TreeRef,
} from "@arbor/core";
import { isPageID, nodeDisplayName, pageIDStableKey } from "@arbor/core";
import type { WorkspaceFS } from "@arbor/fs";
import { decodePageCursor, encodePageCursor } from "./cursors.ts";
import {
  sampleExpandedNode,
  summarizeExpandedNode,
  type ExpandedChild,
  type ExpandedNode,
} from "./node-sampling.ts";

interface FilesystemDocumentContext {
  path: string;
  revision: string;
  document: MarkdownDocument;
}

export interface FilesystemNodeSurfaceOptions {
  tree: TreeRef;
  fs(): WorkspaceFS | Promise<WorkspaceFS>;
  resolveRef(ref: NodeRef): string | Promise<string>;
  rootName: string;
  enclosingTree?(): LocalTreeDescriptor;
  writable(path: string): boolean | Promise<boolean>;
  writableNode(node: ExpandedNode): boolean;
  inspectDocument?(context: FilesystemDocumentContext): readonly Diagnostic[];
  childPageID?(path: string, discovered?: string): string | undefined;
  notFound(path: string): Error;
  invalidChildren(path: string): Error;
}

/** Shared physical-filesystem projection for managed trees and untracked paths. */
export class FilesystemNodeSurface {
  readonly tree: TreeRef;

  constructor(private readonly options: FilesystemNodeSurfaceOptions) { this.tree = options.tree; }

  enclosingTree(): LocalTreeDescriptor | undefined { return this.options.enclosingTree?.(); }

  async resolve(path: string): Promise<{ directoryPath?: string; writable: boolean }> {
    const resolved = await (await this.options.fs()).resolve(path);
    return {
      ...(resolved.directoryPath ? { directoryPath: resolved.directoryPath } : {}),
      writable: resolved.writable,
    };
  }

  async writable(path: string): Promise<boolean> { return this.options.writable(path); }
  async expandedNode(inputPath: string): Promise<ExpandedNode> {
    const read = await (await this.options.fs()).read(inputPath);
    const resolved = read.node;
    if (resolved.kind === "missing") throw this.options.notFound(resolved.path);
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

    const document = read.document!;
    const documentDiagnostics = this.options.inspectDocument?.({
      path: resolved.path,
      revision: read.byteRevision,
      document,
    }) ?? [];
    if (resolved.kind === "markdown") {
      return {
        path: resolved.path,
        name: nodeDisplayName(resolved.path),
        kind: "markdown",
        revision: read.byteRevision,
        writable: resolved.writable,
        materialization: resolved.materialization,
        bodyOrigin: resolved.bodySource ?? undefined,
        document,
        diagnostics: [...resolved.diagnostics, ...documentDiagnostics],
      };
    }

    const children = await this.directoryChildren(resolved.path);
    return {
      path: resolved.path,
      name: resolved.path === "/" ? this.options.rootName : nodeDisplayName(resolved.path),
      kind: "directory",
      revision: read.byteRevision,
      contentRevision: read.byteRevision,
      propertiesRevision: read.byteRevision,
      writable: resolved.writable,
      materialization: resolved.materialization,
      bodyOrigin: resolved.bodySource ?? undefined,
      document,
      children: children.children,
      diagnostics: [
        ...resolved.diagnostics,
        ...documentDiagnostics,
        ...children.diagnostics,
      ],
    };
  }

  snapshotFromExpanded(node: ExpandedNode, observedThrough: string): NodeResponse {
    return sampleExpandedNode(node, {
      tree: this.options.tree,
      observedThrough,
      writable: this.options.writableNode(node),
      ...(this.options.enclosingTree ? { enclosingTree: this.options.enclosingTree() } : {}),
    });
  }

  async snapshot(ref: NodeRef, observedThrough: string): Promise<NodeResponse> {
    const path = await this.options.resolveRef(ref);
    return this.snapshotFromExpanded(await this.expandedNode(path), observedThrough);
  }

  async children(
    ref: NodeRef,
    cursor: string | null,
    observedThrough: string,
    additionalItems: readonly NodeSummary[] = [],
  ): Promise<ChildrenPage> {
    const path = await this.options.resolveRef(ref);
    const node = await this.expandedNode(path);
    if (node.kind !== "directory") throw this.options.invalidChildren(path);
    const physical = await Promise.all((node.children ?? []).map(async (child) => summarizeExpandedNode(
      await this.expandedNode(child.path),
      this.options.tree,
      child.materialization === "available" && this.options.writableNode(node),
    )));
    const all = [...physical, ...additionalItems].sort((left, right) => left.name.localeCompare(right.name));
    const childrenRevision = node.childrenRevision ?? node.revision;
    const cursorKey = `children:${this.options.tree}:${path}:${childrenRevision}`;
    const offset = decodePageCursor(cursor, cursorKey);
    const items = all.slice(offset, offset + 100);
    const nextOffset = offset + items.length;
    return {
      parent: {
        tree: this.options.tree,
        path,
        stableKey: isPageID(node.document?.frontmatter.id) ? pageIDStableKey(node.document.frontmatter.id) : null,
      },
      items,
      nextCursor: nextOffset < all.length ? encodePageCursor(cursorKey, nextOffset) : null,
      observedThrough,
    };
  }

  private async directoryChildren(path: string): Promise<{ children: ExpandedChild[]; diagnostics: Diagnostic[] }> {
    const entries = await (await this.options.fs()).list(path);
    const children: ExpandedChild[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const entry of entries) {
      const pageID = this.options.childPageID?.(entry.path, entry.pageID) ?? entry.pageID;
      children.push({
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        materialization: entry.materialization,
        ...(pageID ? { pageID } : {}),
      });
      diagnostics.push(...entry.diagnostics);
    }
    return { children: children.sort((left, right) => left.name.localeCompare(right.name)), diagnostics };
  }

}
