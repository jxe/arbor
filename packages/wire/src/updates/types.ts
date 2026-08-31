import type { ObjectHash } from "../objects.ts";
import type { AccessLevel, ReadWriteAccess, TreeKind } from "@arbor/core";

/** @deprecated Use AccessRule with an everyone subject. */
export type PublicAccess = AccessLevel;
export type TreeAccess = ReadWriteAccess;
export type BoundaryKind = TreeKind;

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
  baseRoot?: ObjectHash;
  candidateRoot?: ObjectHash;
  remoteRoot?: ObjectHash;
  merge?: MergeSummary;
}

export interface FilePatchEdit {
  offset: number;
  length: number;
  bytes: Uint8Array;
}

export interface FilePatch {
  base: ObjectHash;
  result: ObjectHash;
  edits: FilePatchEdit[];
}

export type FileDeltaInstruction =
  | { copy: { offset: number; length: number } }
  | { insert: Uint8Array };

export interface FileDelta {
  base: ObjectHash;
  result: ObjectHash;
  instructions: FileDeltaInstruction[];
}

export interface AcceptedTransitionPayload {
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
  filePatches?: FilePatch[];
  fileDeltas?: FileDelta[];
}

export interface AcceptedTransition extends AcceptedTransitionPayload {
  update: AcceptedUpdate;
  requestDigest?: ObjectHash;
}

export interface UpdateRequest {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
  filePatches?: FilePatch[];
  /** Transport hint only; excluded from the updates-v1 semantic request digest. */
  returnSnapshot?: true | "if-result-differs";
}

export type UpdateResult =
  | { outcome: "current"; current: AcceptedUpdate; requestDigest: ObjectHash; observedThrough: string; snapshot?: TreeSnapshotEnvelope }
  | { outcome: "accepted"; update: AcceptedUpdate; requestDigest: ObjectHash; observedThrough: string; snapshot?: TreeSnapshotEnvelope }
  | { outcome: "merged"; update: AcceptedUpdate; merge: MergeSummary; requestDigest: ObjectHash; observedThrough: string; snapshot?: TreeSnapshotEnvelope };

export interface TreeSnapshotEnvelope {
  root: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
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
    draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
    /** Present when the caller requested a complete accepted snapshot. */
    currentSnapshot?: TreeSnapshotEnvelope;
    conflicts: UpdateConflict[];
  };
}
