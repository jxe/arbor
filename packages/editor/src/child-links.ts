import type { ArborBlock } from "@arbor/core";
import { canonicalNodePath, nodeDisplayName } from "@arbor/core/logical-path";
import { relativeLogicalReference, resolveLogicalURL, rewriteLocalLinkPath } from "@arbor/core/logical-url";

export interface ChildLinkMove {
  oldPath: string;
  newPath: string;
}

export interface ChildLinkTransform {
  directory: string;
  removePaths: readonly string[];
  insertMoves?: readonly ChildLinkMove[];
  /**
   * `insert` (the default) materializes a row for every insert move;
   * `update-existing` only rewrites rows that already exist and never
   * creates new ones (natural placement, rename healing).
   */
  insertMode?: "insert" | "update-existing";
  beforePath?: string;
  beforeBlockId?: string;
  createBlockId?: () => string;
}

export interface ChildLinkTransformResult {
  blocks: ArborBlock[];
  anchor: "not-requested" | "found" | "missing";
}

/** Tree-local row matching: only `local`-kind destinations name a physical child. */
export function resolveChildLinkPath(directoryInput: string, raw: string): string | null {
  const link = resolveLogicalURL(directoryInput, raw);
  return link?.kind === "local" ? link.path : null;
}

export function reorderChildLinks(
  inputBlocks: readonly ArborBlock[],
  transform: ChildLinkTransform,
): ChildLinkTransformResult {
  const directory = canonicalNodePath(transform.directory);
  const remove = new Set(transform.removePaths.map(canonicalNodePath));
  const existingByPath = new Map<string, ArborBlock>();

  const collect = (blocks: readonly ArborBlock[]) => {
    for (const block of blocks) {
      const resolved = block.type === "standaloneLink"
        ? resolveChildLinkPath(directory, String(block.props?.path ?? ""))
        : null;
      if (resolved) existingByPath.set(resolved, block);
      collect(block.children);
    }
  };
  collect(inputBlocks);

  const strip = (blocks: readonly ArborBlock[]): ArborBlock[] => blocks.flatMap((block) => {
    const resolved = block.type === "standaloneLink"
      ? resolveChildLinkPath(directory, String(block.props?.path ?? ""))
      : null;
    if (resolved && remove.has(resolved)) return [];
    return [{ ...block, children: strip(block.children) }];
  });
  const remaining = strip(inputBlocks);
  const moves = (transform.insertMoves ?? []).filter((move) =>
    transform.insertMode !== "update-existing" || existingByPath.has(canonicalNodePath(move.oldPath))
  );
  if (!moves.length) return { blocks: remaining, anchor: "not-requested" };

  const createBlockId = transform.createBlockId ?? (() => `child-${crypto.randomUUID()}`);
  const inserted = moves.map((move) => {
    const oldPath = canonicalNodePath(move.oldPath);
    const newPath = canonicalNodePath(move.newPath);
    const existing = existingByPath.get(oldPath);
    const oldName = nodeDisplayName(oldPath);
    const newName = nodeDisplayName(newPath);
    return existing ? {
      ...existing,
      content: existing.content === oldName ? newName : existing.content,
      props: {
        ...existing.props,
        arborGenerated: false,
        path: rewriteLocalLinkPath(directory, String(existing.props?.path ?? ""), newPath)
          ?? relativeLogicalReference(directory, newPath),
      },
    } : {
      id: createBlockId(),
      type: "standaloneLink",
      content: newName,
      props: { path: relativeLogicalReference(directory, newPath) },
      children: [],
    } satisfies ArborBlock;
  });

  const anchorPath = transform.beforePath ? canonicalNodePath(transform.beforePath) : null;
  const anchorRequested = Boolean(anchorPath || transform.beforeBlockId);
  if (!anchorRequested) return { blocks: [...remaining, ...inserted], anchor: "not-requested" };

  const insertBefore = (blocks: readonly ArborBlock[]): [ArborBlock[], boolean] => {
    const result: ArborBlock[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const resolved = block.type === "standaloneLink"
        ? resolveChildLinkPath(directory, String(block.props?.path ?? ""))
        : null;
      if (block.id === transform.beforeBlockId || anchorPath && resolved === anchorPath) {
        return [[...result, ...inserted, block, ...blocks.slice(index + 1)], true];
      }
      const [children, didInsert] = insertBefore(block.children);
      if (didInsert) return [[...result, { ...block, children }, ...blocks.slice(index + 1)], true];
      result.push({ ...block, children });
    }
    return [result, false];
  };
  const [blocks, found] = insertBefore(remaining);
  return {
    blocks: found ? blocks : remaining,
    anchor: found ? "found" : "missing",
  };
}
