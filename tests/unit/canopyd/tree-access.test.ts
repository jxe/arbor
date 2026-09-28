import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppAccessRule, ObjectHash, ResourceAccessRule } from "@overstory/protocol";
import { AccessControl, type AccessHost } from "../../../packages/canopyd/src/access.ts";
import { AccountDirectory } from "../../../packages/canopyd/src/accounts.ts";
import type { ExecutionContext, ExecutionGrant } from "../../../packages/canopyd/src/execution-authority.ts";
import type { HostAccount, HostTree } from "../../../packages/canopyd/src/model.ts";
import { createHostSchema } from "../../../packages/canopyd/src/schema.ts";

const ROOT = `sha256:${"a".repeat(64)}` as ObjectHash;
const LINK = `sha256:${"b".repeat(64)}`;

function tree(id: string, governs: string | null = null): HostTree {
  return { id, canonicalPath: governs ? null : `/${id}`, parentTree: null, kind: governs ? "tree-configuration" : "ordinary", ref: ROOT,
    governs };
}
const account = (profileTree: string): HostAccount => ({ id: profileTree, handle: profileTree.slice(3), enabled: true, homeHost: null });
const joe = account("tr_joe"), alice = account("tr_alice"), carol = account("tr_carol"), bob = account("tr_bob");
const trees = new Map([
  ["tr_todos", tree("tr_todos")],
  ["tr_trip", tree("tr_trip")],
  ["tr_plants", tree("tr_plants")],
  ["tr_calendar", tree("tr_calendar")],
  ["tr_catalog", tree("tr_catalog")],
  ["tr_club", tree("tr_club")],
  ["tr_person", tree("tr_person")],
  ["tr_todos_config", tree("tr_todos_config", "tr_todos")],
]);
const groups = new Map<string, string[]>([["tr_club", ["tr_joe", "tr_carol"]], ["tr_person", ["tr_bob"]]]);
const types = new Map<string, "group" | "person">([["tr_club", "group"], ["tr_person", "person"]]);
const host: AccessHost = {
  tree: (id) => trees.get(id) ?? null,
  isProfileMember: (group, profile) => groups.get(group.id)?.includes(profile) ?? false,
  rootProfileType: (tree) => types.get(tree.id) ?? null,
  isRemoteGroupMember: (group, homeHost, profile) => remoteGroups.get(`${homeHost} ${group}`)?.includes(profile) ?? false,
  pinnedProfile: (tree, locator) => pins.get(`${tree} ${locator}`) ?? null,
};
/** The TreeIDs this host pinned the locators each tree's configuration names to. */
const pins = new Map<string, string>();
/** Groups other hosts hold, as this host's copies of them list their members. */
const FAR = "https://far.example";
const remoteGroups = new Map<string, string[]>([[`${FAR} tr_faraway`, ["tr_alice"]], [`${FAR} tr_club`, ["tr_alice"]]]);

let db: Database;
let access: AccessControl;

function configure(treeID: string, rules: ResourceAccessRule[]) {
  db.run("INSERT OR REPLACE INTO tree_policy (tree_id, rules_json) VALUES (?, ?)", [treeID, JSON.stringify(rules)]);
  db.run("DELETE FROM tree_admins WHERE tree_id = ?", [treeID]);
  for (const rule of rules) {
    if (rule.allow.includes("admin") && typeof rule.who === "object" && "profile" in rule.who) {
      db.run("INSERT INTO tree_admins (tree_id, profile_tree) VALUES (?, ?)", [treeID, rule.who.profile]);
    }
  }
}
function approve(profile: string, app: string, rules: AppAccessRule[]) {
  db.run("INSERT OR REPLACE INTO app_policy (profile_tree, app_tree, rules_json) VALUES (?, ?, ?)", [profile, app, JSON.stringify(rules)]);
}

beforeEach(() => {
  db = new Database(":memory:");
  createHostSchema(db);
  for (const a of [joe, alice, carol, bob]) db.run("INSERT INTO accounts (id, handle, enabled) VALUES (?, ?, 1)", [a.id, a.handle]);
  access = new AccessControl(db, host, new AccountDirectory(db));
});

