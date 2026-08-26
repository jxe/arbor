import type { MergeSummary, ObjectHash, UpdateConflict } from "@arbor/wire";
import { decideUpdate } from "./decision.ts";
import { mergeWireTrees } from "./merge.ts";

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

export async function reconcileUpdate(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<ReconciledUpdate> {
  const decision = decideUpdate(base, candidate, current);
  if (decision === "current") return { outcome: "current" };
  if (decision === "accept") return { outcome: "accepted", root: candidate, generated: new Map() };
  const merged = await mergeWireTrees(base, candidate, current, load);
  return {
    outcome: "merged",
    root: merged.root,
    generated: merged.objects,
    merge: merged.summary,
    conflicts: merged.conflicts,
  };
}
