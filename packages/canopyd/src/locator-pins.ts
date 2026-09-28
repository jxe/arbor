import type { Database } from "bun:sqlite";
import { parseProfileLocator } from "@overstory/protocol";
import { HomeHostUnavailableError } from "./errors.ts";

/**
 * How this host keeps its pins honest (locators §1): each pinned locator is
 * resolved again every `lifetimeMs`, a failed resolution is retried after
 * `refetchMs`, and a locator its host has not confirmed for `staleMs`, the
 * grace, names nobody until it answers again.
 */
export interface LocatorPinLifetimes {
  lifetimeMs: number;
  refetchMs: number;
  staleMs: number;
}

/** The Profile TreeID a locator names at its host now, or null when the host
 * answers that it names no readable profile. Throws when the host cannot be
 * read, which a pin survives until the grace runs out. */
export type ProfileLocatorResolver = (locator: string, origin: string) => Promise<string | null>;

/** The longest one resolution waits. */
const FETCH_TIMEOUT_MS = 5_000;
const TREE_ID = /^tr_[a-z2-7]+$/;

/**
 * A locator's profile, by the canonical lookup at its host
 * (`GET /.well-known/arbor<path>`), read anonymously: the locator must be the
 * root of a readable tree there. Anything else names no profile.
 */
