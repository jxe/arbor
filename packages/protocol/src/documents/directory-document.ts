import type { ArborBlock, Diagnostic, MarkdownDocument } from "../index.ts";
import { sha256 } from "../model/hash.ts";
import { compareUTF8 } from "../model/utf8.ts";
import { canonicalNodePath } from "../model/logical-path.ts";
import { buildMarkdownLink, markdownSourceDirectory, resolveLogicalURL, type MarkdownBodyOrigin } from "../model/logical-url.ts";

export const CHILDREN_MARKER = "<!-- arbor:children -->";

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
  document: MarkdownDocument;
  placedChildren: string[];
  generatedChildren: string[];
  diagnostics: Diagnostic[];
}

function isChildrenMarker(block: ArborBlock): boolean {
  return block.type === "rawMarkdown" && String(block.content ?? block.source ?? "").trim() === CHILDREN_MARKER;
}

export function directoryPlacementDiagnostics(
  directoryInput: string,
  document: MarkdownDocument,
): Diagnostic[] {
  const directory = canonicalNodePath(directoryInput);
  const markers = document.blocks.filter(isChildrenMarker);
  return markers.length <= 1 ? [] : [{
    code: "duplicate-children-marker",
    message: `${directory} contains ${markers.length} standalone ${CHILDREN_MARKER} markers; keep at most one.`,
    path: directory,
    severity: "error",
  }];
}

/**
 * Project a directory's current child generation into its parsed document.
 *
 * Authored standalone links claim their first matching child. Unclaimed
 * children are virtual blocks at the explicit marker, or after authored source
 * when the marker is absent. Virtual blocks carry `arborGenerated` and the
 * Markdown serializer omits them, so paging a large collection file never expands its
 * `_index.md`. Moving a virtual block through the managed-row operation clears
 * that flag and makes the link an authored placement.
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

  const walk = (blocks: readonly ArborBlock[]): void => {
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

  const diagnostics = directoryPlacementDiagnostics(directory, document);
  if (diagnostics.length) {
    return {
      document,
      placedChildren: [...matched].map((child) => canonicalNodePath(child.path)),
      generatedChildren: [],
      diagnostics,
    };
  }

  const missing = children.filter((child) => !matched.has(child));
  const generated = missing.map((child): ArborBlock => {
    const path = canonicalNodePath(child.path);
    const key = child.stableKey ?? null;
    return {
      id: `arbor-child-${sha256(`${path}\0${key ?? ""}`).slice(0, 16)}`,
      type: "standaloneLink",
      content: child.name,
      props: {
        path: buildMarkdownLink(sourceDirectory, { path, body: child.body, stableKey: key }),
        arborGenerated: true,
      },
      children: [],
    };
  });

  const markerIndex = document.blocks.findIndex(isChildrenMarker);
  const blocks = document.blocks.map((block) => isChildrenMarker(block)
    ? { ...block, props: { ...block.props, arborChildrenMarker: true } }
    : block
  );
  if (generated.length) blocks.splice(markerIndex === -1 ? blocks.length : markerIndex + 1, 0, ...generated);

  return {
    document: { ...document, blocks },
    placedChildren: children.map((child) => canonicalNodePath(child.path)),
    generatedChildren: missing.map((child) => canonicalNodePath(child.path)),
    diagnostics,
  };
}
