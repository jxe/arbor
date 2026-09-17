import type { ObjectHash } from "@arbor/wire";
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

