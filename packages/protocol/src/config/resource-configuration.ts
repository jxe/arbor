import { parseResourceRules, type ResourceAccessRule } from "../index.ts";
import { parseDocument, isAlias, visit } from "yaml";
import {
  configurationTreeID,
  type CanopyAccountConfiguration,
} from "./account-config-v2.ts";
export interface ResourceDeclaration {
  canonical?: string;
  access: ResourceAccessRule[];
}
export type ResourceConfiguration = Record<string, ResourceDeclaration>;
/** New policy grammar; legacy readers remain separate for retained history/migration. */
export function parseResourceConfiguration(
  source: string,
  account: CanopyAccountConfiguration
): ResourceConfiguration {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Invalid resource configuration YAML");
  visit(doc, (_key, node) => {
    if (isAlias(node)) throw new Error("YAML aliases are not allowed");
  });
  const value = doc.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("trees.yaml must be a mapping");
  const result: ResourceConfiguration = {};
  for (const [id, raw] of Object.entries(value)) {
    configurationTreeID(id);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid resource declaration");
    const v = raw as Record<string, unknown>;
    if (Object.keys(v).some((k) => k !== "canonical" && k !== "access"))
      throw new Error("Unknown resource field");
    if (v.canonical !== undefined) {
      if (typeof v.canonical !== "string")
        throw new Error(
          "Canonical URL must use the account Canopy origin without credentials, query, or fragment"
        );
      const url = new URL(v.canonical);
      if (
        url.origin !== account.canopy ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname.includes("//")
      )
        throw new Error(
          "Canonical URL must use the account Canopy origin without credentials, query, or fragment"
        );
    }
    result[id] = {
      ...(v.canonical !== undefined
        ? { canonical: v.canonical as string }
        : {}),
      access: parseResourceRules(v.access),
    };
  }
  return result;
}

/** Whole-tree legacy projection is deliberately lossy and never used for scoped checks. */
export function hostedProjection(
  resources: ResourceConfiguration
): import("./account-config-v2.ts").HostedTreesConfiguration {
  return Object.fromEntries(
    Object.entries(resources)
      .filter(([, d]) => d.canonical !== undefined)
      .map(([id, d]) => [
        id,
        {
          canonical: d.canonical!,
          access: d.access.flatMap((rule) => {
            if (rule.via || (rule.within ?? "/") !== "/" || rule.who === "me")
              return [];
            const access = rule.allow.includes("write")
              ? ("write" as const)
              : rule.allow.includes("read")
              ? ("read" as const)
              : null;
            if (!access) return [];
            const subject =
              rule.who === "everyone"
                ? { kind: "everyone" as const }
                : "profile" in rule.who
                ? { kind: "profile" as const, tree: rule.who.profile }
                : {
                    kind: "link" as const,
                    digest: rule.who.link as `sha256:${string}`,
                  };
            return [{ subject, access }];
          }),
        },
      ])
  );
}

export function resourceRuleFromLegacy(
  rule: import("../index.ts").AccessRule
): ResourceAccessRule {
  const who =
    rule.subject.kind === "everyone"
      ? ("everyone" as const)
      : rule.subject.kind === "profile"
      ? { profile: rule.subject.tree }
      : { link: rule.subject.digest };
  return { who, allow: [rule.access] };
}
