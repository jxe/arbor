/** Resource policy is independent of transport credentials and provider implementation. */
export const ACCESS_OPERATIONS = [
  "read",
  "write",
  "create-child",
  "update-content",
  "update-properties",
  "delete",
] as const;
export type AccessOperation = typeof ACCESS_OPERATIONS[number];
/** `admin` names a tree's administrators. It is valid only in a tree
 * configuration's `access.yaml`, and implies every other operation. */
export type TreeOperation = AccessOperation | "admin";
export const TREE_OPERATIONS: readonly TreeOperation[] = [...ACCESS_OPERATIONS, "admin"];
/**
 * `me` and `members` name the profile whose `apps.yaml` holds the rule: `me`
 * in a person's, `members` (the group's current members) in a group's. Neither
 * is valid in `access.yaml`.
 *
 * A profile subject names a profile this host holds by its TreeID, or a
 * profile another host holds by its canonical locator there
 * (`https://home.example/~crew`), which the host pins to the TreeID it first
 * resolved to (locators §1, access control §1).
 */
export type AccessWho =
  | "everyone"
  | "me"
  | "members"
  | { profile: string }
  | { link: string };
export interface ResourceAccessRule {
  who: AccessWho;
  /** Restricts the rule to a host-attested execution of this code TreeID. */
  app?: string;
  allow: TreeOperation[];
  within?: string;
}
export interface ResourceCapability {
  tree: string;
  within: string;
  allow: AccessOperation[];
}
export interface ResourcePolicyContext {
  /** The profile whose `apps.yaml` holds the rules, for `me` and `members`. */
  ownerProfile?: string;
  callerProfile: string | null;
  app?: string;
  linkDigest?: string;
  /** `homeHost` is the origin of a locator subject's host, for a group this
   * host does not hold (access control §3.3). */
  isGroupMember?: (group: string, profile: string, homeHost?: string) => boolean;
  /** The TreeID a locator subject is pinned to, or null when it has no pin
   * or its host now names another profile; such a subject matches nobody. */
  pinnedProfile?: (locator: string) => string | null;
}
const treeID = /^tr_[a-z2-7]+$/;
const hash = /^sha256:[a-f0-9]{64}$/;
export function isTreeID(value: unknown): value is string {
  return typeof value === "string" && treeID.test(value);
}
/** Whether `value` is an origin one host may read another's published facts
 * from (a profile's device keys, a group's members): HTTPS, or plain HTTP on
 * a loopback address for local hosts. */
export function isHomeHostOrigin(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== value) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}
/**
 * A profile named by its canonical locator at another host (locators §1):
 * `https://host/path`, `overstory://host/path`, or `http://` for a loopback host.
 * `locator` is its canonical spelling, the subject's merge key and pin key
 * (`overstory://` becomes the HTTP locator it resolves through); `origin` is
 * where the profile is read. Null for anything else, a TreeID included.
 */
export function parseProfileLocator(value: unknown): { locator: string; origin: string } | null {
  // URL parsing folds dot segments away, so they are refused as written.
  if (typeof value !== "string" || value.startsWith("tr_") || /\/\.{1,2}(\/|$)/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.search || url.hash || url.username || url.password || !url.hostname || url.hostname.startsWith("tr_")) return null;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const scheme = url.protocol === "https:" ? "https:"
    : url.protocol === "http:" && loopback ? "http:"
    : url.protocol === "story:" ? (loopback ? "http:" : "https:")
    : null;
  if (!scheme) return null;
  // Spelled out rather than left to URL parsing, which leaves an story: host's
  // case and port alone: a lowercase host, and no port the scheme implies.
  const port = url.port && url.port !== (scheme === "https:" ? "443" : "80") ? `:${url.port}` : "";
  const origin = `${scheme}//${url.hostname.toLowerCase()}${port}`;
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/" || /[\x00-\x1f\x7f]/.test(path) || path.split("/").slice(1).some((part) => !part || part === "." || part === "..")) return null;
  return { locator: `${origin}${path}`, origin };
}

