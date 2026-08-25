import type { ObjectHash } from "../objects.ts";

export type PublicAccess = "none" | "read" | "write";
export type TreeAccess = "read" | "write";
export type BoundaryKind =
  | "community-profile"
  | "person-profile"
  | "group-profile"
  | "shared-subtree";

export interface MergeSummary {
  version: "markdown-additive-v1";
  approximatePlacements: number;
}

export interface UpdateConflict {
  path: string;
  reason:
    | "path-kind-conflict"
    | "nested-boundary-conflict"
    | "page-id-move-conflict"
    | "binary-conflict"
    | "frontmatter-conflict"
    | "invalid-markdown-fence";
}

export interface AuthorityDevice {
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

export interface UpdateRequest {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
  filePatches?: FilePatch[];
  /** Transport hint only; excluded from the updates-v1 semantic request digest. */
  returnSnapshot?: true | "if-result-differs";
}

export type UpdateResult =
  | { outcome: "current"; current: AcceptedUpdate; requestDigest: ObjectHash; snapshot?: TreeSnapshotEnvelope }
  | { outcome: "accepted"; update: AcceptedUpdate; requestDigest: ObjectHash; snapshot?: TreeSnapshotEnvelope }
  | { outcome: "merged"; update: AcceptedUpdate; merge: MergeSummary; requestDigest: ObjectHash; snapshot?: TreeSnapshotEnvelope };

export interface TreeSnapshotEnvelope {
  root: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
}

export interface UpdateConflictResult {
  error: "conflict";
  message: string;
  retryable: false;
  current: AcceptedUpdate;
  base: ObjectHash;
  candidate: ObjectHash;
  draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
  /** Present when the caller requested a complete accepted snapshot. */
  currentSnapshot?: TreeSnapshotEnvelope;
  conflicts: UpdateConflict[];
}
