import {
  operationAllowed,
  parseResourceRules,
  ruleMatches,
  rulesAllow,
  safeResourceRule,
  scopeContains,
  sha256,
  subjectProfile,
  type AccessOperation,
  type AppAccessRule,
  type ResourceAccessRule,
  type TreeOperation,
} from "@overstory/protocol";
import type { ExecutionContext, ExecutionGrant } from "./execution-authority.ts";
import type { Database } from "bun:sqlite";
import { AccountDirectory } from "./accounts.ts";
import { isTreeConfigPolicy, type HostAccessEntry, type HostAccount, type HostTree } from "./model.ts";

/** Parsed rules by their exact stored JSON: a policy row changes by replacement, so no entry is ever stale. */
const PARSED_RULES_LIMIT = 256;

export interface AccessHost {
  tree(id: string): HostTree | null;
  /** Whether a group profile tree's current root lists this person by Profile TreeID. */
  isProfileMember(group: HostTree, profileTree: string): boolean;
  /** The tree's current root frontmatter `type`, or null when it declares neither profile kind. */
  rootProfileType(tree: HostTree): "person" | "group" | null;
  /** Whether this host's copy of a group another host holds lists this person (access control §3.3). */
  isRemoteGroupMember(group: string, homeHost: string, profileTree: string): boolean;
  /** The TreeID a profile locator `tree`'s configuration names is pinned to, or null when it names nobody now. */
  pinnedProfile(tree: string, locator: string): string | null;
}

/**
 * Who may do what to each tree, from the derived index of its accepted tree
 * configuration: `tree_policy` holds `access.yaml`, `tree_admins` its
 * administrators, and `app_policy` each profile's `apps.yaml`.
 *
 * A profile administers a tree when an `admin` rule names it, or names a group
 * whose current members include it. A group another host holds, named by its
 * locator there, counts through this host's copy of its members at that host,
 * by the TreeID the locator is pinned to. An administrator may read and edit
 * the tree configuration and has `write` on the whole tree.
 */
export class AccessControl {
  private readonly parsed = new Map<string, unknown[]>();
  private readonly accounts: AccountDirectory;

  constructor(private readonly db: Database, private readonly host: AccessHost) {
    this.accounts = new AccountDirectory(db);
  }

  private parse<T>(json: string, parse: (value: unknown) => T[]): T[] {
    let rules = this.parsed.get(json) as T[] | undefined;
    if (!rules) {
      rules = parse(JSON.parse(json));
      if (this.parsed.size >= PARSED_RULES_LIMIT) this.parsed.delete(this.parsed.keys().next().value!);
      this.parsed.set(json, rules);
    }
    return rules;
  }

  /** A tree's `access.yaml` rules; none for a tree without a configuration. */
  rules(tree: string): ResourceAccessRule[] {
    const row = this.db.query("SELECT rules_json FROM tree_policy WHERE tree_id = ?").get(tree) as { rules_json: string } | null;
    return row ? this.parse(row.rules_json, parseResourceRules) : [];
  }

  /** A profile's `apps.yaml` rules for one app. */
  appRules(profile: string, app: string): AppAccessRule[] {
    const row = this.db.query("SELECT rules_json FROM app_policy WHERE profile_tree = ? AND app_tree = ?").get(profile, app) as { rules_json: string } | null;
    return row ? this.parse(row.rules_json, (value) => value as AppAccessRule[]) : [];
  }

  /** How `tree`'s configuration names profiles: its locators by their pins. */
  private pins(tree: string) {
    return { pinnedProfile: (locator: string) => this.host.pinnedProfile(tree, locator) };
  }

  /** The profiles an `admin` rule of the tree names, TreeIDs or locators. */
  administrators(tree: string): string[] {
    return (this.db.query("SELECT profile_tree FROM tree_admins WHERE tree_id = ? ORDER BY profile_tree").all(tree) as Array<{ profile_tree: string }>)
      .map((row) => row.profile_tree);
  }

  /** The tree `id` names, when its current root declares `type: group`. */
  private groupTree(id: string): HostTree | null {
    const group = this.host.tree(id);
    return group && this.host.rootProfileType(group) === "group" ? group : null;
  }

