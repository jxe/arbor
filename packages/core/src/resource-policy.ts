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
export type AccessWho =
  | "everyone"
  | "me"
  | { profile: string }
  | { link: string };
export interface ResourceAccessRule {
  who: AccessWho;
  via?: string;
  allow: AccessOperation[];
  within?: string;
}
export interface ResourceCapability {
  tree: string;
  within: string;
  allow: AccessOperation[];
}
export interface ResourcePolicyContext {
  ownerProfile: string;
  callerProfile: string | null;
  via?: string;
  linkDigest?: string;
  isGroupMember?: (group: string, profile: string) => boolean;
}
const treeID = /^tr_[a-z2-7]+$/;
const hash = /^sha256:[a-f0-9]{64}$/;
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
export function parseResourceRule(value: unknown): ResourceAccessRule {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Resource rule must be a mapping");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["who", "via", "allow", "within"].includes(k))
  )
    throw new Error("Unknown resource rule field");
  let who: AccessWho;
  if (v.who === "everyone" || v.who === "me") who = v.who;
  else {
    if (!v.who || typeof v.who !== "object" || Array.isArray(v.who))
      throw new Error("Invalid rule subject");
    const w = v.who as Record<string, unknown>;
    if (Object.keys(w).length !== 1) throw new Error("Invalid rule subject");
    if (typeof w.profile === "string" && treeID.test(w.profile))
      who = { profile: w.profile };
    else if (typeof w.link === "string" && hash.test(w.link))
      who = { link: w.link };
    else throw new Error("Invalid rule subject");
  }
  if (v.via !== undefined && (typeof v.via !== "string" || !treeID.test(v.via)))
    throw new Error("Invalid executable TreeID");
  if (
    !Array.isArray(v.allow) ||
    !v.allow.length ||
    v.allow.some((x) => !ACCESS_OPERATIONS.includes(x)) ||
    new Set(v.allow).size !== v.allow.length
  )
    throw new Error("Invalid resource operations");
  return {
    who,
    ...(v.via !== undefined ? { via: v.via as string } : {}),
    allow: [...v.allow],
    ...(v.within !== undefined ? { within: resourcePath(v.within) } : {}),
  };
}
export function resourceRuleKey(rule: ResourceAccessRule): string {
  const who =
    typeof rule.who === "string"
      ? rule.who
      : "profile" in rule.who
      ? `profile:${rule.who.profile}`
      : `link:${rule.who.link}`;
  return JSON.stringify([who, rule.via ?? null, rule.within ?? "/"]);
}
export function parseResourceRules(value: unknown): ResourceAccessRule[] {
  if (!Array.isArray(value)) throw new Error("Resource rules must be a list");
  const rules = value.map(parseResourceRule);
  if (new Set(rules.map(resourceRuleKey)).size !== rules.length)
    throw new Error("Duplicate resource rule");
  return rules;
}
export function scopeContains(scope: string, path: string): boolean {
  resourcePath(scope);
  resourcePath(path);
  return scope === "/" || path === scope || path.startsWith(`${scope}/`);
}
export function operationAllowed(
  allow: readonly AccessOperation[],
  operation: AccessOperation
): boolean {
  return allow.includes("write") || allow.includes(operation);
}
export function ruleMatches(
  rule: ResourceAccessRule,
  context: ResourcePolicyContext
): boolean {
  if (rule.via && rule.via !== context.via) return false;
  if (rule.who === "everyone") return true;
  if (rule.who === "me")
    return (
      context.callerProfile !== null &&
      context.callerProfile === context.ownerProfile
    );
  if ("link" in rule.who) return rule.who.link === context.linkDigest;
  return (
    context.callerProfile !== null &&
    (rule.who.profile === context.callerProfile ||
      context.isGroupMember?.(rule.who.profile, context.callerProfile) === true)
  );
}
export function rulesAllow(
  rules: readonly ResourceAccessRule[],
  context: ResourcePolicyContext,
  path: string,
  operation: AccessOperation
): boolean {
  return rules.some(
    (rule) =>
      ruleMatches(rule, context) &&
      scopeContains(rule.within ?? "/", path) &&
      operationAllowed(rule.allow, operation)
  );
}
/** Narrowing concurrent edits never becomes a union of additional authority. */
export function intersectResourceRules(
  left: ResourceAccessRule,
  right: ResourceAccessRule
): ResourceAccessRule | null {
  if (resourceRuleKey(left) !== resourceRuleKey(right))
    throw new Error("Cannot intersect different rules");
  const allow = ACCESS_OPERATIONS.filter(
    (op) =>
      operationAllowed(left.allow, op) && operationAllowed(right.allow, op)
  );
  if (!allow.length) return null;
  return { ...left, allow: allow.includes("write") ? ["write"] : allow };
}

export type SafeResourceWho =
  | Exclude<AccessWho, { link: string }>
  | { link: true };
export interface SafeResourceAccessRule {
  who: SafeResourceWho;
  via?: string;
  allow: AccessOperation[];
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
