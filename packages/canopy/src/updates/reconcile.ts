export interface SourceReconciliation {
  version: "exact-source-disjoint-v1";
  basis: { id: string; root: ObjectHash };
  contributions: Array<{ change: string; operation: string }>;
  /** Absent on the earliest shared-basis records; never reinterpret old decisions. */
  rules?: Array<{ path: string; rule: string; revision: number; outcome: "resolved"; reason: string;
    inputs: { basis: ObjectHash; current: ObjectHash; candidate: ObjectHash; proposed: ObjectHash } }>;

}

export type MergeSummary =
  | SourceReconciliation
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "account-config-v1"; mergedFields: number }
  | { version: "account-config-v2"; mergedFields: number }
  | { version: "collection-file-rows-v1"; mergedRows: number };

import type { ObjectHash, UpdateConflict } from "@arbor/wire";
import { decideUpdate } from "./decision.ts";
import { mergeWireTrees, type MergeResult } from "./merge.ts";

export type ReconciledUpdate =
  | { outcome: "current" }
  | { outcome: "accepted"; root: ObjectHash; generated: Map<ObjectHash, Uint8Array> }
  | {
      outcome: "merged";
      root: ObjectHash;
      generated: Map<ObjectHash, Uint8Array>;
      merge?: MergeSummary;
      conflicts: UpdateConflict[];
      unresolvedDirectories?: string[];
    }
  | { outcome: "rejected"; root: ObjectHash; generated: Map<ObjectHash, Uint8Array>; conflicts: UpdateConflict[] };

/** A tree policy's whole-tree merge, used in place of the node-level merge. */
export type MergeStrategy = (
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
) => Promise<MergeResult>;

export interface ReconcileOptions {
  merge?: MergeStrategy;
}

export async function reconcileUpdate(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
  options: ReconcileOptions = {},
): Promise<ReconciledUpdate> {
  const decision = decideUpdate(base, candidate, current);
  if (decision === "current") return { outcome: "current" };
  if (decision === "accept") return { outcome: "accepted", root: candidate, generated: new Map() };
  const merged = await (options.merge ?? mergeWireTrees)(base, candidate, current, load);
  // A clean merge that lands exactly on the current root changed nothing.
  if (!merged.conflicts.length && merged.root === current) return { outcome: "current" };
  return {
    outcome: "merged",
    root: merged.root,
    generated: merged.objects,
    ...(merged.summary ? { merge: merged.summary } : {}),
    conflicts: merged.conflicts,
    ...(merged.unresolvedDirectories ? { unresolvedDirectories: merged.unresolvedDirectories } : {}),
  };
}
