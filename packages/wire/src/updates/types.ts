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

export interface UpdateRequest {
  base: { root: ObjectHash; update: string };
  candidate: ObjectHash;
  objects: Array<{ hash: ObjectHash; bytes: Uint8Array }>;
}

export type UpdateResult =
  | { outcome: "current"; current: AcceptedUpdate }
  | { outcome: "accepted"; update: AcceptedUpdate }
  | { outcome: "merged"; update: AcceptedUpdate; merge: MergeSummary };

export interface UpdateConflictResult {
  error: "conflict";
  message: string;
  retryable: false;
  current: AcceptedUpdate;
  base: ObjectHash;
  candidate: ObjectHash;
  draft: { root: ObjectHash; objects: Array<{ hash: ObjectHash; bytes: Uint8Array }> };
  conflicts: UpdateConflict[];
}