  /**
   * One-level group membership: only a profile an enabled account holds
   * counts. A group tree this host holds decides alone; a group another host
   * holds (`homeHost`, the origin of the locator naming it) is decided by the
   * copy of it read there, which fails closed.
   */
  readonly isGroupMember = (groupID: string, profile: string, homeHost?: string): boolean => {
    if (this.accounts.handleForProfile(profile) === undefined) return false;
    const held = this.host.tree(groupID);
    if (held) return this.host.rootProfileType(held) === "group" && this.host.isProfileMember(held, profile);
    return !!homeHost && this.host.isRemoteGroupMember(groupID, homeHost, profile);
  };

  /** Whether `profile` administers `tree`, directly or through a group it belongs to. */
  administers(profile: string | null, tree: string): boolean {
    if (!profile) return false;
    return this.administrators(tree).some((admin) => {
      const subject = subjectProfile(admin, this.pins(tree));
      return !!subject && (subject.tree === profile || this.isGroupMember(subject.tree, profile, subject.homeHost));
    });
  }

  /** Whether a profile holds `operation` at `path` of an ordinary tree by its
   * own access: administration or a rule without `app` that matches it. */
  private holds(profile: string | null, tree: string, path: string, operation: TreeOperation, linkDigest?: string): boolean {
    if (this.administers(profile, tree)) return true;
    return rulesAllow(this.rules(tree), { callerProfile: profile, linkDigest, isGroupMember: this.isGroupMember, ...this.pins(tree) }, path, operation);
  }

  /** Whether a rule without `app` names `profile` itself (not a group it
   * belongs to, nor everyone) for `operation` at `path`: access that is the
   * profile's own to lend. */
  private namedDirectly(profile: string, tree: string, path: string, operation: AccessOperation): boolean {
    return this.rules(tree).some((rule) => !rule.app && typeof rule.who === "object" && "profile" in rule.who
      && subjectProfile(rule.who.profile, this.pins(tree))?.tree === profile
      && scopeContains(rule.within ?? "/", path) && operationAllowed(rule.allow, operation));
  }

  /** A tree's whole-tree rules as access entries: rules scoped below the root
   * or through an app have no entry, and administrators have `write`. */
  entries(tree: string): HostAccessEntry[] {
    return this.rules(tree).flatMap((rule): HostAccessEntry[] => {
      if (rule.app || (rule.within ?? "/") !== "/" || typeof rule.who === "string" && rule.who !== "everyone") return [];
      const access = operationAllowed(rule.allow, "write") ? "write" : rule.allow.includes("read") ? "read" : null;
      if (!access) return [];
      const [subjectKind, subject]: [HostAccessEntry["subjectKind"], string] = rule.who === "everyone" ? ["everyone", "everyone"]
        : typeof rule.who === "object" && "profile" in rule.who ? ["profile", rule.who.profile] : ["link", (rule.who as { link: string }).link];
      // A stable id per tree and subject.
      return [{ id: `ax_${sha256(`${tree}\n${subjectKind}\n${subject}`).slice(0, 26)}`, tree, subjectKind, subject, access }];
    });
  }

  safePolicy(tree: string) {
    return this.rules(tree).map(safeResourceRule);
  }

  directExecution(account: HostAccount | null, treeID: string, subject: string, active: () => boolean, linkDigest?: string): ExecutionContext | undefined {
    const tree = this.host.tree(treeID);
    if (!tree || tree.policy !== "ordinary") return undefined;
    const rules = this.rules(treeID).filter((rule) => !rule.app && !rule.allow.includes("admin") && ruleMatches(rule, {
      callerProfile: account?.id ?? null, linkDigest, isGroupMember: this.isGroupMember, ...this.pins(treeID),
    }));
    return { code: "", version: "direct", caller: account?.id ?? null, subject, linkDigest,
      expiresAt: Date.now() + 60000, active,
      grants: rules.map((rule) => ({ lender: null, tree: treeID, within: rule.within ?? "/", allow: rule.allow as AccessOperation[] })),
    };
  }

