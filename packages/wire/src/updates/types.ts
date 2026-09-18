import type { AuthoredUpdateIntent } from "./authored-contract.ts";
import type { ObjectHash } from "../objects.ts";

export interface UpdateConflict {
  path: string;
  reason:
    | "node-conflict"
    | "path-kind-conflict"
    | "nested-boundary-conflict"
    | "page-id-move-conflict"
    | "binary-conflict"
    | "collection-file-row-conflict"
    | "collection-file-schema-conflict"
    | "collection-file-constraint-conflict"
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

export type { PairingOffer } from "@arbor/core";

/** Accepted identities and observation cursors occupy independent domains. */
export interface AcceptedUpdate {
  id: string;
  tree: string;
  root: ObjectHash;
  previous: { id: string; root: ObjectHash } | null;
  acceptedAt: number;
  subject: string | null;
  conflicted: boolean;
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
  deltas: ObjectDelta[];
}

export type AcceptedTransitionPayload = TransitionPayload;

export interface AcceptedTransition extends TransitionPayload {
  from?: { id: string; root: ObjectHash };
  update: AcceptedUpdate;
  requestDigest?: ObjectHash;
}

export interface CandidateUpdate extends TransitionPayload, AuthoredUpdateIntent {}

export interface UpdateRequest {
  /** The accepted update from which this append-only string begins, or null to activate a reserved tree. */
  base: string | null;
  /** A nonempty ordered string; every later candidate derives from the preceding submitted candidate. */
  updates: CandidateUpdate[];
}

/** Historical acceptance receipt; observation progress is carried separately.
 * Reconciliation transforms the authored candidate into the returned projection.
 */
export interface UpdateResult {
  outcome: "unchanged" | "accepted";
  update: AcceptedUpdate;
  requestDigest: ObjectHash;
  reconciliation?: TransitionPayload;
}

export interface UpdateResponse {
  results: UpdateResult[];
  observedThrough: string;
}

export interface UpdateConflictResult {
  error: "conflict";
  message: string;
  retryable: false;
  tree?: string;
  details: {
    kind: "server-update" | "account-configuration";
    completed: UpdateResult[];
    failedIndex: number;
    current: AcceptedUpdate;
    base: ObjectHash;
    candidate: ObjectHash;
    /** The transition from the candidate root to the draft root the client keeps. */
    draft: TransitionPayload & { root: ObjectHash };
    conflicts: UpdateConflict[];
  };
}
