import { parseProfileLocator } from "./resource-policy.ts";

/**
 * Domain locators (locators §1.1): a person points a domain they control at
 * their profile, so `https://alice.com` names her wherever she is homed. The
 * domain names the profile by its locator at its home host, in a DNS TXT
 * record or a well-known file; the profile names the domain back in its
 * root front matter's `domains`. Both directions must agree.
 */

/** The well-known file a domain names its profile in. */
export const DOMAIN_PROFILE_PATH = "/.well-known/overstory-profile";

/** The DNS name whose TXT record a domain names its profile in. */
export function domainTXTName(domain: string): string {
  return `_overstory.${domain.replace(/:\d+$/, "")}`;
}

/** The home locator one TXT record names: `profile=<locator>`, or null when it says something else. */
export function parseDomainTXT(record: string): string | null {
  const match = /^profile=(\S+)$/.exec(record.trim());
  return match ? homeLocator(match[1]) : null;
}

/** The home locator a well-known file names: `{ "profile": "<locator>" }`, or null. */
export function parseDomainWellKnown(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return homeLocator((body as { profile?: unknown }).profile);
}

/** A locator at a home host, never another domain: a domain names its profile directly. */
function homeLocator(value: unknown): string | null {
  const parsed = parseProfileLocator(value);
  return parsed && !parsed.domain ? parsed.locator : null;
}

/**
 * The domains a profile's root front matter claims, as written: each a
 * lowercase DNS name (with a port only for loopback test hosts). Anything
 * else is ignored, like any malformed presentation field.
 */
export function profileDomains(frontmatter: Record<string, unknown>): string[] {
  const declared = frontmatter.domains;
  const values = Array.isArray(declared) ? declared : typeof declared === "string" ? [declared] : [];
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const parsed = parseProfileLocator(`https://${value.trim()}`);
    return parsed?.domain && parsed.domain === value.trim().toLowerCase() ? [parsed.domain] : [];
  }))];
}

export interface DomainLookups {
  /** The TXT records at a DNS name; an empty list when there are none. Throws on an outage. */
  resolveTXT(name: string): Promise<string[]>;
  /** The well-known file's JSON, null when the domain serves none. Throws on an outage. */
  fetchWellKnown(origin: string): Promise<unknown | null>;
}

/** Real lookups: DNS TXT through the system resolver, and the well-known file over HTTPS without following redirects. */
export const defaultDomainLookups: DomainLookups = {
  async resolveTXT(name) {
    const { resolveTxt } = await import("node:dns/promises");
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return [];
      throw error;
    }
  },
  async fetchWellKnown(origin) {
    const response = await fetch(`${origin}${DOMAIN_PROFILE_PATH}`, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`${origin}${DOMAIN_PROFILE_PATH} answered ${response.status}`);
    try { return await response.json(); } catch { return null; }
  },
};

/**
 * The home locator a domain locator's records name, or null when they name
 * none or name two different profiles. A DNS name's TXT record and
 * well-known file are both read; a loopback domain (a local test host) has
 * only its well-known file.
 * Throws when neither can be read for an outage, or when one cannot and the
 * other names nothing.
 */
export async function resolveDomainDelegation(locator: string, lookups: DomainLookups = defaultDomainLookups): Promise<string | null> {
  const parsed = parseProfileLocator(locator);
  if (!parsed?.domain) throw new Error(`Not a domain locator: ${locator}`);
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(parsed.domain);
  const [txt, wellKnown] = await Promise.allSettled([
    loopback ? Promise.resolve([] as string[]) : lookups.resolveTXT(domainTXTName(parsed.domain)),
    lookups.fetchWellKnown(parsed.origin),
  ]);
  if (txt.status === "rejected" && wellKnown.status === "rejected") throw txt.reason;
  const named = new Set<string>();
  if (txt.status === "fulfilled") for (const record of txt.value) {
    if (!record.trim().startsWith("profile=")) continue;
    const home = parseDomainTXT(record);
    if (!home) return null;
    named.add(home);
  }
  if (wellKnown.status === "fulfilled" && wellKnown.value !== null) {
    const home = parseDomainWellKnown(wellKnown.value);
    if (!home) return null;
    named.add(home);
  }
  // Nothing named while one lookup failed is an outage, not an answer.
  if (named.size === 0 && txt.status === "rejected") throw txt.reason;
  if (named.size === 0 && wellKnown.status === "rejected") throw wellKnown.reason;
  // Records that disagree name nobody: a resolver never guesses (locators §4).
  return named.size === 1 ? [...named][0]! : null;
}
