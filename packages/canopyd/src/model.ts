import type { TreeKind } from "@overstory/protocol";
import type { ObjectHash } from "@overstory/protocol";

export interface HostTree {
  id: string;
  canonicalPath: string | null;
  parentTree: string | null;
  kind: TreeKind;
  ref: ObjectHash;
  policy: "ordinary" | "tree-config-v1";
  /** Retired trees retain immutable update history but have no canonical boundary or access. */
  status: "active" | "retired";
  /** For a tree configuration, the TreeID of the tree it configures. */
  governs: string | null;
}

/** Whether a tree holds another tree's configuration rather than ordinary content. */
export function isTreeConfigPolicy(policy: HostTree["policy"]): boolean {
  return policy === "tree-config-v1";
}

/**
 * A host account: this profile is claimed here, with this handle. Its identity
 * is the pair of host and profile, so `id` is the profile TreeID.
 */
export interface HostAccount {
  id: string;
  handle: string;
  profileTree: string;
  enabled: boolean;
}

export interface HostAuthentication {
  account: HostAccount;
  subject: string;
  device: string | null;
  /** When a device session authenticated the request, the session's expiry. */
  expiresAt?: number;
}

export interface HostAccessEntry {
  id: string;
  tree: string;
  subjectKind: "everyone" | "profile" | "link";
  subject: string;
  access: "read" | "write";
}