/** Whether a profile subject names a profile another host holds. */
export function isProfileLocator(profile: string): boolean {
  return parseProfileLocator(profile) !== null;
}

export function resourcePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    (value !== "/" && value.endsWith("/")) ||
    value.includes("//") ||
    value.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Invalid resource path");
  return value;
}

/** Which file a rule is authored in, which decides its subjects and fields. */
export type RuleFile = "access" | "person-apps" | "group-apps";

function parseWho(value: unknown, file: RuleFile): AccessWho {
  if (value === "everyone") return value;
  if (value === "me" || value === "members") {
    const own = file === "person-apps" ? "me" : file === "group-apps" ? "members" : null;
    if (value !== own) {
      if (file === "access") throw new Error(`who: ${value} is not valid in access.yaml`);
      throw new Error(`who: ${value} is not valid in this profile's apps.yaml`);
    }
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid rule subject");
  const w = value as Record<string, unknown>;
  const keys = Object.keys(w);
  if (keys.length !== 1) throw new Error("Invalid rule subject");
  if (typeof w.profile === "string" && treeID.test(w.profile))
    return { profile: w.profile };
  const locator = parseProfileLocator(w.profile);
  if (locator) return { profile: locator.locator };
  if (typeof w.link === "string" && hash.test(w.link))
    return { link: w.link };
  throw new Error("Invalid rule subject");
}

function parseAllow(value: unknown, admin: boolean): TreeOperation[] {
  const allowed: readonly string[] = admin ? TREE_OPERATIONS : ACCESS_OPERATIONS;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((x) => !allowed.includes(x)) ||
    new Set(value).size !== value.length
  )
    throw new Error("Invalid resource operations");
  return [...value];
}

/**
 * One `access.yaml` rule: `who` / `app` / `allow` / `within`. `admin` may
 * only be granted to a profile, in a rule with no `app` and no `within`.
 */
export function parseResourceRule(value: unknown): ResourceAccessRule {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Resource rule must be a mapping");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["who", "app", "allow", "within"].includes(k)))
    throw new Error("Unknown resource rule field");
  const who = parseWho(v.who, "access");
  if (v.app !== undefined && !isTreeID(v.app))
    throw new Error("Invalid app TreeID");
  const allow = parseAllow(v.allow, true);
  const within = v.within !== undefined ? resourcePath(v.within) : undefined;
  if (allow.includes("admin")) {
    if (typeof who !== "object" || !("profile" in who))
      throw new Error("admin may only be granted to a profile");
    if (v.app !== undefined || within !== undefined)
      throw new Error("admin cannot be narrowed by app or within");
  }
  return {
    who,
    ...(v.app !== undefined ? { app: v.app as string } : {}),
    allow,
    ...(within !== undefined ? { within } : {}),
  };
}

/** One `apps.yaml` entry rule, without its `resource`: `who` defaults to the
 * profile itself (`me` for a person, `members` for a group). */
export function parseAppRule(value: Record<string, unknown>, file: "person-apps" | "group-apps"): Omit<ResourceAccessRule, "app"> {
  const who = parseWho(value.who ?? (file === "person-apps" ? "me" : "members"), file);
  return {
    who,
    allow: parseAllow(value.allow, false),
    ...(value.within !== undefined ? { within: resourcePath(value.within) } : {}),
  };
}

/** A subject's merge key; a locator subject is keyed by its canonical spelling. */
function whoKey(who: AccessWho): string {
  return typeof who === "string"
    ? who
    : "profile" in who
    ? `profile:${who.profile}`
    : `link:${who.link}`;
}

/** An `access.yaml` rule's merge key: canonical `(who, app, within)`. */
export function resourceRuleKey(rule: ResourceAccessRule): string {
  return JSON.stringify([whoKey(rule.who), rule.app ?? null, rule.within ?? "/"]);
}
export function parseResourceRules(value: unknown): ResourceAccessRule[] {
  if (!Array.isArray(value)) throw new Error("Resource rules must be a list");
  const rules = value.map(parseResourceRule);
  if (new Set(rules.map(resourceRuleKey)).size !== rules.length)
    throw new Error("Duplicate resource rule");
  return rules;
}