export const resolveProfileLocator: ProfileLocatorResolver = async (locator, origin) => {
  const path = locator.slice(origin.length);
  let response: Response;
  try {
    response = await fetch(`${origin}/.well-known/arbor${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  } catch (error) {
    throw new Error(`${origin} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status >= 400 && response.status < 500) return null;
  if (!response.ok) throw new Error(`${origin} answered ${response.status}`);
  const body = await response.json().catch(() => null) as { ref?: { tree?: unknown; path?: unknown } } | null;
  const tree = body?.ref?.tree;
  return typeof tree === "string" && TREE_ID.test(tree) && body?.ref?.path === "/" ? tree : null;
};

/** What a locator's host said last, in memory: the TreeID (or null), and
 * when it last answered at all. */
interface Resolution {
  profile: string | null;
  confirmedAt: number;
}

/**
 * Pinned profile locators (locators §1): per tree whose configuration names a
 * profile by its locator at another host, the Profile TreeID it was pinned to
 * (`profile_locator_pins`). A pin names its TreeID while the locator's host
 * still resolves the locator to it; a locator its host now resolves to
 * another TreeID, or to none, or one unconfirmed past the grace, names
 * nobody. `onChanged` runs whenever what a pin names changes, so decisions
 * made from it are made again.
 */
export class LocatorPins {
  private readonly resolutions = new Map<string, Resolution>();
  private readonly failures = new Map<string, number>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: Database,
    private readonly lifetimes: () => LocatorPinLifetimes,
    private readonly onChanged: () => void,
    private readonly resolve: ProfileLocatorResolver = resolveProfileLocator,
  ) {}

  /** The TreeID `locator` names for `tree`, or null (see the class). */
  pinned(tree: string, locator: string): string | null {
    const row = this.db.query("SELECT profile_tree FROM profile_locator_pins WHERE tree_id = ? AND locator = ?").get(tree, locator) as { profile_tree: string } | null;
    return row && this.honours(locator, row.profile_tree) ? row.profile_tree : null;
  }

  /**
   * The TreeID `locator` was pinned to for `tree` unless its host has since
   * named another profile (or none): what a placement account's reservation
   * needs, whose outages the device keys' own grace decides (accounts §5.4).
   */
  pinnedUnlessChanged(tree: string, locator: string): string | null {
    const row = this.db.query("SELECT profile_tree FROM profile_locator_pins WHERE tree_id = ? AND locator = ?").get(tree, locator) as { profile_tree: string } | null;
    const known = this.resolutions.get(locator);
    return row && (!known || known.profile === row.profile_tree) ? row.profile_tree : null;
  }

  /** Whether the locator's host still names `profile`, as far as this host knows. */
  private honours(locator: string, profile: string): boolean {
    const known = this.resolutions.get(locator);
    const confirmedAt = known?.confirmedAt ?? this.startedAt;
    if (Date.now() - confirmedAt >= this.lifetimes().staleMs) return false;
    return !known || known.profile === profile;
  }

  /**
   * Resolve, before an accept's transaction, each of `locators` that `tree`
   * has no honoured pin for: a new entry, or one whose pin names nobody now,
   * which the accepted change pins afresh. Throws, naming the host, when one
   * cannot be resolved to a profile; the accept is then refused.
   */
  async prepare(tree: string, locators: Iterable<string>): Promise<Map<string, string>> {
    const fresh = new Map<string, string>();
    for (const locator of new Set(locators)) {
      if (this.pinned(tree, locator)) continue;
      const parsed = parseProfileLocator(locator);
      if (!parsed) throw new Error(`Not a profile locator: ${locator}`);
      let profile: string | null;
      try {
        profile = await this.resolve(parsed.locator, parsed.origin);
      } catch (error) {
        throw new HomeHostUnavailableError(parsed.origin, `${locator} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!profile) throw new Error(`${parsed.origin} does not name a readable profile at ${locator}; the profile must be publicly readable there`);
      this.resolutions.set(parsed.locator, { profile, confirmedAt: Date.now() });
      fresh.set(parsed.locator, profile);
    }
    return fresh;
  }

  /**
   * Write `tree`'s pins inside its accept's transaction: `fresh` from
   * `prepare`, and every pin for a locator the tree no longer names removed.
   */
  write(tree: string, fresh: ReadonlyMap<string, string>, named: Iterable<string>, now = Date.now()): void {
    const keep = new Set(named);
    for (const row of this.db.query("SELECT locator FROM profile_locator_pins WHERE tree_id = ?").all(tree) as Array<{ locator: string }>) {
      if (!keep.has(row.locator)) this.db.run("DELETE FROM profile_locator_pins WHERE tree_id = ? AND locator = ?", [tree, row.locator]);
    }
    for (const [locator, profile] of fresh) {
      this.db.run(`INSERT INTO profile_locator_pins (tree_id, locator, profile_tree, pinned_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(tree_id, locator) DO UPDATE SET profile_tree = excluded.profile_tree, pinned_at = excluded.pinned_at`,
        [tree, locator, profile, now]);
    }
  }

  /** Every pinned locator, resolved again unless one ran or failed within its interval. */
  async refresh(): Promise<void> {
    const locators = (this.db.query("SELECT DISTINCT locator FROM profile_locator_pins").all() as Array<{ locator: string }>).map((row) => row.locator);
    for (const known of [...this.resolutions.keys()]) if (!locators.includes(known)) this.resolutions.delete(known);
    const before = this.snapshot();
    await Promise.all(locators.map((locator) => this.check(locator)));
    if (this.snapshot() !== before) this.onChanged();
  }

  /** What every pin names now, for noticing a change. */
  private snapshot(): string {
    const rows = this.db.query("SELECT tree_id, locator, profile_tree FROM profile_locator_pins ORDER BY tree_id, locator").all() as Array<{ tree_id: string; locator: string; profile_tree: string }>;
    return rows.map((row) => `${row.tree_id} ${row.locator} ${this.honours(row.locator, row.profile_tree) ? row.profile_tree : "-"}`).join("\n");
  }

  private check(locator: string): Promise<void> {
    const running = this.running.get(locator);
    if (running) return running;
    const { lifetimeMs, refetchMs } = this.lifetimes();
    const known = this.resolutions.get(locator);
    if (known && Date.now() - known.confirmedAt < lifetimeMs) return Promise.resolve();
    const failed = this.failures.get(locator);
    if (failed !== undefined && Date.now() - failed < refetchMs) return Promise.resolve();
    const parsed = parseProfileLocator(locator);
    if (!parsed) return Promise.resolve();
    const pending = (async () => {
      try {
        const profile = await this.resolve(parsed.locator, parsed.origin);
        this.failures.delete(locator);
        this.resolutions.set(locator, { profile, confirmedAt: Date.now() });
      } catch {
        this.failures.set(locator, Date.now());
      }
    })().finally(() => this.running.delete(locator));
    this.running.set(locator, pending);
    return pending;
  }
}
