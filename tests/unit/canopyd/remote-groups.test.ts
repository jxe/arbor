import { beforeEach, describe, expect, test } from "bun:test";
import { RemoteGroups, type RemoteGroupLifetimes } from "../../../packages/canopyd/src/remote-groups.ts";

const GROUP = "tr_club";
const HOST = "https://club.example";

let members: string[];
let reachable: boolean;
let loads: number;
let changes: number;
let lifetimes: RemoteGroupLifetimes;
let groups: RemoteGroups;

beforeEach(() => {
  members = ["tr_alice"];
  reachable = true;
  loads = 0;
  changes = 0;
  lifetimes = { lifetimeMs: 200, refetchMs: 100, staleMs: 600 };
  groups = new RemoteGroups(() => lifetimes, () => { changes += 1; }, async (host, group) => {
    loads += 1;
    expect([host, group]).toEqual([HOST, GROUP]);
    if (!reachable) throw new Error("unreachable");
    return new Set(members);
  });
});

describe("a host's copy of a group another host holds (access control §3.3)", () => {
  test("without a copy nobody matches, and a fetch begins in the background", async () => {
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(false);
    await groups.prefetch([{ group: GROUP, homeHost: HOST }]);
    expect(loads).toBe(1);
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(true);
    expect(groups.isMember(GROUP, HOST, "tr_bob")).toBe(false);
    expect(changes).toBe(1);
  });

  test("a refresh sees a member removed, and reports the change", async () => {
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(true);
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(changes).toBe(1);
    members = [];
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(false);
    expect(changes).toBe(2);
  });

  test("an unreachable host: the copy serves through the grace, then matches nobody; failed fetches wait their interval", async () => {
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    reachable = false;
    await Bun.sleep(lifetimes.lifetimeMs + 20);
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(loads).toBe(2);
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(true);
    for (let i = 0; i < 5; i++) await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(loads).toBe(2);
    await Bun.sleep(lifetimes.staleMs);
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(false);
    // Running out is reported once.
    expect(changes).toBe(2);
    await Bun.sleep(lifetimes.refetchMs + 20);
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(changes).toBe(2);
    reachable = true;
    await Bun.sleep(lifetimes.refetchMs + 20);
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(true);
    expect(changes).toBe(3);
  });

  test("a group no rule names any more is forgotten", async () => {
    await groups.refresh([{ group: GROUP, homeHost: HOST }]);
    await groups.refresh([]);
    expect(groups.isMember(GROUP, HOST, "tr_alice")).toBe(false);
  });
});
