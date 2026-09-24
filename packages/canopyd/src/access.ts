import { rulesAllow, parseResourceRules, safeResourceRule, ruleMatches, type AccessOperation, generateArborID, type ReadWriteAccess } from "@overstory/protocol";

type ResourceRules = ReturnType<typeof parseResourceRules>;
/** Parsed rules by their exact stored JSON: a policy row changes by replacement, so no entry is ever stale. */
const PARSED_RULES_LIMIT = 256;
import type { ExecutionContext, ExecutionGrant } from "./execution-authority.ts";
import type { Database } from "bun:sqlite";
import type { CanopyAccessEntry, CanopyAccount, CanopyTree } from "./model.ts";

export interface AccessHost {
  tree(id: string): CanopyTree | null;
  /**
   * Whether a group profile tree lists this person: by Profile TreeID, or by
   * handle for a legacy scalar `/~handle` member locator.
   */
  isProfileMember(groupTree: string, profileTree: string, handle: string | undefined): boolean;
  /** The tree root's frontmatter `type`, or null when the root declares neither profile kind. */
  rootProfileType(treeID: string): "person" | "group" | null;
}

/** Tree access rules and the read/write/administer decisions derived from them. */
export class AccessControl {
  private readonly parsedRules = new Map<string, ResourceRules>();

  constructor(private readonly db: Database, private readonly host: AccessHost) {}

  /** The account's governed rules for a tree, parsed once per distinct policy text. */
  private rules(account: string, tree: string): ResourceRules | undefined {
    const row = this.db.query("SELECT rules_json FROM resource_policy WHERE account_id = ? AND tree_id = ?").get(account, tree) as { rules_json: string } | null;
    if (!row) return undefined;
    let rules = this.parsedRules.get(row.rules_json);
    if (!rules) {
      rules = parseResourceRules(JSON.parse(row.rules_json));
      if (this.parsedRules.size >= PARSED_RULES_LIMIT) this.parsedRules.delete(this.parsedRules.keys().next().value!);
      this.parsedRules.set(row.rules_json, rules);
    }
    return rules;
  }

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

  safePolicy(account: string, tree: string) {
    return this.rules(account, tree)?.map(safeResourceRule);
  }

  private profile(account: string): string | null {
    return (this.db.query("SELECT profile_tree FROM accounts WHERE id = ? AND enabled = 1").get(account) as { profile_tree: string } | null)?.profile_tree ?? null;
  }

  private policyAllows(policyAccount: string, caller: string | null, tree: string, path: string, operation: AccessOperation, via?: string, linkDigest?: string): boolean {
    if (!policyAccount) return false;
    const ownerProfile = this.profile(policyAccount);
    if (!ownerProfile) return false;
    const rules = this.rules(policyAccount, tree);
    if (!rules) return false;
    return rulesAllow(rules, {
      ownerProfile, callerProfile: caller, via, linkDigest,
      isGroupMember: (group, profile) => {
        if (this.host.rootProfileType(group) !== "group") return false;
        const member = this.db.query("SELECT handle FROM accounts WHERE profile_tree = ? AND enabled = 1").get(profile) as { handle: string } | null;
        return !!member && this.host.isProfileMember(group, profile, member.handle);
      },
    }, path, operation);
  }

  directExecution(account: CanopyAccount | null, treeID: string, subject: string, active: () => boolean, linkDigest?: string): ExecutionContext | undefined {
    const tree = this.host.tree(treeID);
    if (!tree?.accountID || tree.policy !== "ordinary") return undefined;
    const policy = this.rules(tree.accountID, treeID);
    const ownerProfile = this.profile(tree.accountID);
    if (!policy || !ownerProfile) return undefined;
    const rules = policy.filter(rule => !rule.via && ruleMatches(rule, {
      ownerProfile, callerProfile: account?.profileTree ?? null, linkDigest,
      isGroupMember: (group, profile) => this.host.rootProfileType(group) === "group" && profile === account?.profileTree && this.host.isProfileMember(group, profile, account.handle),
    }));
    return { code: "", version: "direct", caller: account?.id ?? null, sponsor: tree.accountID, subject, linkDigest,
      expiresAt: Date.now() + 60000, active,
      grants: rules.map(rule => ({ account: tree.accountID!, role: "author" as const, tree: treeID, within: rule.within ?? "/", allow: rule.allow })),
    };
  }

