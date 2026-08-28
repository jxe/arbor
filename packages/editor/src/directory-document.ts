import type { ArborBlock, Diagnostic, MarkdownDocument } from "@arbor/core";
import { sha256 } from "@arbor/core/hash";
import { canonicalNodePath } from "@arbor/core/logical-path";
import { buildCanonicalLink, legacyPageIDCandidate, resolveLogicalURL } from "@arbor/core/logical-url";
import { pageIDStableKey } from "@arbor/core/node-key";

export const CHILDREN_MARKER = "<!-- arbor:children -->";

export interface DirectoryPlacementChild {
  name: string;
  path: string;
  stableKey?: string | null;
  /** Bounded compatibility input while Markdown PageIDs become generic keys. */
  pageID?: string;
}

export interface DirectoryPlacementResult {
  document: MarkdownDocument;
  placedChildren: string[];
  generatedChildren: string[];
  diagnostics: Diagnostic[];
}

function compareUTF8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function stableKey(child: DirectoryPlacementChild): string | null {
  return child.stableKey ?? (child.pageID ? pageIDStableKey(child.pageID) : null);
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
 * Markdown serializer omits them, so paging a large rollup never expands its
 * `_index.md`. Moving a virtual block through the managed-row operation clears
 * that flag and makes the link an authored placement.
 */
export function placeDirectoryChildren(
  directoryInput: string,
  document: MarkdownDocument,
  inputChildren: readonly DirectoryPlacementChild[],
): DirectoryPlacementResult {
  const directory = canonicalNodePath(directoryInput);
  const children = [...inputChildren].sort((left, right) =>
    compareUTF8(canonicalNodePath(left.path), canonicalNodePath(right.path))
  );
  const childByPath = new Map(children.map((child) => [canonicalNodePath(child.path), child]));
  const childByStableKey = new Map(children.flatMap((child) => {
    const key = stableKey(child);
    return key ? [[key, child] as const] : [];
  }));
  const matched = new Set<DirectoryPlacementChild>();

  const walk = (blocks: readonly ArborBlock[]): void => {
    for (const block of blocks) {
      if (block.type === "standaloneLink") {
        const resolved = resolveLogicalURL(directory, String(block.props?.path ?? ""));
        if (resolved?.kind === "local") {
          const legacy = legacyPageIDCandidate(resolved);
          const child = (resolved.stableKey && childByStableKey.get(resolved.stableKey))
            || (legacy && childByStableKey.get(pageIDStableKey(legacy)))
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
    const key = stableKey(child);
    return {
      id: `arbor-child-${sha256(`${path}\0${key ?? ""}`).slice(0, 16)}`,
      type: "standaloneLink",
      content: child.name,
      props: {
        path: buildCanonicalLink(directory, { path, stableKey: key }),
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
