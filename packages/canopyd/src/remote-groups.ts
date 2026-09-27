import { decodeProtocolDirectory, hashObject, parseMarkdown, type ObjectHash } from "@overstory/protocol";
import { profileLocatorTree, structuredMembers } from "./profile.ts";

/**
 * How long this host keeps a copy of a group another host holds (access
 * control §3.3): `lifetimeMs` before it is refetched, `refetchMs` before a
 * fetch that failed is tried again, and `staleMs`, the grace, past which a
 * copy it cannot refresh matches nobody.
 */
export interface RemoteGroupLifetimes {
  lifetimeMs: number;
  refetchMs: number;
  staleMs: number;
}

/** A group's members as its host answered: the Profile TreeIDs its root
 * `members` names, or none when the host says the group is not publicly
 * readable or not a group. */
export type RemoteGroupLoader = (homeHost: string, group: string) => Promise<ReadonlySet<string>>;

/** The longest one request to a group's host waits. */
const FETCH_TIMEOUT_MS = 5_000;

const NOBODY: ReadonlySet<string> = new Set();

/** The host answered, but not with something to keep: tried again after `refetchMs`. */
class TransientFailure extends Error {}

async function get(url: string): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  } catch (error) {
    throw new TransientFailure(error instanceof Error ? error.message : String(error));
  }
  if (response.ok) return response;
  // A refusal (the tree is private, unknown or gone) is the host's answer;
  // anything else, such as a 5xx, is an outage.
  if (response.status >= 400 && response.status < 500) return null;
  throw new TransientFailure(`${url} answered ${response.status}`);
}

/**
 * A publicly readable group's members at its host, read anonymously: the
 * tree's descriptor, then its root directory and root `_index.md`, each
 * object checked against its hash. The group is trusted to its host, over
 * HTTPS, as a placement host trusts a home host for device keys.
 */
export const fetchRemoteGroupMembers: RemoteGroupLoader = async (homeHost, group) => {
  const base = `${homeHost}/.arbor/trees/${encodeURIComponent(group)}`;
  const described = await get(base);
  if (!described) return NOBODY;
  const body = await described.json().catch(() => null) as { tree?: { id?: unknown; root?: unknown } } | null;
  const root = body?.tree?.root;
  if (body?.tree?.id !== group || typeof root !== "string" || !/^sha256:[a-f0-9]{64}$/.test(root)) {
    throw new TransientFailure(`${homeHost} described ${group} unreadably`);
  }
  const load = async (hash: ObjectHash): Promise<Uint8Array> => {
    const response = await get(`${base}/objects/${hash}`);
    if (!response) throw new TransientFailure(`${homeHost} did not serve an object of ${group}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (hashObject(bytes) !== hash) throw new TransientFailure(`${homeHost} served an object of ${group} that does not match its hash`);
    return bytes;
  };
  const directory = decodeProtocolDirectory(await load(root as ObjectHash));
  if (directory.type !== "directory") return NOBODY;
  const index = directory.entries.find((entry) => entry.name === "_index.md")?.file;
  if (!index) return NOBODY;
  const { frontmatter } = parseMarkdown(new TextDecoder().decode(await load(index)));
  if (frontmatter.type !== "group") return NOBODY;
  return new Set(structuredMembers(frontmatter.members).flatMap((member) => {
    const profile = profileLocatorTree(member.profile);
    return profile ? [profile] : [];
  }));
};

interface RemoteGroupCopy {
  fetchedAt: number;
  members: ReadonlySet<string>;
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((profile) => b.has(profile));
}

/**
 * This host's copies of groups other hosts hold (access control §3.3), in
 * memory only, by host and group. A copy serves for `lifetimeMs`; past that
 * it is refetched, and while its host cannot be read the copy still serves
 * until it is `staleMs` old, then matches nobody. A failed fetch is retried at
 * most once every `refetchMs` per group. `onChanged` runs whenever what a
 * copy matches changes, including when it runs out, so decisions made from
 * it are made again.
 */
export class RemoteGroups {
  private readonly copies = new Map<string, RemoteGroupCopy>();
  private readonly fetches = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  /** Copies that have run out since `onChanged` last said so. */
  private readonly expired = new Set<string>();

  constructor(
    private readonly lifetimes: () => RemoteGroupLifetimes,
    private readonly onChanged: () => void,
    private readonly load: RemoteGroupLoader = fetchRemoteGroupMembers,
  ) {}

  private static key(homeHost: string, group: string): string {
    return `${homeHost} ${group}`;
  }

  /**
   * Whether `profile` is a member, from the copy held: false without one, or
   * with one older than the grace. A missing or expired copy is fetched in
   * the background, so this never waits on another host.
   */
  isMember(group: string, homeHost: string, profile: string): boolean {
    const key = RemoteGroups.key(homeHost, group);
    const copy = this.copies.get(key);
    const now = Date.now();
    const { lifetimeMs, staleMs } = this.lifetimes();
    if (!copy || now - copy.fetchedAt >= lifetimeMs) void this.fetch(group, homeHost);
    return !!copy && now - copy.fetchedAt < staleMs && copy.members.has(profile);
  }

  /** Fetch one group now, unless a fetch is running or one failed within
   * `refetchMs`. Never throws: a failure keeps the copy held. */
  fetch(group: string, homeHost: string): Promise<void> {
    const key = RemoteGroups.key(homeHost, group);
    const running = this.fetches.get(key);
    if (running) return running;
    const failed = this.failures.get(key);
    if (failed !== undefined && Date.now() - failed < this.lifetimes().refetchMs) return Promise.resolve();
    const pending = (async () => {
      try {
        const members = await this.load(homeHost, group);
        this.failures.delete(key);
        const before = this.copies.get(key);
        const served = before && Date.now() - before.fetchedAt < this.lifetimes().staleMs ? before.members : NOBODY;
        this.copies.set(key, { fetchedAt: Date.now(), members });
        this.expired.delete(key);
        if (!sameMembers(served, members)) this.onChanged();
      } catch {
        this.failures.set(key, Date.now());
      }
    })().finally(() => this.fetches.delete(key));
    this.fetches.set(key, pending);
    return pending;
  }

  /** Fetch each named group this host holds no copy of yet, as soon as a
   * rule names it rather than at the next refresh. */
  async prefetch(named: Iterable<{ group: string; homeHost: string }>): Promise<void> {
    await Promise.all([...named].filter(({ group, homeHost }) => !this.copies.has(RemoteGroups.key(homeHost, group)))
      .map(({ group, homeHost }) => this.fetch(group, homeHost)));
  }

  /**
   * One refresh pass over the groups this host's rules name: each is
   * fetched, copies no rule names any more are dropped, and a copy that has
   * run out past the grace tells `onChanged` once.
   */
  async refresh(named: Iterable<{ group: string; homeHost: string }>): Promise<void> {
    const wanted = new Map<string, { group: string; homeHost: string }>();
    for (const subject of named) wanted.set(RemoteGroups.key(subject.homeHost, subject.group), subject);
    for (const key of [...this.copies.keys()]) {
      if (!wanted.has(key)) { this.copies.delete(key); this.expired.delete(key); this.failures.delete(key); }
    }
    await Promise.all([...wanted.values()].map(({ group, homeHost }) => this.fetch(group, homeHost)));
    const now = Date.now();
    const { staleMs } = this.lifetimes();
    let changed = false;
    for (const [key, copy] of this.copies) {
      if (now - copy.fetchedAt < staleMs || this.expired.has(key)) continue;
      this.expired.add(key);
      if (copy.members.size) changed = true;
    }
    if (changed) this.onChanged();
  }
}
