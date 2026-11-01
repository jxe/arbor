import { encodeProvenance, normalizePieces, type ObjectHash, type ProvenanceNode } from "@ovst/protocol";
import type { Node } from "./intent-model.ts";
import { viewNodes, type RetainedState } from "./retained-state.ts";

/** The provenance index (docs/architecture/overstoryd/provenance-index.md)
 * a recorded state implies: its active nodes from the root, each text
 * file's pieces without their storage. */
export function stateProvenance(retained: RetainedState): ProvenanceNode {
  const nodes = viewNodes(retained);
  const children = new Map<string, Node[]>();
  for (const node of Object.values(nodes))
    if (node.active && node.parent !== null) {
      const list = children.get(node.parent) ?? [];
      list.push(node);
      children.set(node.parent, list);
    }
  const visit = (node: Node): ProvenanceNode => {
    if (node.kind === "tree") return { kind: "tree", node: node.id };
    if (node.kind === "file" || node.kind === "page")
      return { kind: node.kind, node: node.id, pieces: normalizePieces((node.pieces ?? []).map((p) => ({ origin: p.origin, start: p.start, length: p.length }))) };
    const entries: Record<string, ProvenanceNode> = {};
    for (const child of children.get(node.id) ?? []) entries[child.name] ??= visit(child);
    return { kind: "directory", node: node.id, entries };
  };
  const root = nodes[retained.root];
  if (!root) throw new Error("Recorded state has no root node");
  return visit(root);
}

/** `stateProvenance` written as records with `put`; the root record's hash. */
export const encodeStateProvenance = (retained: RetainedState, put: (bytes: Uint8Array) => ObjectHash): ObjectHash =>
  encodeProvenance(stateProvenance(retained), put);
