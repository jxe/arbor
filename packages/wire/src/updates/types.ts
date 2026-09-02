import type { ObjectHash } from "../objects.ts";

export type MergeSummary =
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "account-config-v1"; mergedFields: number }
  | { version: "rollup-rows-v1"; mergedRows: number };

export type IfMatch = "bytesHash" | "modelHash";
export type OnConflict = "reject" | "merge";

export interface UpdateConflict {
  path: string;
  reason:
    | "node-conflict"
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

/**
 * One accepted tree state. `id` is the decimal observation ordinal that
 * recorded it, so it is also the update's `tree.ref` watch cursor and orders
 * accepted updates within their tree.
 */
export interface AcceptedUpdate {
  id: string;
  tree: string;
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

/**
 * The one payload shape for a transition between two roots: complete objects
 * plus deltas against objects reachable from the starting root. A request
 * proposes a transition, a result carries one back, and watch delivers them.
 */
export interface TransitionPayload {
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
  deltas?: ObjectDelta[];
}

export type AcceptedTransitionPayload = TransitionPayload;

export interface AcceptedTransition extends TransitionPayload {
  update: AcceptedUpdate;
  requestDigest?: ObjectHash;
}

export interface UpdateRequest extends TransitionPayload {
  /** The accepted update the candidate was derived from, or null to activate a reserved tree. */
  base: string | null;
  candidate: ObjectHash;
  /** Which hash must still match its value at base for the candidate to be accepted. */
  ifMatch: IfMatch;
  /** Under `modelHash`, what to do with a node changed in both places; defaults to `merge`. */
  onConflict?: OnConflict;
}

/**
 * The authority's answer to a candidate. `update` is the accepted update that
 * now stands: the untouched current one for `current`, or the newly accepted
 * or merged one; `merge` on it is present only when a merge rule ran.
 * `reconciliation` is the transition from the candidate root to `update.root`
 * and is present whenever the two differ.
 */
export interface UpdateResult {
  outcome: "current" | "accepted" | "merged";
  update: AcceptedUpdate;
  requestDigest: ObjectHash;
  observedThrough: string;
  reconciliation?: TransitionPayload;
}

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
    /** The transition from the candidate root to the draft root the client keeps. */
    draft: TransitionPayload & { root: ObjectHash };
    conflicts: UpdateConflict[];
  };
}