  /** Grant provenance and underlying authority are re-evaluated on every use. */
  executionAllows(context: ExecutionContext, grant: ExecutionGrant, path: string, operation: AccessOperation): boolean {
    const tree = this.host.tree(grant.tree);
    if (!tree || tree.policy !== "ordinary") return false;
    const callerProfile = context.caller ? this.profile(context.caller) : null;
    if (context.caller && !callerProfile) return false;
    const grantor = this.db.query("SELECT * FROM accounts WHERE id = ? AND enabled = 1").get(grant.account) as any;
    if (!grantor) return false;
    const owner = tree.accountID;
    const underlying = grant.account === owner || this.policyAllows(owner ?? "", this.profile(grant.account), tree.id, path, operation)
      || (operation === "read" ? this.canRead({ id: grant.account, profileTree: grantor.profile_tree, handle: grantor.handle } as CanopyAccount, tree.id)
          : this.canWrite({ id: grant.account, profileTree: grantor.profile_tree, handle: grantor.handle } as CanopyAccount, tree.id));
    if (!underlying) return false;
    // A caller can use ordinary permissions through code without a new grant.
    if (grant.role === "user" && grant.account === context.caller) return true;
    const callerRow = context.caller ? this.db.query("SELECT * FROM accounts WHERE id = ? AND enabled = 1").get(context.caller) as any : null;
    const callerAccount = callerRow ? { id: callerRow.id, profileTree: callerRow.profile_tree, handle: callerRow.handle } as CanopyAccount : null;
    const ordinaryCaller = operation === "read" ? this.canRead(callerAccount, tree.id, context.linkDigest) : this.canWrite(callerAccount, tree.id, context.linkDigest);
    return ordinaryCaller || this.policyAllows(owner ?? "", callerProfile, tree.id, path, operation, context.code || undefined, context.linkDigest)
      || this.policyAllows(grant.account, callerProfile, tree.id, path, operation, context.code || undefined, context.linkDigest);
  }

  canRead(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.host.tree(treeID);
    if (!tree) return false;
    if (tree.policy.startsWith("account-config-")) return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (this.policyAllows(tree.accountID ?? "", account?.profileTree ?? null, treeID, "/", "read", undefined, linkDigest)) return true;
    if (tree.publicAccess === "read" || tree.publicAccess === "write") return true;
    if (linkDigest && this.subjectAccess("link", linkDigest, treeID) !== "none") return true;
    return account ? this.effectiveAccess(account, treeID) !== "none" : false;
  }

  canWrite(account: CanopyAccount | null, treeID: string, linkDigest?: string): boolean {
    const tree = this.host.tree(treeID);
    if (!tree) return false;
    if (tree.policy.startsWith("account-config-")) return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (this.policyAllows(tree.accountID ?? "", account?.profileTree ?? null, treeID, "/", "write", undefined, linkDigest)) return true;
    if (linkDigest && this.subjectAccess("link", linkDigest, treeID) === "write") return true;
    if (!account) return tree.publicAccess === "write";
    return this.effectiveAccess(account, treeID) === "write" || tree.publicAccess === "write";
  }

  canAdminister(account: CanopyAccount, treeID: string): boolean {
    const tree = this.host.tree(treeID);
    if (!tree || !account.profileTree) return false;
    if (tree.policy.startsWith("account-config-")) return tree.accountID === account.id;
    if (tree.accountID === account.id) return true;
    if (tree.id === account.profileTree) return true;
    if (tree.accountID && this.db.query("SELECT 1 FROM resource_policy WHERE account_id=? AND tree_id=?").get(tree.accountID, treeID)) return false;
    return this.subjectAccess("profile", account.profileTree, treeID) === "write";
  }

  private subjectAccess(kind: "link" | "profile", subject: string, treeID: string): ReadWriteAccess | "none" {
    const row = this.db.query(
      "SELECT access FROM access WHERE tree_id = ? AND subject_kind = ? AND subject = ?",
    ).get(treeID, kind, subject) as { access: ReadWriteAccess } | null;
    return row?.access ?? "none";
  }

  /**
   * Direct profile access, else the strongest access granted through group
   * membership. Only a subject whose root declares `type: group` expands: a
   * person profile that merely lists `members` must not widen access.
   */
  private effectiveAccess(account: CanopyAccount, treeID: string): ReadWriteAccess | "none" {
    if (!account.profileTree) return "none";
    const direct = this.subjectAccess("profile", account.profileTree, treeID);
    if (direct === "write") return direct;
    let result: ReadWriteAccess | "none" = direct;
    for (const entry of this.entries(treeID)) {
      if (entry.subjectKind !== "profile") continue;
      if (this.host.rootProfileType(entry.subject) !== "group") continue;
      if (this.host.isProfileMember(entry.subject, account.profileTree, account.handle)) {
        if (entry.access === "write") return "write";
        result = "read";
      }
    }
    return result;
  }
}
