import type { AccessLevel, ReadWriteAccess, TreeKind } from "@overstory/protocol";
import type { ObjectHash } from "@overstory/protocol";

export interface CanopyTree {
  id: string;
  canonicalPath: string | null;
  parentTree: string | null;
  kind: TreeKind;
  ref: ObjectHash;
  publicAccess: AccessLevel;
  updatedAt: number;
  policy: "ordinary" | "account-config-v2";
  /** Retired trees retain immutable update history but have no canonical boundary or access. */
  status: "active" | "awaiting-initialization" | "error" | "retired";
  accountID: string | null;
}

/** Whether a tree holds an account's configuration rather than ordinary content. */
export function isAccountConfigPolicy(policy: CanopyTree["policy"]): boolean {
  return policy === "account-config-v2";
}

export interface CanopyAccount {
  id: string;
  handle: string;
  profileTree: string | null;
  configTree: string | null;
  enabled: boolean;
}

export interface CanopyAuthentication {
  account: CanopyAccount;
  subject: string;
  device: string | null;
}

export interface CanopyAccessEntry {
  id: string;
  tree: string;
  subjectKind: "everyone" | "profile" | "link";
  subject: string;
  access: ReadWriteAccess;
  claimedProfile?: string;
}
