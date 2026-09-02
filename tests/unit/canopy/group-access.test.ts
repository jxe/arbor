import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ObjectHash } from "@arbor/wire";
import { AccessControl, type AccessHost } from "../../../packages/canopy/src/access.ts";
import type { CanopyAccount, CanopyTree } from "../../../packages/canopy/src/model.ts";

const ROOT = `sha256:${"a".repeat(64)}` as ObjectHash;

function tree(id: string, canonicalPath: string): CanopyTree {
  return {
    id, canonicalPath, parentTree: null, kind: "ordinary", ref: ROOT, publicAccess: "none",
    updatedAt: 1, policy: "ordinary", status: "active", accountID: null,
  };
}

const bob: CanopyAccount = { id: "ac_bob", handle: "bob", profileTree: "tr_bob", configTree: null, enabled: true };

/**
 * Three ACL subjects, each listing bob as a member: a group profile, a person
 * profile that merely added a `members:` list, and a tree whose root declares
 * no profile type at all. Only the group may widen bob's access.
 */
const trees = new Map([
  ["tr_shared", tree("tr_shared", "/~owner/shared")],
  ["tr_bob", tree("tr_bob", "/~bob")],
  ["tr_group", tree("tr_group", "/~editors")],
  ["tr_person", tree("tr_person", "/~mallory")],
  ["tr_untyped", tree("tr_untyped", "/~owner/notes")],
]);
const profileTypes = new Map<string, "person" | "group" | null>([
  ["tr_group", "group"], ["tr_person", "person"], ["tr_bob", "person"], ["tr_untyped", null],
]);
const host: AccessHost = {
  tree: (id) => trees.get(id) ?? null,
  profileMemberHandles: (id) => new Set(["tr_group", "tr_person", "tr_untyped"].includes(id) ? ["bob"] : []),
  rootProfileType: (id) => profileTypes.get(id) ?? null,
};

describe("group ACL expansion is gated on the subject root's type: group", () => {
  let db: Database;
  let access: AccessControl;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(`CREATE TABLE access (
      id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject TEXT NOT NULL,
      access TEXT NOT NULL, claimed_profile TEXT, UNIQUE(tree_id, subject_kind, subject)
    )`);
    access = new AccessControl(db, host);
  });

  test("a person profile naming bob in members does not widen bob's access", () => {
    access.set("tr_shared", "profile", "tr_person", "write");
    expect(access.canRead(bob, "tr_shared")).toBe(false);
    expect(access.canWrite(bob, "tr_shared")).toBe(false);
  });

  test("a root without a profile type does not widen access either", () => {
    access.set("tr_shared", "profile", "tr_untyped", "write");
    expect(access.canRead(bob, "tr_shared")).toBe(false);
    expect(access.canWrite(bob, "tr_shared")).toBe(false);
  });

  test("a group profile expands membership to the granted level", () => {
    access.set("tr_shared", "profile", "tr_group", "read");
    expect(access.canRead(bob, "tr_shared")).toBe(true);
    expect(access.canWrite(bob, "tr_shared")).toBe(false);
    access.set("tr_shared", "profile", "tr_group", "write");
    expect(access.canWrite(bob, "tr_shared")).toBe(true);
  });

  test("direct profile grants and the account's own profile tree need no kind", () => {
    access.set("tr_shared", "profile", "tr_bob", "read");
    expect(access.canRead(bob, "tr_shared")).toBe(true);
    expect(access.canAdminister(bob, "tr_bob")).toBe(true);
    expect(access.canAdminister(bob, "tr_shared")).toBe(false);
  });
});