/** The profile locators a list of rules names, in their canonical spelling. */
export function ruleLocators(rules: readonly Pick<ResourceAccessRule, "who">[]): string[] {
  return [...new Set(rules.flatMap(({ who }) =>
    typeof who === "object" && "profile" in who && isProfileLocator(who.profile) ? [who.profile] : []))];
}

/**
 * A profile subject as a TreeID and, for a locator, the host it is read at:
 * a TreeID names itself; a locator names its pin, or nothing when it has none.
 */
export function subjectProfile(profile: string, context: Pick<ResourcePolicyContext, "pinnedProfile">): { tree: string; homeHost?: string } | null {
  const locator = parseProfileLocator(profile);
  if (!locator) return { tree: profile };
  const pinned = context.pinnedProfile?.(locator.locator) ?? null;
  return pinned ? { tree: pinned, homeHost: locator.origin } : null;
}
export function scopeContains(scope: string, path: string): boolean {
  resourcePath(scope);
  resourcePath(path);
  return scope === "/" || path === scope || path.startsWith(`${scope}/`);
}
/** `admin` implies `write`, and `write` every narrower operation. */
export function operationAllowed(
  allow: readonly TreeOperation[],
  operation: TreeOperation
): boolean {
  if (allow.includes("admin")) return true;
  if (operation === "admin") return false;
  return allow.includes("write") || allow.includes(operation);
}
export function ruleMatches(
  rule: Pick<ResourceAccessRule, "who" | "app">,
  context: ResourcePolicyContext
): boolean {
  if (rule.app && rule.app !== context.app) return false;
  if (rule.who === "everyone") return true;
  if (rule.who === "me")
    return (
      context.callerProfile !== null &&
      context.callerProfile === context.ownerProfile
    );
  if (rule.who === "members")
    return (
      context.callerProfile !== null &&
      context.ownerProfile !== undefined &&
      context.isGroupMember?.(context.ownerProfile, context.callerProfile) === true
    );
  if ("link" in rule.who) return rule.who.link === context.linkDigest;
  if (context.callerProfile === null) return false;
  const subject = subjectProfile(rule.who.profile, context);
  return !!subject && (subject.tree === context.callerProfile ||
    context.isGroupMember?.(subject.tree, context.callerProfile, subject.homeHost) === true);
}
export function rulesAllow(
  rules: readonly Pick<ResourceAccessRule, "who" | "app" | "allow" | "within">[],
  context: ResourcePolicyContext,
  path: string,
  operation: TreeOperation
): boolean {
  return rules.some(
    (rule) =>
      ruleMatches(rule, context) &&
      scopeContains(rule.within ?? "/", path) &&
      operationAllowed(rule.allow, operation)
  );
}
/** Narrowing concurrent edits never becomes a union of additional authority. */
export function intersectResourceRules<T extends Pick<ResourceAccessRule, "allow">>(
  left: T,
  right: T
): T | null {
  const allow = TREE_OPERATIONS.filter(
    (op) =>
      operationAllowed(left.allow, op) && operationAllowed(right.allow, op)
  );
  if (!allow.length) return null;
  return {
    ...left,
    allow: allow.includes("admin") ? ["admin"] : allow.includes("write") ? ["write"] : allow,
  };
}

export type SafeResourceWho =
  | Exclude<AccessWho, { link: string }>
  | { link: true };
export interface SafeResourceAccessRule {
  who: SafeResourceWho;
  app?: string;
  allow: TreeOperation[];
  within?: string;
}
export function safeResourceRule(
  rule: ResourceAccessRule
): SafeResourceAccessRule {
  return {
    ...rule,
    allow: [...rule.allow],
    who:
      typeof rule.who === "object" && "link" in rule.who
        ? { link: true }
        : rule.who,
  };
}
