import type { ObjectHash, UpdateConflict } from "@overstory/protocol";

/** A whole-tree merge's result: the merged root, the objects it generated,
 * and the conflicts it left. */
export interface MergeResult {
  root: ObjectHash;
  objects: Map<ObjectHash, Uint8Array>;
  conflicts: UpdateConflict[];
}

type ReconciledUpdate =
  | { outcome: "current" }
  | { outcome: "accepted"; root: ObjectHash; generated: Map<ObjectHash, Uint8Array> }
  | { outcome: "merged"; root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; conflicts: UpdateConflict[] };

/** A tree policy's whole-tree merge, used in place of the node-level merge. */
export type MergeStrategy = (
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
) => Promise<MergeResult>;

/** Identity-only snapshot fast paths; concurrent work always reconciles. */
export function decideUpdate(base: ObjectHash, candidate: ObjectHash, current: ObjectHash): "current" | "accept" | "reconcile" {
  if (candidate === current || candidate === base) return "current";
  if (current === base) return "accept";
  return "reconcile";
}

export async function reconcileUpdate(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  options: { merge: MergeStrategy },
): Promise<ReconciledUpdate> {
  const decision = decideUpdate(base, candidate, current);
  if (decision === "current") return { outcome: "current" };
  if (decision === "accept") return { outcome: "accepted", root: candidate, generated: new Map() };
  const merged = await options.merge(base, candidate, current, load);
  // A clean merge that lands exactly on the current root changed nothing.
  if (!merged.conflicts.length && merged.root === current) return { outcome: "current" };
  return { outcome: "merged", root: merged.root, generated: merged.objects, conflicts: merged.conflicts };
}
