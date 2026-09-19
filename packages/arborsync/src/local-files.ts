import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { canonicalNodePath, normalizeTreePath, siblingMarkdownTreePath, type NodeRef } from "@arbor/core";
import type { TreeManager } from "./tree-manager.ts";
import type { Workspace } from "./workspace.ts";
import { ProtocolError } from "@arbor/core";

/** A logical path inside one placed or session workspace. */
interface ResolvedScope {
  workspace: Workspace;
  ref: NodeRef;
}

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/** The real OS path for a logical path, resolving the longest existing prefix. */
async function realOsPath(inputPath: string): Promise<string> {
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

/** Placement-scoped reads; no account administration or synchronization controls. */
export class LocalFileService {
  constructor(private readonly trees: Pick<TreeManager,
    "ownerOf" | "reservedBoundary" | "localMountBoundary" | "workspaceByTree">) {}
  async resolveScope(inputPath: string): Promise<ResolvedScope | null> {
    const canonical = canonicalNodePath(inputPath);
    const real = await realOsPath(canonical);
    const owner = await this.trees.ownerOf(real);
    if (owner) {
      const mounted = this.trees.reservedBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath))
        ?? this.trees.localMountBoundary(owner.workspace.tree, canonicalNodePath(owner.treePath));
      if (mounted) {
        const mountedWorkspace = await this.trees.workspaceByTree(mounted.tree);
        if (mountedWorkspace) {
          return { workspace: mountedWorkspace, ref: { tree: mounted.tree, path: mounted.treePath, stableKey: null } };
        }
      }
      return { workspace: owner.workspace, ref: { tree: owner.workspace.tree, path: canonicalNodePath(owner.treePath), stableKey: null } };
    }
    // A Markdown node's physical representation is its `.md` sibling; a
    // symlinked sibling can land the logical node inside a live root.
    if (canonical !== "/") {
      const realSibling = await realOsPath(siblingMarkdownTreePath(canonical)).catch(() => null);
      const siblingOwner = realSibling ? await this.trees.ownerOf(realSibling) : null;
      if (siblingOwner && siblingOwner.treePath.endsWith(".md")) {
        return { workspace: siblingOwner.workspace, ref: { tree: siblingOwner.workspace.tree, path: canonicalNodePath(siblingOwner.treePath), stableKey: null } };
      }
    }
    return null;
  }

  /**
   * Resolve a tree-rooted byte path in the scope of the referring
   * document. The DOM resolves authored tree-rooted spellings (assets)
   * against the origin; the referrer's enclosing root supplies the tree.
   */
  async fileSurfaceInScopeOf(
    referrerUrlPath: string,
    treeRootedPath: string,
    raw: boolean,
  ): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    try {
      const scope = await this.resolveScope(referrerUrlPath);
      if (!scope) return null;
      return await scope.workspace.fileSurface(treeRootedPath, raw);
    } catch {
      return null;
    }
  }

  /** The byte surface for an OS-shaped URL path, dispatched into its owning root. */
  async fileSurface(urlPath: string, raw: boolean): Promise<{ bytes: Uint8Array; revision: string; path: string } | null> {
    let scope: ResolvedScope | null;
    try {
      scope = await this.resolveScope(urlPath);
    } catch {
      return null;
    }
    if (!scope) return null;
    return scope.workspace.fileSurface(scope.ref.path, raw).catch(() => null);
  }

}
