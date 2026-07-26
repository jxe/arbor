import type { ArborBlock, Materialization, MarkdownDocument, TreeChild } from "./types.ts";
import type { LogicalPath, ProtocolNodeKind, ResolvedNodeRef } from "./protocol.ts";
import { canonicalNodePath } from "./logical-path.ts";
import { relativeLogicalReference, resolveLogicalURL } from "./logical-url.ts";

/**
 * The client-derived projected directory document (spec/format.md §4).
 *
 * arbord returns storage-shaped facts — the stored or implicit body plus the
 * authoritative child listing. Clients derive this projection; it never
 * appears in a REST `NodeSnapshot.document`, and synthetic rows are never
 * serialized back through `writeMarkdown`.
 */
export interface ProjectedDocument {
  /** The stored body (or an empty document when the body is implicit). Never mutated. */
  source: MarkdownDocument;
  /** Stored blocks plus one appended synthetic row per unmatched child. */
  visibleBlocks: ArborBlock[];
  /** One entry per immediate child, in projected document order. */
  managedChildren: ManagedChildRow[];
  bodyState: "stored" | "implicit";
}

export interface ManagedChildRow {
  blockID: string;
  ref: ResolvedNodeRef;
  origin: "authored" | "synthetic";
  kind: ProtocolNodeKind;
  materialization: Materialization;
}

export interface ProjectionInput {
  path: LogicalPath;
  /** The stored document, or null when the directory body is implicit. */
  document: MarkdownDocument | null;
  /** The complete, drained child listing in authoritative server order. */
  children: readonly TreeChild[];
}

/**
 * Editor-only block ID for a synthetic managed row, derived from child
 * identity so it is stable across reprojections and sibling reorders. The
 * `managed:` prefix is load-bearing: these IDs must never be sent to the
 * server as block IDs or anchors.
 */
export function syntheticRowBlockID(child: { pageID?: string; path: string }): string {
  return child.pageID ? `managed:id:${child.pageID}` : `managed:path:${canonicalNodePath(child.path)}`;
}

export function isSyntheticRowBlockID(blockID: string): boolean {
  return blockID.startsWith("managed:");
}

/** The wire child listing still uses the fs kind vocabulary in places. */
function protocolKind(kind: TreeChild["kind"] | ProtocolNodeKind): ProtocolNodeKind {
  return kind === "postgres" ? "database" : kind;
}

const EMPTY_DOCUMENT: MarkdownDocument = {
  frontmatter: {},
  frontmatterSource: null,
  bodySource: "",
  blocks: [],
};

export function projectDirectoryDocument(input: ProjectionInput): ProjectedDocument {
  const directory = canonicalNodePath(input.path);
  const source = input.document ?? EMPTY_DOCUMENT;

  const childByPath = new Map<string, TreeChild>();
  const childByPageID = new Map<string, TreeChild>();
  for (const child of input.children) {
    childByPath.set(canonicalNodePath(child.path), child);
    if (child.pageID) childByPageID.set(child.pageID, child);
  }

  const matched = new Map<TreeChild, { blockID: string; order: number }>();
  let order = 0;

  const walk = (blocks: readonly ArborBlock[]) => {
    for (const block of blocks) {
      order += 1;
      if (block.type === "standaloneLink") {
        const link = resolveLogicalURL(directory, String(block.props?.path ?? ""));
        let child: TreeChild | undefined;
        if (link?.kind === "local") {
          // A durable ID wins over a stale path.
          child = (link.pageID && childByPageID.get(link.pageID)) || childByPath.get(link.path);
        }
        if (child && !matched.has(child)) {
          matched.set(child, { blockID: block.id, order });
        }
      }
      walk(block.children);
    }
  };
  walk(source.blocks);

  const authoredRows = [...matched.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([child, { blockID }]): ManagedChildRow => ({
      blockID,
      ref: { path: canonicalNodePath(child.path), ...child.pageID ? { pageID: child.pageID } : {} },
      origin: "authored",
      kind: protocolKind(child.kind),
      materialization: child.materialization,
    }));

  const syntheticChildren = input.children.filter((child) => !matched.has(child));
  const syntheticBlocks = syntheticChildren.map((child): ArborBlock => ({
    id: syntheticRowBlockID(child),
    type: "standaloneLink",
    content: child.name,
    props: { path: relativeLogicalReference(directory, child.path) },
    children: [],
  }));
  const syntheticRows = syntheticChildren.map((child, index): ManagedChildRow => ({
    blockID: syntheticBlocks[index]!.id,
    ref: { path: canonicalNodePath(child.path), ...child.pageID ? { pageID: child.pageID } : {} },
    origin: "synthetic",
    kind: protocolKind(child.kind),
    materialization: child.materialization,
  }));

  return {
    source,
    visibleBlocks: [...source.blocks, ...syntheticBlocks],
    managedChildren: [...authoredRows, ...syntheticRows],
    bodyState: input.document ? "stored" : "implicit",
  };
}
