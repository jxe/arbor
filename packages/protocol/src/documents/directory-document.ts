import type { OverstoryBlock, MarkdownDocument } from "../index.ts";
import { sha256 } from "../model/hash.ts";
import { compareUTF8 } from "../model/utf8.ts";
import { canonicalNodePath } from "../model/logical-path.ts";
import { buildMarkdownLink, markdownSourceDirectory, resolveLogicalURL, type MarkdownBodyOrigin } from "../model/logical-url.ts";

export interface DirectoryPlacementChild {
  name: string;
  path: string;
  body: MarkdownBodyOrigin | null;
  stableKey?: string | null;
}

/** A directory node and where its own Markdown body lives, which is where its rows resolve from. */
export interface PlacementDirectory {
  path: string;
  body: MarkdownBodyOrigin | null;
}

export interface DirectoryPlacementResult {
  /** The authored document, unchanged. */
  document: MarkdownDocument;
  /** The remainder: unclaimed children, in canonical order, which stand after the authored source. */
  remainder: OverstoryBlock[];
  placedChildren: string[];
  generatedChildren: string[];
}

/**
 * Place a directory's current child generation against its parsed document.
 * Clients show the result through `presentPage`, which decides how the
 * remainder reads.
 *
 * Authored standalone links claim their first matching child. Unclaimed
 * children are virtual blocks returned as `remainder`. Virtual blocks carry
 * `storyGenerated` and the Markdown serializer omits them, so paging a large
 * collection file never expands its `_index.md`. Moving a virtual block
 * through the managed-row operation clears that flag and makes the link an
 * authored placement.
 */
export function placeDirectoryChildren(
  placement: PlacementDirectory,
  document: MarkdownDocument,
  inputChildren: readonly DirectoryPlacementChild[],
): DirectoryPlacementResult {
  const directory = canonicalNodePath(placement.path);
  const sourceDirectory = markdownSourceDirectory(directory, placement.body);
  const children = [...inputChildren].sort((left, right) =>
    compareUTF8(canonicalNodePath(left.path), canonicalNodePath(right.path))
  );
  const childByPath = new Map(children.map((child) => [canonicalNodePath(child.path), child]));
  const childByStableKey = new Map(children.flatMap((child) => child.stableKey ? [[child.stableKey, child] as const] : []));
  const matched = new Set<DirectoryPlacementChild>();

  const walk = (blocks: readonly OverstoryBlock[]): void => {
    for (const block of blocks) {
      if (block.type === "standaloneLink") {
        const resolved = resolveLogicalURL(sourceDirectory, String(block.props?.path ?? ""));
        if (resolved?.kind === "local") {
          const child = (resolved.stableKey && childByStableKey.get(resolved.stableKey))
            || childByPath.get(resolved.path);
          if (child) matched.add(child);
        }
      }
      walk(block.children);
    }
  };
  walk(document.blocks);

  const missing = children.filter((child) => !matched.has(child));
  const generated = missing.map((child, ordinal): OverstoryBlock => {
    const path = canonicalNodePath(child.path);
    const key = child.stableKey ?? null;
    return {
      id: `arbor-child-${sha256(`${path}\0${key ?? ""}`).slice(0, 16)}`,
      type: "standaloneLink",
      content: child.name,
      props: {
        path: buildMarkdownLink(sourceDirectory, { path, body: child.body, stableKey: key }),
        storyGenerated: true,
        storyOrdinal: ordinal,
      },
      children: [],
    };
  });

  return {
    document,
    remainder: generated,
    placedChildren: children.map((child) => canonicalNodePath(child.path)),
    generatedChildren: missing.map((child) => canonicalNodePath(child.path)),
  };
}
