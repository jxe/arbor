import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { AccessControl } from "../../../packages/canopyd/src/access.ts";
import type {
  ExecutionContext,
  ExecutionGrant,
} from "../../../packages/canopyd/src/execution-authority.ts";
import type { CanopyTree } from "../../../packages/canopyd/src/model.ts";

test("author/user contributions are bounded by caller rules and nonrecursive underlying access", () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE TABLE accounts(id TEXT PRIMARY KEY, profile_tree TEXT, handle TEXT, enabled INTEGER)"
    );
    db.run(
      "CREATE TABLE resource_policy(account_id TEXT, tree_id TEXT, rules_json TEXT)"
    );
    db.run(
      "CREATE TABLE access(id TEXT PRIMARY KEY, tree_id TEXT, subject_kind TEXT, subject TEXT, access TEXT)"
    );
    db.run(
      "INSERT INTO accounts VALUES ('owner','tr_owner','owner',1),('user','tr_user','user',1)"
    );
    const tree = {
      id: "tr_data",
      accountID: "owner",
      policy: "ordinary",
      publicAccess: "none",
    } as CanopyTree;
    const access = new AccessControl(db, {
      tree: () => tree,
      rootProfileType: () => null,
      isProfileMember: () => false,
    });
    const context: ExecutionContext = {
      code: "tr_code",
      version: "v1",
      caller: "user",
      sponsor: "owner",
      subject: "user",
      expiresAt: Date.now() + 10000,
      grants: [],
      active: () => true,
    };
    const grant: ExecutionGrant = {
      account: "owner",
      role: "author",
      tree: "tr_data",
      within: "/notes",
      allow: ["read"],
    };
    expect(access.executionAllows(context, grant, "/notes", "read")).toBe(
      false
    );
    const set = (account: string, rules: unknown[]) => {
      db.run("DELETE FROM resource_policy WHERE account_id=?", [account]);
      db.run("INSERT INTO resource_policy VALUES (?, 'tr_data', ?)", [
        account,
        JSON.stringify(rules),
      ]);
    };
    set("owner", [
      { who: "everyone", via: "tr_code", within: "/notes", allow: ["read"] },
    ]);
    expect(access.executionAllows(context, grant, "/notes/a", "read")).toBe(
      true
    );
    expect(access.executionAllows(context, grant, "/notes-other", "read")).toBe(
      false
    );
    expect(
      access.executionAllows(
        { ...context, code: "tr_other" },
        grant,
        "/notes",
        "read"
      )
    ).toBe(false);
    set("user", [{ who: "everyone", via: "tr_code", allow: ["write"] }]);
    const delegated = {
      ...grant,
      account: "user",
      role: "author" as const,
      allow: ["write" as const],
    };
    expect(
      access.executionAllows(
        { ...context, sponsor: "user", caller: null },
        delegated,
        "/notes",
        "write"
      )
    ).toBe(false);
    set("owner", [{ who: { profile: "tr_user" }, allow: ["write"] }]);
    expect(
      access.executionAllows(
        { ...context, sponsor: "user", caller: null },
        delegated,
        "/notes",
        "write"
      )
    ).toBe(true);
    set("owner", []);
    expect(
      access.executionAllows(
        { ...context, sponsor: "user", caller: null },
        delegated,
        "/notes",
        "write"
      )
    ).toBe(false);
    set("owner", [{ who: "everyone", allow: ["read"] }]);
    expect(
      access.executionAllows(
        { ...context, caller: null },
        grant,
        "/notes",
        "read"
      )
    ).toBe(true);
  } finally {
    db.close();
  }
});
