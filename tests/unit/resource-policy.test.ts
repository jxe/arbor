import { describe, expect, test } from "bun:test";
import { parseProfileLocator, ruleLocators,
  intersectResourceRules,
  parseAppsYAML,
  safeResourceRule,
  parseResourceRule,
  parseResourceRules,
  rulesAllow,
  scopeContains,
} from "@ovst/protocol";
import { ExecutionAuthority } from "../../packages/overstoryd/src/execution-authority.ts";
import fixtures from "../../docs/overstory-spec/conformance/resource-policy.json";


describe("resource policy contract", () => {
  test("shared positive and negative vectors", () => {
    for (const v of fixtures.valid)
      expect(parseResourceRule(v.rule), v.name).toEqual(v.rule as any);
    for (const v of fixtures.invalid)
      expect(() => parseResourceRule(v.rule), v.name).toThrow();
  });
  test("shared locator vectors: a profile locator's canonical spelling and origin", () => {
    for (const v of fixtures.locators) expect(parseProfileLocator(v.input), v.input).toEqual({ locator: v.locator, origin: v.origin });
  });
  test("shared file vectors: merge keys", () => {
    // JSON is YAML, so an apps.yaml vector is its own source.
    const parse = (v: { access?: unknown; apps?: unknown }) =>
      v.access !== undefined ? parseResourceRules(v.access) : parseAppsYAML(JSON.stringify(v.apps), "person");
    for (const v of fixtures.validFiles) expect(() => parse(v), v.name).not.toThrow();
    for (const v of fixtures.invalidFiles) expect(() => parse(v), v.name).toThrow();
  });
  test("an app restriction is optional, and me and members name the apps.yaml owner", () => {
    const context = {
      ownerProfile: "tr_alice",
      callerProfile: "tr_bob",
      app: "tr_code",
    };
    expect(rulesAllow([{ who: "everyone", allow: ["read"] }], context, "/private", "read")).toBe(true);
    expect(rulesAllow([{ who: "me", allow: ["read"] }], context, "/", "read")).toBe(false);
    expect(rulesAllow([{ who: "me", allow: ["read"] }], { ...context, callerProfile: "tr_alice" }, "/", "read")).toBe(true);
    expect(rulesAllow([{ who: "members", allow: ["read"] }], { ...context, isGroupMember: (group, profile) => group === "tr_alice" && profile === "tr_bob" }, "/", "read")).toBe(true);
    expect(rulesAllow([{ who: "everyone", app: "tr_other", allow: ["read"] }], context, "/", "read")).toBe(false);
    expect(rulesAllow([{ who: "everyone", app: "tr_code", allow: ["read"] }], { ...context, app: undefined }, "/", "read")).toBe(false);
  });
  test("a profile another host holds is named by its locator there, which matches by the TreeID it is pinned to", () => {
    const remote = { who: { profile: "https://club.example/~club" }, allow: ["read"] };
    expect(parseResourceRule(remote)).toEqual(remote as any);
    // overstory:// is spelled as the HTTP locator it resolves through; loopback hosts may be plain HTTP.
    expect(parseResourceRule({ ...remote, who: { profile: "overstory://club.example/~club/" } }).who).toEqual({ profile: "https://club.example/~club" });
    expect(parseResourceRule({ ...remote, who: { profile: "http://127.0.0.1:4000/~club" } }).who).toEqual({ profile: "http://127.0.0.1:4000/~club" });
    for (const profile of ["http://club.example/~club", "https://club.example/", "https://club.example", "https://club.example/~club?x=1", "https://club.example/~club#top", "club.example/~club", "overstory://tr_club/", 3]) {
      expect(() => parseResourceRule({ ...remote, who: { profile } }), String(profile)).toThrow("Invalid rule subject");
    }
    expect(() => parseResourceRule({ ...remote, who: { profile: "https://club.example/~club", homeHost: "https://club.example" } })).toThrow("Invalid rule subject");
    // Its canonical spelling is the merge key.
    expect(() => parseResourceRules([remote, { who: { profile: "overstory://club.example/~club" }, allow: ["write"] }])).toThrow("Duplicate resource rule");
    expect(ruleLocators([remote, { who: { profile: "tr_club" }, allow: ["read"] } as any])).toEqual(["https://club.example/~club"]);
    // It matches by its pin, and its host is handed to the membership check.
    const asked: unknown[] = [];
    const isGroupMember = (...args: unknown[]) => { asked.push(args); return true; };
    const rule = parseResourceRule(remote);
    expect(rulesAllow([rule], { callerProfile: "tr_bob", isGroupMember }, "/", "read")).toBe(false);
    expect(rulesAllow([rule], { callerProfile: "tr_bob", isGroupMember, pinnedProfile: () => null }, "/", "read")).toBe(false);
    expect(asked).toEqual([]);
    expect(rulesAllow([rule], { callerProfile: "tr_bob", isGroupMember, pinnedProfile: (locator) => locator === "https://club.example/~club" ? "tr_club" : null }, "/", "read")).toBe(true);
    expect(asked).toEqual([["tr_club", "tr_bob", "https://club.example"]]);
    expect(rulesAllow([{ who: { profile: "https://club.example/~bob" }, allow: ["read"] }], { callerProfile: "tr_bob", pinnedProfile: () => "tr_bob" }, "/", "read")).toBe(true);
  });
  test("admin implies every operation and nothing else implies admin", () => {
    const admin = parseResourceRule({ who: { profile: "tr_bob" }, allow: ["admin"] });
    const writer = parseResourceRule({ who: { profile: "tr_bob" }, allow: ["write"] });
    const context = { callerProfile: "tr_bob" };
    expect(rulesAllow([admin], context, "/deep/path", "delete")).toBe(true);
    expect(rulesAllow([admin], context, "/", "admin")).toBe(true);
    expect(rulesAllow([writer], context, "/", "admin")).toBe(false);
  });
  test("scope boundaries and operation narrowing", () => {
    expect(scopeContains("/notes", "/notes/a")).toBe(true);
    expect(scopeContains("/notes", "/notes-other")).toBe(false);
    expect(() => scopeContains("/notes", "/notes/../private")).toThrow();
    const a = parseResourceRule({ who: "everyone", allow: ["write"] });
    const b = parseResourceRule({ who: "everyone", allow: ["read", "create-child"] });
    expect(intersectResourceRules(a, b)?.allow).toEqual([
      "read",
      "create-child",
    ]);
    expect(() => parseResourceRules([a, { ...b, within: "/" }])).toThrow();
  });
});

