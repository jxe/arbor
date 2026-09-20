import { describe, expect, test } from "bun:test";
import {
  intersectResourceRules,
  safeResourceRule,
  parseResourceRule,
  parseResourceRules,
  rulesAllow,
  scopeContains,
} from "@overstory/protocol";
import { parseResourceConfiguration } from "../../packages/protocol/src/config/resource-configuration.ts";
import { ExecutionAuthority } from "../../packages/canopyd/src/execution-authority.ts";
import fixtures from "../../spec/conformance/resource-policy.json";

describe("resource policy contract", () => {
  test("shared positive and negative vectors", () => {
    for (const v of fixtures.valid)
      expect(parseResourceRule(v.rule), v.name).toEqual(v.rule as any);
    for (const v of fixtures.invalid)
      expect(() => parseResourceRule(v.rule), v.name).toThrow();
  });
  test("code restriction is optional and me is the policy owner", () => {
    const context = {
      ownerProfile: "tr_alice",
      callerProfile: "tr_bob",
      via: "tr_code",
    };
    expect(
      rulesAllow(
        [{ who: "everyone", allow: ["read"] }],
        context,
        "/private",
        "read"
      )
    ).toBe(true);
    expect(
      rulesAllow([{ who: "me", allow: ["read"] }], context, "/", "read")
    ).toBe(false);
    expect(
      rulesAllow(
        [{ who: "everyone", via: "tr_other", allow: ["read"] }],
        context,
        "/",
        "read"
      )
    ).toBe(false);
    expect(
      rulesAllow(
        [{ who: "everyone", via: "tr_code", allow: ["read"] }],
        { ...context, via: undefined },
        "/",
        "read"
      )
    ).toBe(false);
  });
  test("scope boundaries and operation narrowing", () => {
    expect(scopeContains("/notes", "/notes/a")).toBe(true);
    expect(scopeContains("/notes", "/notes-other")).toBe(false);
    expect(() => scopeContains("/notes", "/notes/../private")).toThrow();
    const a = parseResourceRule({ who: "me", allow: ["write"] });
    const b = parseResourceRule({ who: "me", allow: ["read", "create-child"] });
    expect(intersectResourceRules(a, b)?.allow).toEqual([
      "read",
      "create-child",
    ]);
    expect(() => parseResourceRules([a, { ...b, within: "/" }])).toThrow();
  });
  test("resource-only declarations do not invent hosting and aliases are rejected", () => {
    const account = { canopy: "https://example.org", profile: "tr_alice" };
    expect(
      parseResourceConfiguration(
        "tr_notes:\n  access:\n    - who: me\n      via: tr_code\n      allow: [create-child]\n",
        account
      ).tr_notes?.canonical
    ).toBeUndefined();
    expect(() =>
      parseResourceConfiguration(
        "tr_notes: &a {access: []}\ntr_other: *a",
        account
      )
    ).toThrow();
  });
});

describe("opaque execution contexts", () => {
  test("captures requirements, isolates concurrent requests and rechecks revocation", async () => {
    let allowed = true;
    const authority = new ExecutionAuthority(() => allowed);
    const grant = {
      account: "alice",
      role: "user" as const,
      tree: "tr_notes",
      within: "/notes",
      allow: ["create-child" as const],
    };
    const token = authority.issue({
      code: "tr_code",
      version: "v1",
      caller: "alice",
      sponsor: "author",
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

test("revoked author requirements cannot borrow identical user coverage", () => {
  let authorAllowed = true;
  const authority = new ExecutionAuthority((_context, grant) => grant.role === "user" || authorAllowed);
  const capability = { tree: "tr_notes", within: "/", allow: ["create-child" as const] };
  const token = authority.issue({ code: "tr_code", version: "v1", caller: "user", sponsor: "author", subject: "user",
    expiresAt: Date.now() + 10000, active: () => true, grants: [
      { ...capability, role: "author", account: "author" }, { ...capability, role: "user", account: "user" },
    ] });
  const context = authority.resolve(token)!;
  expect(authority.covered(context)).toBe(true);
  authorAllowed = false;
  expect(authority.covered(context)).toBe(false);
  expect(authority.run(context, () => authority.canSubmit("tr_notes"))).toBe(false);
});
