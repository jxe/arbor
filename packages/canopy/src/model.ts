import type { AccessLevel, ReadWriteAccess, TreeKind } from "@arbor/core";
import type { ObjectHash } from "@arbor/wire";

export interface CanonicalBoundary {
  path: string;
  tree: string;
  parentTree: string | null;
}

export interface CanopyTree {
  id: string;
  canonicalPath: string | null;
  parentTree: string | null;
  kind: TreeKind;
  ref: ObjectHash;
  publicAccess: AccessLevel;
  updatedAt: number;
  policy: "ordinary" | "account-config-v1" | "account-config-v2";
  status: "active" | "awaiting-initialization" | "error";
  accountID: string | null;
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