  /**
   * Grant provenance and underlying authority are re-evaluated on every use.
   * A grant without a lender is the caller's own access, or the tree's own
   * rule through this app; code acting for a placement account's caller has
   * only what anyone holds, since that caller's `apps.yaml` is elsewhere. A lent grant needs its lender's `apps.yaml` entry
   * for this app and caller, and access a rule names the lender for directly,
   * except that a person approving an app for themselves (`who: me`) may use
   * any access they hold.
   */
  executionAllows(context: ExecutionContext, grant: ExecutionGrant, path: string, operation: AccessOperation): boolean {
    const tree = this.host.tree(grant.tree);
    if (!tree || tree.policy !== "ordinary") return false;
    const caller = context.caller ? this.accounts.enabledAccount(context.caller) : null;
    if (context.caller && !caller) return false;
    const callerProfile = caller?.id ?? null;
    if (grant.lender === null) {
      // Code acting for a placement account's caller has no personal access
      // of the caller's, only what anyone holds (access control §1.1, on a
      // placement host); direct execution is the caller's own.
      const own = context.code && caller?.homeHost ? null : callerProfile;
      if (this.holds(own, tree.id, path, operation, context.linkDigest)) return true;
      return !!context.code && rulesAllow(this.rules(tree.id).filter((rule) => rule.app === context.code),
        { callerProfile, app: context.code, linkDigest: context.linkDigest, isGroupMember: this.isGroupMember, ...this.pins(tree.id) }, path, operation);
    }
    const lender = grant.lender;
    const lenderAccount = this.accounts.enabledAccount(lender);
    // A placement account's `apps.yaml` is at its home host, so it lends
    // nothing here (access control §1.1, on a placement host).
    if (lenderAccount?.homeHost) return false;
    const person = lenderAccount !== null;
    if (!person && !this.groupTree(lender)) return false;
    if (!context.code) return false;
    const entries = this.appRules(lender, context.code).filter((rule) => rule.resource === tree.id
      && scopeContains(rule.within ?? "/", path) && operationAllowed(rule.allow, operation)
      && ruleMatches(rule, { ownerProfile: lender, callerProfile, linkDigest: context.linkDigest, isGroupMember: this.isGroupMember, ...this.pins(lender) }));
    if (!entries.length) return false;
    if (person && callerProfile === lender && entries.some((rule) => rule.who === "me") && this.holds(lender, tree.id, path, operation)) return true;
    return this.namedDirectly(lender, tree.id, path, operation);
  }

  /** `treeOrID` is an ID, or a tree the caller already read, which saves reading it again. */
  canRead(account: HostAccount | null, treeOrID: string | HostTree, linkDigest?: string): boolean {
    return this.allows(account, treeOrID, "read", linkDigest);
  }

  canWrite(account: HostAccount | null, treeOrID: string | HostTree, linkDigest?: string): boolean {
    return this.allows(account, treeOrID, "write", linkDigest);
  }

  /**
   * The caller's whole-tree access in one pass: `write` (which includes
   * read), `read`, or none. Administration and the tree's rules are read once,
   * where `canRead` then `canWrite` would read them twice.
   */
  level(account: HostAccount | null, treeOrID: string | HostTree, linkDigest?: string): "write" | "read" | null {
    const tree = typeof treeOrID === "string" ? this.host.tree(treeOrID) : treeOrID;
    if (!tree) return null;
    const profile = account?.id ?? null;
    if (isTreeConfigPolicy(tree.policy)) return !!account && !!tree.governs && this.administers(profile, tree.governs) ? "write" : null;
    if (this.administers(profile, tree.id)) return "write";
    const rules = this.rules(tree.id);
    const context = { callerProfile: profile, linkDigest, isGroupMember: this.isGroupMember, ...this.pins(tree.id) };
    return rulesAllow(rules, context, "/", "write") ? "write" : rulesAllow(rules, context, "/", "read") ? "read" : null;
  }

  private allows(account: HostAccount | null, treeOrID: string | HostTree, operation: "read" | "write", linkDigest?: string): boolean {
    const tree = typeof treeOrID === "string" ? this.host.tree(treeOrID) : treeOrID;
    if (!tree) return false;
    // Only a tree's administrators see its configuration.
    if (isTreeConfigPolicy(tree.policy)) return !!account && !!tree.governs && this.administers(account.id, tree.governs);
    return this.holds(account?.id ?? null, tree.id, "/", operation, linkDigest);
  }

  canAdminister(account: HostAccount, treeOrID: string | HostTree): boolean {
    const tree = typeof treeOrID === "string" ? this.host.tree(treeOrID) : treeOrID;
    if (!tree || isTreeConfigPolicy(tree.policy)) return false;
    return this.administers(account.id, tree.id);
  }
}