describe("administrators and rules", () => {
  test("administrators read, write and see the configuration; rules grant the rest", () => {
    configure("tr_todos", [
      { who: { profile: "tr_joe" }, allow: ["admin"] },
      { who: { profile: "tr_alice" }, allow: ["read", "create-child"] },
      { who: { link: LINK }, allow: ["read"] },
      { who: { profile: "tr_carol" }, allow: ["read"], within: "/notes" },
    ]);
    expect(access.canWrite(joe, "tr_todos")).toBe(true);
    expect(access.canAdminister(joe, "tr_todos")).toBe(true);
    expect(access.canRead(joe, "tr_todos_config")).toBe(true);
    expect(access.canRead(alice, "tr_todos")).toBe(true);
    expect(access.canWrite(alice, "tr_todos")).toBe(false);
    expect(access.canAdminister(alice, "tr_todos")).toBe(false);
    expect(access.canRead(alice, "tr_todos_config")).toBe(false);
    expect(access.canRead(carol, "tr_todos")).toBe(false);
    expect(access.canRead(null, "tr_todos", LINK)).toBe(true);
    expect(access.canWrite(null, "tr_todos", LINK)).toBe(false);
  });

  test("two administrators both administer a shared tree", () => {
    configure("tr_trip", [{ who: { profile: "tr_joe" }, allow: ["admin"] }, { who: { profile: "tr_alice" }, allow: ["admin"] }]);
    expect(access.canAdminister(joe, "tr_trip")).toBe(true);
    expect(access.canAdminister(alice, "tr_trip")).toBe(true);
  });

  test("a group administers through its current members, and only a group expands", () => {
    configure("tr_plants", [{ who: { profile: "tr_club" }, allow: ["admin"] }, { who: { profile: "tr_person" }, allow: ["write"] }]);
    expect(access.canAdminister(joe, "tr_plants")).toBe(true);
    expect(access.canAdminister(carol, "tr_plants")).toBe(true);
    expect(access.canAdminister(alice, "tr_plants")).toBe(false);
    // tr_person lists bob as a member but is not a group.
    expect(access.canWrite(bob, "tr_plants")).toBe(false);
    db.run("UPDATE accounts SET enabled = 0 WHERE id = 'tr_carol'");
    expect(access.canAdminister(carol, "tr_plants")).toBe(false);
  });

  test("a group another host holds matches, by its pinned locator, through the copy read there; a group held here decides alone", () => {
    pins.set(`tr_plants ${FAR}/~faraway`, "tr_faraway");
    // A locator pinned to a group this host holds: its own tree decides.
    pins.set(`tr_plants ${FAR}/~club`, "tr_club");
    configure("tr_plants", [
      { who: { profile: "tr_joe" }, allow: ["admin"] },
      { who: { profile: `${FAR}/~faraway` }, allow: ["read"] },
      { who: { profile: `${FAR}/~club` }, allow: ["write"] },
    ]);
    expect(access.canRead(alice, "tr_plants")).toBe(true);
    expect(access.canWrite(alice, "tr_plants")).toBe(false);
    expect(access.canWrite(carol, "tr_plants")).toBe(true);
    expect(access.canRead(bob, "tr_plants")).toBe(false);
    // A bare TreeID this host does not hold, or a locator with no pin for
    // this tree, matches nobody.
    configure("tr_trip", [{ who: { profile: "tr_joe" }, allow: ["admin"] }, { who: { profile: "tr_faraway" }, allow: ["read"] }, { who: { profile: `${FAR}/~faraway` }, allow: ["read"] }]);
    expect(access.canRead(alice, "tr_trip")).toBe(false);
    // A remote group administers through its members too.
    pins.set(`tr_calendar ${FAR}/~faraway`, "tr_faraway");
    configure("tr_calendar", [{ who: { profile: `${FAR}/~faraway` }, allow: ["admin"] }]);
    expect(access.canAdminister(alice, "tr_calendar")).toBe(true);
    expect(access.canAdminister(joe, "tr_calendar")).toBe(false);
    // Only a profile an enabled account holds here counts.
    db.run("UPDATE accounts SET enabled = 0 WHERE id = 'tr_alice'");
    expect(access.canRead(alice, "tr_plants")).toBe(false);
  });
});

