import type { ArborBlock } from "./types.ts";
import { canonicalNodePath, nodeDisplayName } from "./logical-path.ts";
import { relativeLogicalReference, resolveLogicalURL } from "./logical-url.ts";

export interface StructuralRowMove {
  oldPath: string;
  newPath: string;
}

export interface StructuralRowTransform {
  directory: string;
  removePaths: readonly string[];
  insertMoves?: readonly StructuralRowMove[];
  beforePath?: string;
  beforeBlockId?: string;
  createBlockId?: () => string;
}

export interface StructuralRowTransformResult {
  blocks: ArborBlock[];
  anchor: "not-requested" | "found" | "missing";
}

/** Tree-local row matching: only `local`-kind destinations name a physical child. */
export function resolveStructuralRowPath(directoryInput: string, raw: string): string | null {
  const link = resolveLogicalURL(directoryInput, raw);
  return link?.kind === "local" ? link.path : null;
}

export function transformStructuralRows(
  inputBlocks: readonly ArborBlock[],
  transform: StructuralRowTransform,
): StructuralRowTransformResult {
  const directory = canonicalNodePath(transform.directory);
  const remove = new Set(transform.removePaths.map(canonicalNodePath));
  const existingByPath = new Map<string, ArborBlock>();

  const collect = (blocks: readonly ArborBlock[]) => {
    for (const block of blocks) {
      const resolved = block.type === "standaloneLink"
        ? resolveStructuralRowPath(directory, String(block.props?.path ?? ""))
        : null;
      if (resolved) existingByPath.set(resolved, block);
      collect(block.children);
    }
  };
  collect(inputBlocks);

  const strip = (blocks: readonly ArborBlock[]): ArborBlock[] => blocks.flatMap((block) => {
    const resolved = block.type === "standaloneLink"
      ? resolveStructuralRowPath(directory, String(block.props?.path ?? ""))
      : null;
    if (resolved && remove.has(resolved)) return [];
    return [{ ...block, children: strip(block.children) }];
  });
  const remaining = strip(inputBlocks);
  const moves = transform.insertMoves ?? [];
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
        path: relativeLogicalReference(directory, newPath),
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
        ? resolveStructuralRowPath(directory, String(block.props?.path ?? ""))
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
