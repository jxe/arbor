import { rulesAllow, parseResourceRules, safeResourceRule, ruleMatches, sha256, type AccessOperation, type AccessRule, generateArborID, type ReadWriteAccess } from "@overstory/protocol";
import type { ExecutionContext, ExecutionGrant } from "./execution-authority.ts";
import type { Database } from "bun:sqlite";
import { AccountDirectory } from "./accounts.ts";
import { isAccountConfigPolicy, type CanopyAccessEntry, type CanopyAccount, type CanopyTree } from "./model.ts";

type ResourceRules = ReturnType<typeof parseResourceRules>;
/** Parsed rules by their exact stored JSON: a policy row changes by replacement, so no entry is ever stale. */
const PARSED_RULES_LIMIT = 256;

export interface AccessHost {
  tree(id: string): CanopyTree | null;
  /**
   * Whether a group profile tree's current root lists this person: by Profile
   * TreeID, or by handle for a legacy scalar `/~handle` member locator.
   */
  isProfileMember(group: CanopyTree, profileTree: string, handle: string | undefined): boolean;
  /** The tree's current root frontmatter `type`, or null when it declares neither profile kind. */
  rootProfileType(tree: CanopyTree): "person" | "group" | null;
}

/** A stored access entry as the configuration rule that declares it. */
export function accessRule(entry: CanopyAccessEntry): AccessRule {
  return {
    subject: entry.subjectKind === "everyone" ? { kind: "everyone" }
      : entry.subjectKind === "profile" ? { kind: "profile", tree: entry.subject }
        : { kind: "link", digest: entry.subject as `sha256:${string}` },
    access: entry.access,
  };
}

/**
 * Tree access rules and the read/write/administer decisions derived from them.
 * A tree an account owns (`trees.account_id`) is governed by that account's
 * resource rules alone (`resource_policy`, from its `trees.yaml`). The
 * `access` table holds the rules of a tree no account owns: trees created at
 * bootstrap, and the community root until an account hosts it.
 */
export class AccessControl {
  private readonly parsedRules = new Map<string, ResourceRules>();
  private readonly accounts: AccountDirectory;

  constructor(private readonly db: Database, private readonly host: AccessHost) {
    this.accounts = new AccountDirectory(db);
  }

  /** Rules parsed once per distinct policy text. */
  private parse(rulesJSON: string): ResourceRules {
    let rules = this.parsedRules.get(rulesJSON);
    if (!rules) {
      rules = parseResourceRules(JSON.parse(rulesJSON));
      if (this.parsedRules.size >= PARSED_RULES_LIMIT) this.parsedRules.delete(this.parsedRules.keys().next().value!);
      this.parsedRules.set(rulesJSON, rules);
    }
    return rules;
  }

  /** The account's governed rules for a tree. */
  private rules(account: string, tree: string): ResourceRules | undefined {
    const row = this.db.query("SELECT rules_json FROM resource_policy WHERE account_id = ? AND tree_id = ?").get(account, tree) as { rules_json: string } | null;
    return row ? this.parse(row.rules_json) : undefined;
  }

  /** An account's rules for a tree and the Profile TreeID its `who: me`
   * rules name, in one read; undefined when either is missing. An owner the
   * community disabled can no longer sign in, but the rules it accepted keep
   * governing its trees, as they did before it was disabled. */
  private policy(account: string, tree: string): { rules: ResourceRules; ownerProfile: string } | undefined {
    const row = this.db.query(`
      SELECT p.rules_json, a.profile_tree FROM resource_policy p JOIN accounts a ON a.id = p.account_id
      WHERE p.account_id = ? AND p.tree_id = ?
    `).get(account, tree) as { rules_json: string; profile_tree: string | null } | null;
    return row?.profile_tree ? { rules: this.parse(row.rules_json), ownerProfile: row.profile_tree } : undefined;
  }

  /** A tree's whole-tree rules as access entries: an owned tree's from its
   * owner's resource rules (rules scoped below the root, through code, or for
   * the owner alone have no entry), an unowned tree's as stored. */
  entries(tree: string): CanopyAccessEntry[] {
    const owner = this.host.tree(tree)?.accountID;
    if (owner) return (this.rules(owner, tree) ?? []).flatMap((rule): CanopyAccessEntry[] => {
      if (rule.via || (rule.within ?? "/") !== "/" || rule.who === "me") return [];
      const access = rule.allow.includes("write") ? "write" : rule.allow.includes("read") ? "read" : null;
      if (!access) return [];
      const [subjectKind, subject]: [CanopyAccessEntry["subjectKind"], string] = rule.who === "everyone" ? ["everyone", "everyone"]
        : "profile" in rule.who ? ["profile", rule.who.profile] : ["link", rule.who.link];
      // A stable id per tree and subject, as a stored entry's would be.
      return [{ id: `ax_${sha256(`${tree}\n${subjectKind}\n${subject}`).slice(0, 26)}`, tree, subjectKind, subject, access }];
    });
    return this.storedEntries(tree);
  }

  /** The stored `access` rows of a tree no account owns. */
  private storedEntries(tree: string): CanopyAccessEntry[] {
    return this.db.query("SELECT id, tree_id, subject_kind, subject, access FROM access WHERE tree_id = ? ORDER BY subject_kind, subject")
      .all(tree)
      .map((row) => {
        const value = row as {
          id: string;
          tree_id: string;
          subject_kind: CanopyAccessEntry["subjectKind"];
          subject: string;
          access: ReadWriteAccess;
        };
        return {
          id: value.id,
          tree: value.tree_id,
          subjectKind: value.subject_kind,
          subject: value.subject,
          access: value.access,
        };
      });
  }

