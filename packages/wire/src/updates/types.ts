import type { ObjectHash, TreeSnapshot } from "../objects.ts";

export type MergeSummary =
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "account-config-v1"; mergedFields: number }
  | { version: "rollup-rows-v1"; mergedRows: number };

export interface UpdateConflict {
  path: string;
  reason:
    | "path-kind-conflict"
    | "nested-boundary-conflict"
    | "page-id-move-conflict"
    | "binary-conflict"
    | "rollup-row-conflict"
    | "rollup-schema-conflict"
    | "rollup-constraint-conflict"
    | "frontmatter-conflict"
    | "invalid-markdown-fence"
    | "account-configuration";
}

export interface ServerDevice {
  id: string;
  account: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface PairingOffer {
  id: string;
  secret: string;
  confirmationCode: string;
  expiresAt: number;
}

export interface AcceptedUpdate {
  id: string;
  tree: string;
  sequence: number;
  root: ObjectHash;
  previousRoot: ObjectHash | null;
  kind: "initial" | "accepted" | "merged" | "restored";
  acceptedAt: number;
  subject: string | null;
  merge?: MergeSummary;
}

export type ObjectDeltaInstruction =
  | { copy: { offset: number; length: number } }
  | { insert: Uint8Array };

/**
 * Sparse representation of one canonical object against a base object that is
 * reachable in the relevant basis graph. Instructions address the base's exact
 * canonical CBOR bytes, so files and directories use the same rule.
 */
export interface ObjectDelta {
  base: ObjectHash;
  result: ObjectHash;
  instructions: ObjectDeltaInstruction[];
}

export interface AcceptedTransitionPayload {
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
  deltas?: ObjectDelta[];
}

export interface AcceptedTransition extends AcceptedTransitionPayload {
  update: AcceptedUpdate;
  requestDigest?: ObjectHash;
}

export interface UpdateRequest {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
  deltas?: ObjectDelta[];
  /** Transport hint only; excluded from the updates-v1 semantic request digest. */
  returnSnapshot?: true | "if-result-differs";
}

export type UpdateResult =
  | { outcome: "current"; current: AcceptedUpdate; requestDigest: ObjectHash; observedThrough: string; snapshot?: TreeSnapshot }
  | { outcome: "accepted"; update: AcceptedUpdate; requestDigest: ObjectHash; observedThrough: string; snapshot?: TreeSnapshot }
  | { outcome: "merged"; update: AcceptedUpdate; merge: MergeSummary; requestDigest: ObjectHash; observedThrough: string; snapshot?: TreeSnapshot };

export interface UpdateConflictResult {
  error: "conflict";
  message: string;
  retryable: false;
  tree?: string;
  details: {
    kind: "server-update" | "account-configuration";
    current: AcceptedUpdate;
    base: ObjectHash;
    candidate: ObjectHash;
    draft: TreeSnapshot;
    /** Present when the caller requested a complete accepted snapshot. */
    currentSnapshot?: TreeSnapshot;
    conflicts: UpdateConflict[];
  };
}
