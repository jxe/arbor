import { randomBytes } from "node:crypto";
import type { LocatorPinLifetimes } from "./locator-pins.ts";

/**
 * Trees at a person's domain (locators §5.1). A person points a domain at
 * this host and lists it in their profile's `domains`; while the domain
 * answers with this host's token and exactly one local person profile lists
 * it, the host serves that profile's path (its prefix) at the domain, and
 * descriptors name the domain form as the canonical URL.
 */

/** The route every name this host answers to serves its token at. */
export const DOMAIN_CHECK_PATH = "/.overstory/domain-check";

/** A domain a local person profile lists, with the path its profile is mounted at. */
export interface DomainCandidate {
  domain: string;
  profile: string;
  prefix: string;
}

/** The token `domain` answers with, or null when it answers something else. Throws on an outage. */
export type DomainReach = (domain: string) => Promise<string | null>;

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** The origin a served domain is reached at: `https`, or `http` for a loopback test domain. */
export function domainOrigin(domain: string): string {
  return `${LOOPBACK.test(domain) ? "http" : "https"}://${domain}`;
}

/** Fetch the domain's check route without following redirects. */
export const reachDomain: DomainReach = async (domain) => {
  const response = await fetch(`${domainOrigin(domain)}${DOMAIN_CHECK_PATH}`, {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 500) throw new Error(`${domain} answered ${response.status}`);
  if (!response.ok) return null;
  try {
    const body = await response.json() as { host?: unknown };
    return typeof body.host === "string" ? body.host : null;
  } catch {
    return null;
  }
};

interface Served extends DomainCandidate {
  confirmedAt: number;
}

export class CustomDomains {
  /** What this host answers at `DOMAIN_CHECK_PATH`, at every name. New each start. */
  readonly token = randomBytes(16).toString("base64url");
  private readonly served = new Map<string, Served>();
  private readonly failures = new Map<string, number>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly candidates: () => Promise<DomainCandidate[]>,
    private readonly lifetimes: () => LocatorPinLifetimes,
    private readonly reach: DomainReach = reachDomain,
  ) {}

  /** The served domain a request's `Host` names, or null. */
  serving(host: string | null | undefined): Served | null {
    if (!host) return null;
    const served = this.served.get(host.toLowerCase());
    return served && this.fresh(served) ? served : null;
  }

  /**
   * The canonical URL of `path` (a canonical path at this host) when a served
   * domain's prefix covers it: the longest such prefix decides.
   */
  url(path: string): string | null {
    let best: Served | null = null;
    for (const served of this.served.values()) {
      if (!this.fresh(served) || !covers(served.prefix, path)) continue;
      if (!best || served.prefix.length > best.prefix.length) best = served;
    }
    if (!best) return null;
    const below = path.slice(best.prefix.length);
    const encoded = below.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return `${domainOrigin(best.domain)}/${encoded}`;
  }

  /** The served domain covering `path`, for redirecting a browser there. */
  domainFor(path: string): Served | null {
    let best: Served | null = null;
    for (const served of this.served.values()) {
      if (this.fresh(served) && covers(served.prefix, path) && (!best || served.prefix.length > best.prefix.length)) best = served;
    }
    return best;
  }

  /** Every domain served now, for tests and logs. */
  list(): DomainCandidate[] {
    return [...this.served.values()].filter((served) => this.fresh(served))
      .map(({ domain, profile, prefix }) => ({ domain, profile, prefix }));
  }

  /** Check every listed domain again, unless one was confirmed or failed within its interval. */
  refresh(): Promise<void> {
    this.running ??= this.check().finally(() => { this.running = null; });
    return this.running;
  }

  private async check(): Promise<void> {
    const listed = await this.candidates();
    // A domain two profiles list names neither.
    const counts = new Map<string, number>();
    for (const candidate of listed) counts.set(candidate.domain, (counts.get(candidate.domain) ?? 0) + 1);
    const candidates = new Map(listed.filter((candidate) => counts.get(candidate.domain) === 1).map((candidate) => [candidate.domain, candidate]));
    for (const domain of [...this.served.keys()]) {
      const served = this.served.get(domain)!;
      const candidate = candidates.get(domain);
      if (!candidate || candidate.profile !== served.profile || candidate.prefix !== served.prefix) this.served.delete(domain);
    }
    const { lifetimeMs, refetchMs } = this.lifetimes();
    const now = Date.now();
    await Promise.all([...candidates.values()].map(async (candidate) => {
      const known = this.served.get(candidate.domain);
      if (known && now - known.confirmedAt < lifetimeMs) return;
      const failed = this.failures.get(candidate.domain);
      if (failed !== undefined && now - failed < refetchMs) return;
      let answer: string | null;
      try {
        answer = await this.reach(candidate.domain);
      } catch {
        // An outage keeps a served domain until the grace runs out.
        this.failures.set(candidate.domain, Date.now());
        return;
      }
      if (answer === this.token) {
        this.failures.delete(candidate.domain);
        this.served.set(candidate.domain, { ...candidate, confirmedAt: Date.now() });
      } else {
        // Another answer: the domain reaches someone else.
        this.failures.set(candidate.domain, Date.now());
        this.served.delete(candidate.domain);
      }
    }));
  }

  private fresh(served: Served): boolean {
    return Date.now() - served.confirmedAt < this.lifetimes().staleMs;
  }
}

/** Whether `prefix` is `path` or one of its ancestors. */
function covers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
