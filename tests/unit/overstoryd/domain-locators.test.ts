import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { domainTXTName, parseDomainTXT, parseDomainWellKnown, profileDomains, resolveDomainDelegation, type DomainLookups } from "@ovst/protocol";
import { domainProfileResolver, LocatorPins } from "../../../packages/overstoryd/src/locator-pins.ts";

/**
 * Domain locators (locators §1.1): `https://alice.example` names Alice's
 * profile when the domain's records name her locator at her home host and
 * her profile's root front matter lists the domain back.
 */

const ALICE = "tr_" + "a".repeat(52);
const OTHER = "tr_" + "b".repeat(52);
const GARDEN = "https://garden.example";
const ORCHARD = "https://orchard.example";
const DOMAIN = "https://alice.example";

let txt: Map<string, string[] | Error>;
let wellKnown: Map<string, unknown>;
const lookups: DomainLookups = {
  async resolveTXT(name) {
    const records = txt.get(name) ?? [];
    if (records instanceof Error) throw records;
    return records;
  },
  async fetchWellKnown(origin) {
    const body = wellKnown.get(origin);
    if (body instanceof Error) throw body;
    return body ?? null;
  },
};
/** Each home locator's profile, and each profile's root front matter at its home host. */
let profiles: Map<string, string | null>;
let roots: Map<string, Record<string, unknown> | null>;
const resolver = domainProfileResolver(
  async (locator) => profiles.get(locator) ?? null,
  lookups,
  async (origin, tree) => roots.get(`${origin} ${tree}`) ?? null,
);

beforeEach(() => {
  txt = new Map([["_overstory.alice.example", [`profile=${GARDEN}/~alice`, "v=spf1 -all"]]]);
  wellKnown = new Map();
  profiles = new Map([[`${GARDEN}/~alice`, ALICE], [`${ORCHARD}/~alice`, ALICE]]);
  roots = new Map([
    [`${GARDEN} ${ALICE}`, { type: "person", domains: ["alice.example"] }],
    [`${ORCHARD} ${ALICE}`, { type: "person", domains: "alice.example" }],
  ]);
});

describe("records", () => {
  test("the TXT name, the TXT record and the well-known file", () => {
    expect(domainTXTName("alice.example")).toBe("_overstory.alice.example");
    expect(domainTXTName("127.0.0.1:4000")).toBe("_overstory.127.0.0.1");
    expect(parseDomainTXT(`profile=overstory://garden.example/~alice/`)).toBe(`${GARDEN}/~alice`);
    expect(parseDomainTXT(`profile=https://bob.example`)).toBeNull();
    expect(parseDomainTXT(`profile=`)).toBeNull();
    expect(parseDomainWellKnown({ profile: `${GARDEN}/~alice`, profileTree: ALICE })).toBe(`${GARDEN}/~alice`);
    expect(parseDomainWellKnown([`${GARDEN}/~alice`])).toBeNull();
  });

  test("the domains a profile claims, as written", () => {
    expect(profileDomains({ domains: ["alice.example", "Alice.example", "https://x.example", "a.example/x", 3, "alice.example"] })).toEqual(["alice.example"]);
    expect(profileDomains({ domains: "alice.example" })).toEqual(["alice.example"]);
    expect(profileDomains({})).toEqual([]);
  });

  test("the TXT record and the well-known file must agree", async () => {
    expect(await resolveDomainDelegation(DOMAIN, lookups)).toBe(`${GARDEN}/~alice`);
    wellKnown.set(DOMAIN, { profile: `${GARDEN}/~alice` });
    expect(await resolveDomainDelegation(DOMAIN, lookups)).toBe(`${GARDEN}/~alice`);
    wellKnown.set(DOMAIN, { profile: `${ORCHARD}/~alice` });
    expect(await resolveDomainDelegation(DOMAIN, lookups)).toBeNull();
    // Either alone is enough; an outage of one leaves the other.
    txt.set("_overstory.alice.example", new Error("SERVFAIL"));
    expect(await resolveDomainDelegation(DOMAIN, lookups)).toBe(`${ORCHARD}/~alice`);
    wellKnown.set(DOMAIN, new Error("down"));
    await expect(resolveDomainDelegation(DOMAIN, lookups)).rejects.toThrow("SERVFAIL");
    // A malformed record names nobody, as does no record at all.
    txt.set("_overstory.alice.example", ["profile=not a locator"]);
    wellKnown.delete(DOMAIN);
    expect(await resolveDomainDelegation(DOMAIN, lookups)).toBeNull();
    txt.delete("_overstory.alice.example");
    expect(await resolveDomainDelegation(DOMAIN, lookups)).toBeNull();
  });
});

