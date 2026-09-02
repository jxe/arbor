import type { MergeSummary, ObjectHash, UpdateConflict } from "@arbor/wire";
import { decideUpdate } from "./decision.ts";
import { mergeWireTrees, type MergeResult } from "./merge.ts";

export type ReconciledUpdate =
  | { outcome: "current" }
  | { outcome: "accepted"; root: ObjectHash; generated: Map<ObjectHash, Uint8Array> }
  | {
      outcome: "merged";
      root: ObjectHash;
      generated: Map<ObjectHash, Uint8Array>;
      merge: MergeSummary;
      conflicts: UpdateConflict[];
    };

/** Three-way merge of one tree policy; the ordinary policy merges Wire graphs directly. */
export type MergeStrategy = (
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
) => Promise<MergeResult>;

export async function reconcileUpdate(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  merge: MergeStrategy = mergeWireTrees,
): Promise<ReconciledUpdate> {
  const decision = decideUpdate(base, candidate, current);
  if (decision === "current") return { outcome: "current" };
  if (decision === "accept") return { outcome: "accepted", root: candidate, generated: new Map() };
  const merged = await merge(base, candidate, current, load);
  // A clean merge that lands exactly on the current root changed nothing.
  if (!merged.conflicts.length && merged.root === current) return { outcome: "current" };
  return {
    outcome: "merged",
    root: merged.root,
    generated: merged.objects,
    merge: merged.summary,
    conflicts: merged.conflicts,
  };
}
