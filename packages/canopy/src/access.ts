import type { Database } from "bun:sqlite";
import { generateArborID, type ReadWriteAccess } from "@arbor/core";
import type { CanopyAccessEntry, CanopyAccount, CanopyTree } from "./model.ts";

export interface AccessHost {
  tree(id: string): CanopyTree | null;
  /** Handles of every member of a group profile tree. */
  profileMemberHandles(treeID: string): Set<string>;
}

/** Tree access rules and the read/write/administer decisions derived from them. */
export class AccessControl {
  constructor(private readonly db: Database, private readonly host: AccessHost) {}

  entries(tree: string): CanopyAccessEntry[] {
    return this.db.query("SELECT * FROM access WHERE tree_id = ? ORDER BY subject_kind, subject")
      .all(tree)
      .map((row) => {
        const value = row as {
          id: string;
          tree_id: string;
          subject_kind: CanopyAccessEntry["subjectKind"];
          subject: string;
          access: ReadWriteAccess;
          claimed_profile: string | null;
        };
        return {
          id: value.id,
          tree: value.tree_id,
          subjectKind: value.subject_kind,
          subject: value.subject,
          access: value.access,
          ...(value.claimed_profile ? { claimedProfile: value.claimed_profile } : {}),
        };
      });
  }

  /** Insert or update one rule; callers run this inside their own transaction. */
  set(treeID: string, subjectKind: CanopyAccessEntry["subjectKind"], subject: string, access: ReadWriteAccess): void {
    const existing = this.db.query(
      "SELECT id FROM access WHERE tree_id = ? AND subject_kind = ? AND subject = ?",
    ).get(treeID, subjectKind, subject) as { id: string } | null;
    if (existing) {
      this.db.run("UPDATE access SET access = ? WHERE id = ?", [access, existing.id]);
    } else {
      this.db.run(
        "INSERT INTO access (id, tree_id, subject_kind, subject, access) VALUES (?, ?, ?, ?, ?)",
        [generateArborID("ax"), treeID, subjectKind, subject, access],
      );
    }
  }

  canRead(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.host.tree(treeID);
    if (!tree) return false;
    if (tree.policy === "account-config-v1") return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (tree.publicAccess === "read" || tree.publicAccess === "write") return true;
    if (linkDigest && this.subjectAccess("link", linkDigest, treeID) !== "none") return true;
    return account ? this.effectiveAccess(account, treeID) !== "none" : false;
  }

  canWrite(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.host.tree(treeID);
    if (!tree) return false;
    if (tree.policy === "account-config-v1") return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (linkDigest && this.subjectAccess("link", linkDigest, treeID) === "write") return true;
    if (!account) return tree.publicAccess === "write";
    return this.effectiveAccess(account, treeID) === "write" || tree.publicAccess === "write";
  }

  canAdminister(account: CanopyAccount, treeID: string): boolean {
    const tree = this.host.tree(treeID);
    if (!tree || !account.profileTree) return false;
    if (tree.policy === "account-config-v1") return tree.accountID === account.id;
    if (tree.accountID === account.id) return true;
    if (tree.kind === "person-profile" && tree.id === account.profileTree) return true;
    return this.subjectAccess("profile", account.profileTree, treeID) === "write";
  }

  private subjectAccess(kind: "link" | "profile", subject: string, treeID: string): ReadWriteAccess | "none" {
    const row = this.db.query(
      "SELECT access FROM access WHERE tree_id = ? AND subject_kind = ? AND subject = ?",
    ).get(treeID, kind, subject) as { access: ReadWriteAccess } | null;
    return row?.access ?? "none";
  }

  /** Direct profile access, else the strongest access granted through group membership. */
  private effectiveAccess(account: CanopyAccount, treeID: string): ReadWriteAccess | "none" {
    if (!account.profileTree) return "none";
    const direct = this.subjectAccess("profile", account.profileTree, treeID);
    if (direct !== "none") return direct;
    let result: ReadWriteAccess | "none" = "none";
    for (const entry of this.entries(treeID)) {
      if (entry.subjectKind !== "profile") continue;
      const subject = this.host.tree(entry.subject);
      if (subject?.kind !== "group-profile") continue;
      if (this.host.profileMemberHandles(subject.id).has(account.handle)) {
        if (entry.access === "write") return "write";
        result = "read";
      }
    }
    return result;
  }
}
