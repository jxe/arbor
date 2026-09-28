import { decodePublishedDeviceKeys } from "@overstory/protocol";
import { HomeHostUnavailableError } from "./errors.ts";

/** A device a home host lists for a profile, as a placement host reads it. */
export interface ListedDevice {
  key: string;
  administrator: boolean;
}

/** One fetched copy of a profile's published device keys. */
export interface DeviceKeyCopy {
  fetchedAt: number;
  devices: ReadonlyMap<string, ListedDevice>;
}

/**
 * A placement host's device-key lifetimes (accounts §5.4). `lifetimeMs` is
 * how long a copy serves before it is refetched; `refetchMs` how soon after
 * one fetch of a profile's keys another may begin early, for a DeviceID the
 * copy lacks or after a fetch that failed; `staleMs`, the grace, the age past
 * which a copy the host cannot refresh opens no session.
 */
export interface DeviceKeyLifetimes {
  lifetimeMs: number;
  refetchMs: number;
  staleMs: number;
}

/** Reads a home host's published device keys: the JSON body, or a throw. */
export type DeviceKeyLoader = (homeHost: string, profileTree: string) => Promise<unknown>;

/** The longest one fetch of a home host's device keys waits. */
const FETCH_TIMEOUT_MS = 5_000;

/** The published device-keys route (accounts §5.4), read over HTTPS without following redirects. */
export const fetchPublishedDeviceKeys: DeviceKeyLoader = async (homeHost, profileTree) => {
  const response = await fetch(`${homeHost}/.arbor/profiles/${encodeURIComponent(profileTree)}/device-keys`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`${homeHost} answered ${response.status} for the profile's device keys`);
  return response.json();
};

/** A published device-key list, checked before a placement host trusts any of it. */
function validPublishedKeys(value: unknown, profileTree: string): Map<string, ListedDevice> {
  return new Map(decodePublishedDeviceKeys(value, profileTree).devices.map((entry) => [entry.id, { key: entry.key, administrator: entry.administrator }]));
}

/**
 * A placement host's copies of the device keys home hosts publish (accounts
 * §5.4), in memory only, by profile. A copy serves for `lifetimeMs`; past
 * that it is refetched, and if the home host cannot be read the copy still
 * serves until it is `staleMs` old (the grace), then nothing is served from
 * it. A
 * DeviceID missing from a copy refetches it early (waiting out the window
 * rather than refusing), and a failed fetch is retried, at most once every
 * `refetchMs` per profile, so nobody can use
 * this host to flood a home host. Every successful fetch is handed to
 * `onFetched`, which ends what a device no longer listed held.
 */
export class PlacementDeviceKeys {
  private readonly copies = new Map<string, DeviceKeyCopy>();
  private readonly fetches = new Map<string, Promise<DeviceKeyCopy>>();
  /** When each profile's last fetch began, and whether it failed. */
  private readonly attempts = new Map<string, { at: number; failed: boolean }>();

  constructor(
    private readonly lifetimes: () => DeviceKeyLifetimes,
    private readonly onFetched: (profileTree: string, copy: DeviceKeyCopy) => void,
    private readonly load: DeviceKeyLoader = fetchPublishedDeviceKeys,
  ) {}

  /** Fetch a profile's device keys from its home host now; throws when they cannot be read. */
  fetch(profileTree: string, homeHost: string): Promise<DeviceKeyCopy> {
    let pending = this.fetches.get(profileTree);
    if (!pending) {
      const attempt = { at: Date.now(), failed: true };
      this.attempts.set(profileTree, attempt);
      pending = (async () => {
        const copy: DeviceKeyCopy = { fetchedAt: Date.now(), devices: validPublishedKeys(await this.load(homeHost, profileTree), profileTree) };
        attempt.failed = false;
        this.copies.set(profileTree, copy);
        this.onFetched(profileTree, copy);
        return copy;
      })().finally(() => this.fetches.delete(profileTree));
      this.fetches.set(profileTree, pending);
    }
    return pending;
  }

  /** Whether the last fetch of a profile's keys began within `refetchMs`. */
  private recentlyFetched(profileTree: string, now: number): boolean {
    const last = this.attempts.get(profileTree);
    return !!last && now - last.at < this.lifetimes().refetchMs;
  }

  /**
   * A copy that may open a session: one within its lifetime as held, else a
   * fresh fetch, else, while the home host cannot be read, the copy held if
   * it is younger than the staleness limit. A fetch that failed is not
   * retried within `refetchMs`.
   */
  async current(profileTree: string, homeHost: string): Promise<DeviceKeyCopy> {
    const now = Date.now();
    const held = this.copies.get(profileTree);
    const { lifetimeMs, staleMs } = this.lifetimes();
    if (held && now - held.fetchedAt < lifetimeMs) return held;
    let failure: unknown;
    const last = this.attempts.get(profileTree);
    if (!this.fetches.has(profileTree) && last?.failed && this.recentlyFetched(profileTree, now)) {
      failure = new Error("its last fetch failed moments ago");
    } else {
      try {
        return await this.fetch(profileTree, homeHost);
      } catch (error) {
        failure = error;
      }
    }
    const kept = this.copies.get(profileTree);
    if (kept && Date.now() - kept.fetchedAt < staleMs) return kept;
    throw new HomeHostUnavailableError(homeHost, `The profile's home host ${homeHost} cannot be read for its device keys, and this host's copy is too old to open a session: ${failure instanceof Error ? failure.message : String(failure)}`);
  }

  /** When the copy held of a profile's keys runs out of grace, or null
   * without one. A session opened from it ends by then. */
  servesUntil(profileTree: string): number | null {
    const held = this.copies.get(profileTree);
    return held ? held.fetchedAt + this.lifetimes().staleMs : null;
  }

  /**
   * A listed device, from a copy `current` accepts. A DeviceID the copy
   * lacks refetches it once. Within `refetchMs` of the profile's last fetch
   * that refetch waits for the window to pass rather than refusing, so a
   * device paired at the home moments ago is found while the home host is
   * still asked at most once per window; waiters share the one fetch.
   */
  async device(profileTree: string, homeHost: string, deviceID: string): Promise<ListedDevice | null> {
    const copy = await this.current(profileTree, homeHost);
    const listed = copy.devices.get(deviceID);
    if (listed) return listed;
    const last = this.attempts.get(profileTree);
    const wait = last ? last.at + this.lifetimes().refetchMs - Date.now() : 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      // A fetch that began while this one waited answers it too.
      const since = this.attempts.get(profileTree);
      const fresh = since !== last && since && !since.failed && !this.fetches.has(profileTree)
        ? this.copies.get(profileTree)
        : await this.fetch(profileTree, homeHost);
      return fresh?.devices.get(deviceID) ?? null;
    } catch {
      // The copy held still serves; an early refetch that fails changes nothing.
      return null;
    }
  }
}
