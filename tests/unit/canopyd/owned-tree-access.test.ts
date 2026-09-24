import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ObjectHash } from "@overstory/protocol";
import { AccessControl, type AccessHost } from "../../../packages/canopyd/src/access.ts";
import type { HostAccount, HostTree } from "../../../packages/canopyd/src/model.ts";
import { createHostSchema } from "../../../packages/canopyd/src/schema.ts";

const ROOT = `sha256:${"a".repeat(64)}` as ObjectHash;
const LINK = `sha256:${"b".repeat(64)}`;

function tree(id: string, accountID: string | null): HostTree {
  return { id, canonicalPath: `/${id}`, parentTree: null, kind: "ordinary", ref: ROOT, publicAccess: "none", policy: "ordinary", status: "active", accountID };
}
const account = (id: string, profileTree: string): HostAccount => ({ id, handle: id.slice(3), profileTree, configTree: null, enabled: true });
const owner = account("ac_owner", "tr_owner"), bob = account("ac_bob", "tr_bob"), carol = account("ac_carol", "tr_carol");
const trees = new Map([["tr_owned", tree("tr_owned", "ac_owner")], ["tr_unowned", tree("tr_unowned", null)]]);
const host: AccessHost = { tree: (id) => trees.get(id) ?? null, isProfileMember: () => false, rootProfileType: () => null };

describe("an owned tree is governed by its owner's rules alone", () => {
  let db: Database;
  let access: AccessControl;

  beforeEach(() => {
    db = new Database(":memory:");
    createHostSchema(db);
    for (const a of [owner, bob, carol]) db.run("INSERT INTO accounts (id, handle, profile_tree, enabled) VALUES (?, ?, ?, 1)", [a.id, a.handle, a.profileTree]);
    db.run("INSERT INTO resource_policy (account_id, tree_id, rules_json) VALUES ('ac_owner', 'tr_owned', ?)", [JSON.stringify([
      { who: { profile: "tr_bob" }, allow: ["read", "write"] },
      { who: { link: LINK }, allow: ["read"] },
      { who: { profile: "tr_carol" }, allow: ["read"], within: "/notes" },
    ])]);
    access = new AccessControl(db, host);
  });

  test("stored access entries of an owned tree grant nothing", () => {
    access.set("tr_owned", "profile", "tr_carol", "write");
    access.set("tr_owned", "everyone", "everyone", "read");
    expect(access.canRead(carol, "tr_owned")).toBe(false);
    expect(access.canWrite(carol, "tr_owned")).toBe(false);
    expect(access.canRead(bob, "tr_owned")).toBe(true);
    expect(access.canWrite(bob, "tr_owned")).toBe(true);
    expect(access.canRead(null, "tr_owned", LINK)).toBe(true);
    expect(access.canWrite(null, "tr_owned", LINK)).toBe(false);
  });

  test("only the owner administers an owned tree; an unowned tree keeps its stored writers", () => {
    expect(access.canAdminister(owner, "tr_owned")).toBe(true);
    expect(access.canAdminister(bob, "tr_owned")).toBe(false);
    access.set("tr_unowned", "profile", "tr_bob", "write");
    expect(access.canAdminister(bob, "tr_unowned")).toBe(true);
    expect(access.canWrite(bob, "tr_unowned")).toBe(true);
  });

  test("an owned tree's entries are its whole-tree rules, with stable ids", () => {
    const entries = access.entries("tr_owned");
    expect(entries.map(({ subjectKind, subject, access }) => ({ subjectKind, subject, access }))).toEqual([
      { subjectKind: "profile", subject: "tr_bob", access: "write" },
      { subjectKind: "link", subject: LINK, access: "read" },
    ]);
    expect(access.entries("tr_owned").map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });

  test("the rules outlive the owner being disabled", () => {
    db.run("UPDATE accounts SET enabled = 0 WHERE id = 'ac_owner'");
    expect(access.canRead(bob, "tr_owned")).toBe(true);
  });
});
