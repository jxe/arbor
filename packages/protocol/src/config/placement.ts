import type { TreeID } from "../model/identifiers.ts";
import type { TreeKind } from "../model/protocol.ts";

/** One placement: where a shared tree is placed, under which configuration
 * tree's account, and how this device may synchronize it. */
export interface SharedTreePlacement {
  conflicted?: boolean;
  configurationTree: TreeID;
  path: string;
  tree: TreeID;
  canonical?: string;
  canonicalPath?: string;
  kind?: TreeKind;
  access: "read" | "write";
  endpoint: string;
  ref?: string;
  update?: string;
  cursor?: string;
  replica?: boolean;
  /** A read-only placement (`access: read` in placements.yaml): it follows the tree and never publishes. */
  readOnly?: true;
}

export type TreePlacement = SharedTreePlacement;