describe("both directions", () => {
  test("a domain names the profile its records name only when that profile names it back", async () => {
    expect(await resolver(DOMAIN, "alice.example")).toEqual({ profile: ALICE, home: GARDEN });
    roots.set(`${GARDEN} ${ALICE}`, { type: "person", domains: ["other.example"] });
    expect(await resolver(DOMAIN, "alice.example")).toBeNull();
    roots.set(`${GARDEN} ${ALICE}`, { type: "group", domains: ["alice.example"] });
    expect(await resolver(DOMAIN, "alice.example")).toBeNull();
    roots.delete(`${GARDEN} ${ALICE}`);
    expect(await resolver(DOMAIN, "alice.example")).toBeNull();
  });

  test("a home locator that names no person profile names nobody", async () => {
    profiles.set(`${GARDEN}/~alice`, null);
    expect(await resolver(DOMAIN, "alice.example")).toBeNull();
    profiles.set(`${GARDEN}/~alice`, "tr_short");
    expect(await resolver(DOMAIN, "alice.example")).toBeNull();
  });
});

describe("pins", () => {
  let db: Database;
  let pins: LocatorPins;
  let changes: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(`CREATE TABLE profile_locator_pins (tree_id TEXT NOT NULL, locator TEXT NOT NULL, profile_tree TEXT NOT NULL, PRIMARY KEY(tree_id, locator))`);
    changes = 0;
    pins = new LocatorPins(db, () => ({ lifetimeMs: 0, refetchMs: 0, staleMs: 60_000 }), () => { changes += 1; },
      async (locator) => profiles.get(locator) ?? null, resolver);
  });

  async function accept(tree: string, locators: string[]) {
    const fresh = await pins.prepare(tree, locators);
    db.transaction(() => pins.write(tree, fresh, locators))();
  }

  test("a domain pins the profile it names, and follows it to a new home host", async () => {
    expect(pins.home(DOMAIN)).toBeNull();
    await accept("tr_trip", [DOMAIN]);
    expect(pins.pinned("tr_trip", DOMAIN)).toBe(ALICE);
    expect(pins.home(DOMAIN)).toBe(GARDEN);
    expect(pins.home(`${GARDEN}/~alice`)).toBe(GARDEN);
    // Alice moves to Orchard and points her domain there: same TreeID, new home.
    txt.set("_overstory.alice.example", [`profile=${ORCHARD}/~alice`]);
    await pins.refresh();
    expect(changes).toBe(1);
    expect(pins.pinned("tr_trip", DOMAIN)).toBe(ALICE);
    expect(pins.home(DOMAIN)).toBe(ORCHARD);
    // Someone else takes the domain: it names nobody until accepted afresh.
    profiles.set(`${ORCHARD}/~alice`, OTHER);
    roots.set(`${ORCHARD} ${OTHER}`, { type: "person", domains: ["alice.example"] });
    await pins.refresh();
    expect(pins.pinned("tr_trip", DOMAIN)).toBeNull();
  });

  test("a domain whose profile does not name it back refuses the accept", async () => {
    roots.set(`${GARDEN} ${ALICE}`, { type: "person" });
    await expect(pins.prepare("tr_trip", [DOMAIN])).rejects.toThrow("does not name a profile that names it back");
    txt.set("_overstory.alice.example", new Error("SERVFAIL"));
    await expect(pins.prepare("tr_trip", [DOMAIN])).rejects.toMatchObject({ homeHost: DOMAIN });
  });
});