  /** Insert or update one rule of a tree no account owns; callers run this inside their own transaction. */
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

  /** The tree `id` names, when its current root declares `type: group`. */
  private groupTree(id: string): CanopyTree | null {
    const group = this.host.tree(id);
    return group && this.host.rootProfileType(group) === "group" ? group : null;
  }

  private policyAllows(policyAccount: string, caller: string | null, tree: string, path: string, operation: AccessOperation, via?: string, linkDigest?: string): boolean {
    if (!policyAccount) return false;
    const policy = this.policy(policyAccount, tree);
    if (!policy) return false;
    return rulesAllow(policy.rules, {
      ownerProfile: policy.ownerProfile, callerProfile: caller, via, linkDigest,
      isGroupMember: (groupID, profile) => {
        const group = this.groupTree(groupID);
        if (!group) return false;
        // Only a profile an enabled account holds counts as a member.
        const handle = this.accounts.handleForProfile(profile);
        return handle !== undefined && this.host.isProfileMember(group, profile, handle);
      },
    }, path, operation);
  }

  directExecution(account: CanopyAccount | null, treeID: string, subject: string, active: () => boolean, linkDigest?: string): ExecutionContext | undefined {
    const tree = this.host.tree(treeID);
    if (!tree?.accountID || tree.policy !== "ordinary") return undefined;
    const policy = this.policy(tree.accountID, treeID);
    if (!policy) return undefined;
    const rules = policy.rules.filter(rule => !rule.via && ruleMatches(rule, {
      ownerProfile: policy.ownerProfile, callerProfile: account?.profileTree ?? null, linkDigest,
      isGroupMember: (groupID, profile) => {
        if (profile !== account?.profileTree) return false;
        const group = this.groupTree(groupID);
        return !!group && this.host.isProfileMember(group, profile, account.handle);
      },
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
    const caller = context.caller ? this.accounts.enabledAccount(context.caller) : null;
    if (context.caller && !caller?.profileTree) return false;
    const callerProfile = caller?.profileTree ?? null;
    const grantor = this.accounts.enabledAccount(grant.account);
    if (!grantor) return false;
    const owner = tree.accountID;
    const underlying = grant.account === owner || this.policyAllows(owner ?? "", grantor.profileTree, tree.id, path, operation)
      || (operation === "read" ? this.canRead(grantor, tree) : this.canWrite(grantor, tree));
    if (!underlying) return false;
    // A caller can use ordinary permissions through code without a new grant.
    if (grant.role === "user" && grant.account === context.caller) return true;
    const ordinaryCaller = operation === "read" ? this.canRead(caller, tree, context.linkDigest) : this.canWrite(caller, tree, context.linkDigest);
    return ordinaryCaller || this.policyAllows(owner ?? "", callerProfile, tree.id, path, operation, context.code || undefined, context.linkDigest)
      || this.policyAllows(grant.account, callerProfile, tree.id, path, operation, context.code || undefined, context.linkDigest);
  }

  /** `treeOrID` is an ID, or a tree the caller already read, which saves reading it again. */
  canRead(account: CanopyAccount | null, treeOrID: string | CanopyTree, linkDigest?: string): boolean {
    const tree = typeof treeOrID === "string" ? this.host.tree(treeOrID) : treeOrID;
    if (!tree) return false;
    const treeID = tree.id;
    if (isAccountConfigPolicy(tree.policy)) return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (tree.accountID) return this.policyAllows(tree.accountID, account?.profileTree ?? null, treeID, "/", "read", undefined, linkDigest);
    if (tree.publicAccess === "read" || tree.publicAccess === "write") return true;
    if (linkDigest && this.subjectAccess("link", linkDigest, treeID) !== "none") return true;
    return account ? this.effectiveAccess(account, treeID) !== "none" : false;
  }

  canWrite(account: CanopyAccount | null, treeOrID: string | CanopyTree, linkDigest?: string): boolean {
    const tree = typeof treeOrID === "string" ? this.host.tree(treeOrID) : treeOrID;
    if (!tree) return false;
    const treeID = tree.id;
    if (isAccountConfigPolicy(tree.policy)) return account?.id === tree.accountID;
    if (account && tree.accountID === account.id) return true;
    if (tree.accountID) return this.policyAllows(tree.accountID, account?.profileTree ?? null, treeID, "/", "write", undefined, linkDigest);
    if (linkDigest && this.subjectAccess("link", linkDigest, treeID) === "write") return true;
    if (!account) return tree.publicAccess === "write";
    return this.effectiveAccess(account, treeID) === "write" || tree.publicAccess === "write";
  }

  canAdminister(account: CanopyAccount, treeOrID: string | CanopyTree): boolean {
    const tree = typeof treeOrID === "string" ? this.host.tree(treeOrID) : treeOrID;
    if (!tree || !account.profileTree) return false;
    if (isAccountConfigPolicy(tree.policy) || tree.accountID) return tree.accountID === account.id;
    if (tree.id === account.profileTree) return true;
    return this.subjectAccess("profile", account.profileTree, tree.id) === "write";
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
    // Reached only for a tree no account owns, whose rules are its stored entries.
    for (const entry of this.storedEntries(treeID)) {
      if (entry.subjectKind !== "profile") continue;
      const group = this.groupTree(entry.subject);
      if (group && this.host.isProfileMember(group, account.profileTree, account.handle)) {
        if (entry.access === "write") return "write";
        result = "read";
      }
    }
    return result;
  }
}
