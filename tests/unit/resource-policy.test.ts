import { describe, expect, test } from "bun:test";
import {
  intersectResourceRules,
  parseAppsYAML,
  safeResourceRule,
  parseResourceRule,
  parseResourceRules,
  rulesAllow,
  scopeContains,
} from "@overstory/protocol";
import { ExecutionAuthority } from "../../packages/canopyd/src/execution-authority.ts";
import fixtures from "../../docs/overstory-spec/conformance/resource-policy.json";

const LINK_DIGEST = `sha256:${"a".repeat(64)}`;

describe("resource policy contract", () => {
  test("shared positive and negative vectors", () => {
    for (const v of fixtures.valid)
      expect(parseResourceRule(v.rule), v.name).toEqual(v.rule as any);
    for (const v of fixtures.invalid)
      expect(() => parseResourceRule(v.rule), v.name).toThrow();
  });
  test("shared file vectors: merge keys and one home host per profile", () => {
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
  test("a profile subject may name the host holding a group's tree, which is where to look, not who", () => {
    const remote = { who: { profile: "tr_club", homeHost: "https://club.example" }, allow: ["read"] };
    expect(parseResourceRule(remote)).toEqual(remote as any);
    expect(parseResourceRule({ ...remote, who: { profile: "tr_club", homeHost: "http://127.0.0.1:4000" } }).who).toEqual({ profile: "tr_club", homeHost: "http://127.0.0.1:4000" });
    for (const homeHost of ["http://club.example", "https://club.example/", "https://club.example/~club", "club.example", 3]) {
      expect(() => parseResourceRule({ ...remote, who: { profile: "tr_club", homeHost } }), String(homeHost)).toThrow("Invalid rule subject");
    }
    expect(() => parseResourceRule({ ...remote, who: { link: LINK_DIGEST, homeHost: "https://club.example" } })).toThrow("Invalid rule subject");
    expect(() => parseResourceRule({ ...remote, who: { homeHost: "https://club.example" } })).toThrow("Invalid rule subject");
    // The TreeID alone is the merge key, and one file names one host per group.
    expect(() => parseResourceRules([remote, { who: { profile: "tr_club" }, allow: ["write"] }])).toThrow("Duplicate resource rule");
    expect(() => parseResourceRules([remote, { who: { profile: "tr_club" }, allow: ["write"], within: "/notes" }])).toThrow("disagree about its home host");
    expect(() => parseResourceRules([remote, { who: { profile: "tr_club", homeHost: "https://other.example" }, allow: ["write"], within: "/notes" }])).toThrow("disagree");
    expect(parseResourceRules([remote, { who: { profile: "tr_club", homeHost: "https://club.example" }, allow: ["write"], within: "/notes" }])).toHaveLength(2);
    // Matching hands the rule's home host to the membership check.
    const asked: unknown[] = [];
    expect(rulesAllow([parseResourceRule(remote)], { callerProfile: "tr_bob", isGroupMember: (...args) => { asked.push(args); return true; } }, "/", "read")).toBe(true);
    expect(asked).toEqual([["tr_club", "tr_bob", "https://club.example"]]);
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

test("safe policy projection redacts bearer link identity and keeps a home host", () => {
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

test("apps.yaml names one home host for a profile it lends to", async () => {
  const { parseAppsYAML } = await import("@overstory/protocol");
  const lend = (homeHost: string) => `  - resource: tr_calendar\n    who: { profile: tr_club, homeHost: "${homeHost}" }\n    allow: [read]\n`;
  const agreeing = `tr_planner:\n${lend("https://club.example")}tr_notes:\n${lend("https://club.example")}`;
  expect(parseAppsYAML(agreeing, "person").tr_planner![0]!.who).toEqual({ profile: "tr_club", homeHost: "https://club.example" });
  const disagreeing = `tr_planner:\n${lend("https://club.example")}tr_notes:\n${lend("https://other.example")}`;
  expect(() => parseAppsYAML(disagreeing, "person")).toThrow("disagree about its home host");
});
