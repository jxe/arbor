import { describe, expect, test } from "bun:test";
import {
  intersectResourceRules,
  safeResourceRule,
  parseResourceRule,
  parseResourceRules,
  rulesAllow,
  scopeContains,
} from "@overstory/protocol";
import { ExecutionAuthority } from "../../packages/canopyd/src/execution-authority.ts";
import fixtures from "../../docs/overstory-spec/conformance/resource-policy.json";

describe("resource policy contract", () => {
  test("shared positive and negative vectors", () => {
    for (const v of fixtures.valid)
      expect(parseResourceRule(v.rule), v.name).toEqual(v.rule as any);
    for (const v of fixtures.invalid)
      expect(() => parseResourceRule(v.rule), v.name).toThrow();
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

test("safe policy projection redacts bearer link identity", () => {
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
