import { beforeEach, describe, expect, test } from "bun:test";
import { generateArborID } from "@overstory/protocol";
import { HomeHostUnavailableError } from "../../../packages/canopyd/src/errors.ts";
import { PlacementDeviceKeys, type DeviceKeyLifetimes } from "../../../packages/canopyd/src/placement.ts";

const PROFILE = "tr_profile";
const HOME = "https://home.example";
const KEY = "ed25519:iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w";
const mac = generateArborID("dv"), phone = generateArborID("dv");

let listed: string[];
let reachable: boolean;
let loads: number;
let lifetimes: DeviceKeyLifetimes;
let fetched: string[][];
let keys: PlacementDeviceKeys;

beforeEach(() => {
  listed = [mac];
  reachable = true;
  loads = 0;
  fetched = [];
  lifetimes = { lifetimeMs: 200, refetchMs: 100, staleMs: 200 };
  keys = new PlacementDeviceKeys(() => lifetimes, (_, copy) => fetched.push([...copy.devices.keys()]), async (home, profileTree) => {
    loads += 1;
    expect(home).toBe(HOME);
    if (!reachable) throw new Error("unreachable");
    return { profileTree, devices: listed.map((id) => ({ id, key: KEY, administrator: id === mac })) };
  });
});

describe("a placement host's copy of a home host's device keys (accounts §5.4)", () => {
  test("a copy serves for its lifetime, then is refetched", async () => {
    expect(await keys.device(PROFILE, HOME, mac)).toEqual({ key: KEY, administrator: true });
    expect(await keys.device(PROFILE, HOME, mac)).not.toBeNull();
    expect(loads).toBe(1);
    await Bun.sleep(lifetimes.lifetimeMs + 20);
    await keys.device(PROFILE, HOME, mac);
    expect(loads).toBe(2);
    expect(fetched).toEqual([[mac], [mac]]);
  });

  test("an unknown DeviceID waits out the interval and refetches once, so a device paired moments ago is found", async () => {
    await keys.device(PROFILE, HOME, mac);
    listed = [mac, phone];
    const started = Date.now();
    // Within the interval of the last fetch: it waits, then refetches once.
    const [first, second] = await Promise.all([keys.device(PROFILE, HOME, phone), keys.device(PROFILE, HOME, phone)]);
    expect(first).toEqual({ key: KEY, administrator: false });
    expect(second).toEqual(first);
    expect(Date.now() - started).toBeGreaterThanOrEqual(lifetimes.refetchMs - 20);
    expect(loads).toBe(2);
    // A DeviceID the home host does not list is still refused, one fetch per interval.
    const unknown = await Promise.all([keys.device(PROFILE, HOME, generateArborID("dv")), keys.device(PROFILE, HOME, generateArborID("dv"))]);
    expect(unknown).toEqual([null, null]);
    expect(loads).toBe(3);
  });

  test("an unreachable home host: the copy serves until the staleness limit, and failed fetches are not retried within the interval", async () => {
    lifetimes = { lifetimeMs: 100, refetchMs: 80, staleMs: 400 };
    await keys.device(PROFILE, HOME, mac);
    reachable = false;
    await Bun.sleep(lifetimes.lifetimeMs + 20);
    // Past its lifetime but within the staleness limit, the copy still serves.
    expect(await keys.device(PROFILE, HOME, mac)).not.toBeNull();
    expect(loads).toBe(2);
    for (let i = 0; i < 5; i++) await keys.device(PROFILE, HOME, mac);
    expect(loads).toBe(2);
    // A session opened from the copy ends when its grace does.
    expect(keys.servesUntil(PROFILE)).toBeLessThanOrEqual(Date.now() + lifetimes.staleMs);
    expect(keys.servesUntil("tr_other")).toBeNull();
    await Bun.sleep(lifetimes.staleMs);
    await expect(keys.device(PROFILE, HOME, mac)).rejects.toBeInstanceOf(HomeHostUnavailableError);
    await expect(keys.device(PROFILE, HOME, mac)).rejects.toBeInstanceOf(HomeHostUnavailableError);
    expect(loads).toBe(3);
    reachable = true;
    await Bun.sleep(lifetimes.refetchMs + 20);
    expect(await keys.device(PROFILE, HOME, mac)).not.toBeNull();
  });

  test("a list naming another profile, or malformed, is refused and not kept", async () => {
    const other = new PlacementDeviceKeys(() => lifetimes, () => {}, async () => ({ profileTree: "tr_other", devices: [] }));
    await expect(other.fetch(PROFILE, HOME)).rejects.toThrow("another profile");
    const malformed = new PlacementDeviceKeys(() => lifetimes, () => {}, async () => ({ profileTree: PROFILE, devices: [{ id: "dv_x", key: KEY, administrator: true }] }));
    await expect(malformed.fetch(PROFILE, HOME)).rejects.toThrow("malformed");
    await expect(malformed.current(PROFILE, HOME)).rejects.toBeInstanceOf(HomeHostUnavailableError);
  });
});