describe("opaque execution contexts", () => {
  test("captures requirements, isolates concurrent requests and rechecks revocation", async () => {
    let allowed = true;
    const authority = new ExecutionAuthority(() => allowed);
    const grant = {
      lender: null,
      tree: "tr_notes",
      within: "/notes",
      allow: ["create-child" as const],
    };
    const token = authority.issue({
      code: "tr_code",
      version: "v1",
      caller: "alice",
      subject: "profile:alice",
      expiresAt: Date.now() + 10000,
      grants: [grant],
      active: () => true,
    });
    grant.allow.push("read" as any);
    const context = authority.resolve(token)!;
    expect(
      await authority.run(context, async () => {
        await Promise.resolve();
        return authority.allows("tr_notes", "/notes", "create-child");
      })
    ).toBe(true);
    expect(authority.allows("tr_notes", "/notes", "create-child")).toBe(false);
    expect(
      authority.run(context, () =>
        authority.allows("tr_notes", "/notes", "read")
      )
    ).toBe(false);
    allowed = false;
    expect(
      authority.run(context, () =>
        authority.allows("tr_notes", "/notes", "create-child")
      )
    ).toBe(false);
    allowed = true;
    authority.revoke(token);
    expect(
      authority.run(context, () =>
        authority.allows("tr_notes", "/notes", "create-child")
      )
    ).toBe(false);
    expect(authority.resolve(token)).toBeUndefined();
    expect(authority.resolve("execution_forged")).toBeUndefined();
  });
});

test("safe policy projection redacts bearer link identity and keeps a locator", () => {
  for (const vector of fixtures.safe) expect<unknown>(safeResourceRule(parseResourceRule(vector.rule))).toEqual(vector.redacted);
});

test("a lapsed lender's grant cannot borrow identical caller coverage", () => {
  let lenderAllowed = true;
  const authority = new ExecutionAuthority((_context, grant) => grant.lender === null || lenderAllowed);
  const capability = { tree: "tr_notes", within: "/", allow: ["create-child" as const] };
  const token = authority.issue({ code: "tr_code", version: "v1", caller: "tr_user", subject: "user",
    expiresAt: Date.now() + 10000, active: () => true, grants: [
      { ...capability, lender: "tr_lender" }, { ...capability, lender: null },
    ] });
  const context = authority.resolve(token)!;
  expect(authority.covered(context)).toBe(true);
  lenderAllowed = false;
  expect(authority.covered(context)).toBe(false);
  expect(authority.run(context, () => authority.canSubmit("tr_notes"))).toBe(false);
});

test("apps.yaml may lend to a profile another host holds, by its locator", async () => {
  const { parseAppsYAML } = await import("@ovst/protocol");
  const source = `tr_planner:\n  - resource: tr_calendar\n    who: { profile: "https://club.example/~club" }\n    allow: [read]\n`;
  expect(parseAppsYAML(source, "person").tr_planner![0]!.who).toEqual({ profile: "https://club.example/~club" });
  expect(() => parseAppsYAML(source.replace('"https://club.example/~club"', 'tr_club, homeHost: "https://club.example"'), "person")).toThrow();
});