describe("code runs as its caller, with access only its named subjects lend", () => {
  const context = (caller: string | null, code = "tr_code"): ExecutionContext => ({
    code, version: "v1", caller, subject: caller ?? "anonymous", expiresAt: Date.now() + 10000, grants: [], active: () => true,
  });
  const lent = (lender: string | null, tree: string, allow: ExecutionGrant["allow"] = ["read"], within = "/"): ExecutionGrant => ({ lender, tree, within, allow });

  test("the caller's own access works through code, and a tree's own app rule needs no lender", () => {
    configure("tr_todos", [
      { who: { profile: "tr_joe" }, allow: ["admin"] },
      { who: { profile: "tr_alice" }, allow: ["read"] },
      { who: "everyone", app: "tr_code", allow: ["read"], within: "/published" },
    ]);
    expect(access.executionAllows(context("tr_alice"), lent(null, "tr_todos"), "/", "read")).toBe(true);
    expect(access.executionAllows(context(null), lent(null, "tr_todos"), "/published/a", "read")).toBe(true);
    expect(access.executionAllows(context(null), lent(null, "tr_todos"), "/private", "read")).toBe(false);
    expect(access.executionAllows(context(null, "tr_other"), lent(null, "tr_todos"), "/published", "read")).toBe(false);
  });

  test("a named profile lends its own access to other callers of the app", () => {
    configure("tr_catalog", [{ who: { profile: "tr_library" }, allow: ["admin"] }, { who: { profile: "tr_joe" }, allow: ["read"] }]);
    approve("tr_joe", "tr_code", [{ resource: "tr_catalog", who: "everyone", allow: ["read"], within: "/new-books" }]);
    expect(access.executionAllows(context(null), lent("tr_joe", "tr_catalog"), "/new-books/a", "read")).toBe(true);
    expect(access.executionAllows(context(null), lent("tr_joe", "tr_catalog"), "/old-books", "read")).toBe(false);
    expect(access.executionAllows(context(null, "tr_other"), lent("tr_joe", "tr_catalog"), "/new-books", "read")).toBe(false);
    // Lending can only narrow what the lender holds, and lapses with it.
    configure("tr_catalog", [{ who: { profile: "tr_library" }, allow: ["admin"] }]);
    expect(access.executionAllows(context(null), lent("tr_joe", "tr_catalog"), "/new-books/a", "read")).toBe(false);
  });

  test("Alice cannot lend Joe's access", () => {
    configure("tr_todos", [{ who: { profile: "tr_joe" }, allow: ["admin"] }, { who: { profile: "tr_alice" }, allow: ["read"] }]);
    approve("tr_alice", "tr_code", [{ resource: "tr_todos", who: "everyone", allow: ["write"] }]);
    expect(access.executionAllows(context(null), lent("tr_alice", "tr_todos", ["write"]), "/", "write")).toBe(false);
    expect(access.executionAllows(context(null), lent("tr_alice", "tr_todos"), "/", "read")).toBe(true);
  });

  test("Joe cannot lend access granted to his club, but the club can, and may approve for its members", () => {
    configure("tr_calendar", [{ who: { profile: "tr_admin" }, allow: ["admin"] }, { who: { profile: "tr_club" }, allow: ["read"] }]);
    approve("tr_joe", "tr_code", [{ resource: "tr_calendar", who: "everyone", allow: ["read"] }]);
    expect(access.executionAllows(context(null), lent("tr_joe", "tr_calendar"), "/", "read")).toBe(false);
    approve("tr_club", "tr_code", [{ resource: "tr_calendar", who: "everyone", allow: ["read"], within: "/events" }]);
    expect(access.executionAllows(context(null), lent("tr_club", "tr_calendar"), "/events", "read")).toBe(true);
    approve("tr_club", "tr_planner", [{ resource: "tr_calendar", who: "members", allow: ["read"] }]);
    expect(access.executionAllows(context("tr_carol", "tr_planner"), lent("tr_club", "tr_calendar"), "/", "read")).toBe(true);
    expect(access.executionAllows(context("tr_alice", "tr_planner"), lent("tr_club", "tr_calendar"), "/", "read")).toBe(false);
  });

  test("approving an app for yourself may use access you hold through a group", () => {
    configure("tr_calendar", [{ who: { profile: "tr_admin" }, allow: ["admin"] }, { who: { profile: "tr_club" }, allow: ["read"] }]);
    approve("tr_joe", "tr_planner", [{ resource: "tr_calendar", who: "me", allow: ["read"] }]);
    expect(access.executionAllows(context("tr_joe", "tr_planner"), lent("tr_joe", "tr_calendar"), "/", "read")).toBe(true);
    expect(access.executionAllows(context("tr_carol", "tr_planner"), lent("tr_joe", "tr_calendar"), "/", "read")).toBe(false);
  });

  test("two lenders are two grants; one losing access revokes only its own", () => {
    configure("tr_todos", [
      { who: { profile: "tr_admin" }, allow: ["admin"] },
      { who: { profile: "tr_joe" }, allow: ["read"] },
      { who: { profile: "tr_alice" }, allow: ["read"] },
    ]);
    for (const lender of ["tr_joe", "tr_alice"]) approve(lender, "tr_code", [{ resource: "tr_todos", who: "everyone", allow: ["read"] }]);
    expect(access.executionAllows(context(null), lent("tr_joe", "tr_todos"), "/", "read")).toBe(true);
    expect(access.executionAllows(context(null), lent("tr_alice", "tr_todos"), "/", "read")).toBe(true);
    configure("tr_todos", [{ who: { profile: "tr_admin" }, allow: ["admin"] }, { who: { profile: "tr_alice" }, allow: ["read"] }]);
    expect(access.executionAllows(context(null), lent("tr_joe", "tr_todos"), "/", "read")).toBe(false);
    expect(access.executionAllows(context(null), lent("tr_alice", "tr_todos"), "/", "read")).toBe(true);
  });

  test("on a placement host, code has no personal access of its caller and a placement account lends nothing", () => {
    db.run("UPDATE accounts SET home_host = 'https://home.example' WHERE id = 'tr_alice'");
    configure("tr_todos", [
      { who: { profile: "tr_alice" }, allow: ["admin"] },
      { who: "everyone", allow: ["read"], within: "/public" },
      { who: "everyone", app: "tr_code", allow: ["read"], within: "/published" },
    ]);
    approve("tr_alice", "tr_code", [{ resource: "tr_todos", who: "everyone", allow: ["read"] }]);
    // Direct execution is the caller's own access.
    expect(access.executionAllows(context("tr_alice", ""), lent(null, "tr_todos"), "/private", "read")).toBe(true);
    // Code gets what anyone holds and the tree's own app rules, never the caller's administration.
    expect(access.executionAllows(context("tr_alice"), lent(null, "tr_todos"), "/private", "read")).toBe(false);
    expect(access.executionAllows(context("tr_alice"), lent(null, "tr_todos"), "/public/a", "read")).toBe(true);
    expect(access.executionAllows(context("tr_alice"), lent(null, "tr_todos"), "/published/a", "read")).toBe(true);
    // Its apps.yaml is at its home host: nothing is lent here.
    expect(access.executionAllows(context(null), lent("tr_alice", "tr_todos"), "/", "read")).toBe(false);
  });

  test("a lender that is neither an enabled account's person nor a group lends nothing", () => {
    configure("tr_todos", [{ who: { profile: "tr_admin" }, allow: ["admin"] }, { who: { profile: "tr_joe" }, allow: ["read"] }]);
    approve("tr_joe", "tr_code", [{ resource: "tr_todos", who: "everyone", allow: ["read"] }]);
    db.run("UPDATE accounts SET enabled = 0 WHERE id = 'tr_joe'");
    expect(access.executionAllows(context(null), lent("tr_joe", "tr_todos"), "/", "read")).toBe(false);
  });
});
