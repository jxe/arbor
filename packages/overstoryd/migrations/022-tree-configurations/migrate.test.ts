import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { ObjectStore } from "@overstory/object-store";
import { LOG_ENTRY_FORMAT } from "@overstory/merge-protocol";
import {
  ProtocolClient,
  encodeProtocolDirectory,
  generateArborID,
  hashObject,
  readTreeConfigGraph,
  sha256,
  treeConfigurationID,
  type ObjectHash,
  type ProtocolDirectory,
  type TreeSnapshot,
} from "@overstory/protocol";
import { serveHost } from "@overstory/canopyd";
import { AcceptedUpdateStore } from "../../../../packages/canopyd/src/updates/store.ts";
import { MergeHistory } from "../../../../packages/canopyd/src/updates/merge-history.ts";
import { entryChanges } from "../../../../packages/canopyd/src/updates/entry-metadata.ts";
import { readRootProfile, storedProfileOf, writeStoredProfile } from "../../../../packages/canopyd/src/profile.ts";
import { testProfileIdentity } from "../../../../tests/helpers/profile-identity.ts";
import { createSchema21, type LegacyRule } from "./legacy.ts";
import { migrateTreeConfigurations, UnmigratableTreeConfigError } from "./run.ts";
import { rekeyDataHome } from "./rekey-data-home.ts";
import { HostAccountStore, saveCurrentAccountDeviceID } from "@overstory/protocol";
import { loadTreeRegistry } from "@overstory/arborsync/state";
import { readFile, writeFile } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const encoder = new TextEncoder();

/** A directory of files and nested tree entries, with its objects. */
function directory(files: Record<string, string>, nested: Record<string, string> = {}): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const entries: ProtocolDirectory["entries"] = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = encoder.encode(text), hash = hashObject(bytes);
    objects.set(hash, bytes);
    entries.push({ name, file: hash });
  }
  for (const [name, tree] of Object.entries(nested)) entries.push({ name, tree });
  entries.sort((a, b) => a.name < b.name ? -1 : 1);
  const bytes = encodeProtocolDirectory({ type: "directory", entries }), root = hashObject(bytes);
  objects.set(root, bytes);
  return { root, objects };
}

interface Fixture {
  root: string;
  ids: { community: string; joe: string; bob: string; todos: string; joeAccount: string; bobAccount: string; joeConfig: string; bobConfig: string };
  tokens: { joeMac: string; joePhone: string; bob: string };
}

/**
 * A schema-21 data root shaped like Joe's host: a community whose root no
 * account owns (`access` rows), Joe's self-certifying profile and his todos
 * tree with scoped, link and `via` rules, and a bootstrap token account for
 * Bob that writes the community too.
 */
async function schema21(options: { bobCommunityAccess?: "read" | "write"; extraRule?: { account: "joe" | "bob"; tree: "bob" | "todos"; rule: LegacyRule } } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "arbor-migration-022-"));
  roots.push(root);
  await mkdir(join(root, "objects"), { recursive: true });
  const db = new Database(join(root, "canopy.sqlite3"), { create: true, strict: true });
  createSchema21(db, (target) => AcceptedUpdateStore.createSchema(target));
  const objects = new ObjectStore(join(root, "objects"));
  const store = new AcceptedUpdateStore(db);
  const history = new MergeHistory(store, objects);
  const joe = testProfileIdentity().profileTree, bob = generateArborID("tr");
  const ids = {
    community: generateArborID("tr"), joe, bob, todos: generateArborID("tr"),
    joeAccount: generateArborID("ac"), bobAccount: generateArborID("ac"),
    joeConfig: generateArborID("tr"), bobConfig: generateArborID("tr"),
  };
  const tokens = { joeMac: "joe-mac-token", joePhone: "joe-phone-token", bob: "bob-token" };
  const insert = async (tree: string, snapshot: TreeSnapshot, options: { path?: string; parent?: string; account?: string; policy?: string } = {}) => {
    const entry = await history.write({ format: LOG_ENTRY_FORMAT, tree, previous: null, root: snapshot.root, change: `initial:${tree}`, trace: null, resolves: [], decisions: [] },
      [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })));
    const changes = await entryChanges(null, snapshot.root, (hash) => objects.load(hash, snapshot.objects));
    db.run("INSERT INTO trees (id, ref, policy, status, account_id) VALUES (?, ?, ?, 'active', ?)", [tree, snapshot.root, options.policy ?? "ordinary", options.account ?? null]);
    if (options.path) db.run("INSERT INTO boundaries (path, tree_id, parent_tree) VALUES (?, ?, ?)", [options.path, tree, options.parent ?? null]);
    store.insert({ tree, root: snapshot.root, previousRoot: null, acceptedAt: Date.now(), subject: null, entryChanges: changes, entry });
    writeStoredProfile(db, tree, storedProfileOf(await readRootProfile(snapshot.root, (hash) => objects.load(hash, snapshot.objects))));
  };
  const person = (name: string) => `---\ntype: person\ndisplayName: ${name}\n---\n\n# ${name}\n`;
  await insert(ids.community, directory({
    "_index.md": `---\ntype: group\nmembers:\n  - profile: "arbor://${joe}/"\n    handle: joe\n  - profile: "arbor://${bob}/"\n    handle: bob\n---\n\n# Garden\n`,
  }, { "~joe": joe, "~bob": bob }), { path: "/" });
  await insert(joe, directory({ "_index.md": person("Joe") }, { todos: ids.todos }), { path: "/~joe", parent: ids.community, account: ids.joeAccount });
  await insert(ids.todos, directory({ "_index.md": "# Todos\n" }), { path: "/~joe/todos", parent: joe, account: ids.joeAccount });
  await insert(bob, directory({ "_index.md": person("Bob") }), { path: "/~bob", parent: ids.community, account: ids.bobAccount });
  const link = `sha256:${"c".repeat(64)}`;
  const joeTrees: Record<string, { canonical?: string; access: LegacyRule[] }> = {
    [joe]: { canonical: `https://garden.example/~joe`, access: [{ who: "everyone", allow: ["read"] }] },
    [ids.todos]: { canonical: `https://garden.example/~joe/todos`, access: [
      { who: { profile: bob }, allow: ["read"] },
      { who: { link }, allow: ["read"], within: "/shared" },
      { who: "me", via: "tr_supplies", allow: ["create-child"] },
      { who: "everyone", via: "tr_publisher", allow: ["read"], within: "/published" },
      { who: "me", allow: ["write"] },
    ] },
    [bob]: { access: [{ who: "me", via: "tr_planner", allow: ["read"] }] },
  };
  const bobTrees: Record<string, { canonical?: string; access: LegacyRule[] }> = {
    [bob]: { canonical: `https://garden.example/~bob`, access: [{ who: "everyone", allow: ["read"] }, { who: { profile: joe }, allow: ["read"] }] },
  };
  if (options.extraRule) {
    const trees = options.extraRule.account === "joe" ? joeTrees : bobTrees;
    const target = options.extraRule.tree === "bob" ? bob : ids.todos;
    (trees[target] ??= { access: [] }).access.push(options.extraRule.rule);
  }
  const accountFiles = (profile: string, trees: object, devices: object) => directory({
    "account.yaml": stringify({ canopy: "https://garden.example", profile }),
    "trees.yaml": stringify(trees),
    "devices.yaml": stringify(devices),
  });
  const joeDevices = { dv_joemacaaaaaaaaaaaaaaaaaaaa: { label: "Joe's Mac", administrator: true }, dv_joephoneaaaaaaaaaaaaaaaaa: { label: "Joe's iPhone" } };
  const bobDevices = { dv_bobaaaaaaaaaaaaaaaaaaaaaa: { label: "Initial device", administrator: true } };
  await insert(ids.joeConfig, accountFiles(joe, joeTrees, joeDevices), { account: ids.joeAccount, policy: "account-config-v2" });
  await insert(ids.bobConfig, accountFiles(bob, bobTrees, bobDevices), { account: ids.bobAccount, policy: "account-config-v2" });
  db.run("INSERT INTO accounts (id, handle, profile_tree, config_tree, enabled, claim_digest) VALUES (?, 'joe', ?, ?, 1, 'claim'), (?, 'bob', ?, ?, 1, NULL)",
    [ids.joeAccount, joe, ids.joeConfig, ids.bobAccount, bob, ids.bobConfig]);
  const device = (id: string, account: string, label: string, token: string) =>
    db.run("INSERT INTO devices (id, account_id, label, token_digest, created_at) VALUES (?, ?, ?, ?, ?)", [id, account, label, sha256(token), Date.now()]);
  device("dv_joemacaaaaaaaaaaaaaaaaaaaa", ids.joeAccount, "Joe's Mac", tokens.joeMac);
  device("dv_joephoneaaaaaaaaaaaaaaaaa", ids.joeAccount, "Joe's iPhone", tokens.joePhone);
  device("dv_bobaaaaaaaaaaaaaaaaaaaaaa", ids.bobAccount, "Initial device", tokens.bob);
  for (const [account, trees] of [[ids.joeAccount, joeTrees], [ids.bobAccount, bobTrees]] as const) {
    for (const [tree, declaration] of Object.entries(trees)) {
      db.run("INSERT INTO resource_policy (account_id, tree_id, rules_json) VALUES (?, ?, ?)", [account, tree, JSON.stringify(declaration.access)]);
    }
  }
  const access = (subjectKind: string, subject: string, level: string) =>
    db.run("INSERT INTO access (id, tree_id, subject_kind, subject, access) VALUES (?, ?, ?, ?, ?)", [generateArborID("ax"), ids.community, subjectKind, subject, level]);
  access("everyone", "everyone", "read");
  access("profile", joe, "write");
  access("profile", bob, options.bobCommunityAccess ?? "write");
  db.run("INSERT INTO meta (key, value) VALUES ('community_handle', 'garden'), ('community_host', '127.0.0.1')");
  db.close();
  return { root, ids, tokens };
}

describe("migration 022: tree configurations", () => {
  test("configures every tree, folds each account's configuration into its profile's, and keeps access", async () => {
    const { root, ids, tokens } = await schema21();
    const report = await migrateTreeConfigurations(root);
    expect(report.migrated).toBe(true);
    expect(report.access.every((tree) => JSON.stringify(tree.before) === JSON.stringify(tree.after))).toBe(true);
    expect(report.accounts.map((account) => account.profile).sort()).toEqual([ids.joe, ids.bob].sort());
    expect(report.covered.some((rule) => rule.includes("who=me allow=write"))).toBe(true);
    expect(report.lent.after).toContainEqual(expect.stringContaining(`${ids.todos} app=tr_publisher tree-rule`));
    expect(report.lent.after).toContainEqual(expect.stringContaining(`${ids.todos} app=tr_supplies apps.yaml=${ids.joe}`));
    expect(report.lent.after).toContainEqual(expect.stringContaining(`${ids.bob} app=tr_planner apps.yaml=${ids.joe}`));
    expect(JSON.stringify(report)).not.toContain("c".repeat(64));
    // Trees keep their roots; account configurations are gone.
    const trees = new Map(report.trees.map((tree) => [tree.id, tree]));
    for (const id of [ids.joeConfig, ids.bobConfig]) expect(trees.has(id)).toBe(false);
    for (const id of [ids.community, ids.joe, ids.todos, ids.bob]) expect(trees.get(treeConfigurationID(id))?.governs).toBe(id);

    const objects = new ObjectStore(join(root, "objects"));
    const configOf = async (tree: string, kind: "tree" | "person" | "group") => {
      const row = trees.get(treeConfigurationID(tree))!;
      return readTreeConfigGraph(await objects.completeSnapshot(row.root as ObjectHash), kind, tree);
    };
    const joe = await configOf(ids.joe, "person");
    expect(joe.access).toEqual([{ who: { profile: ids.joe }, allow: ["admin"] }, { who: "everyone", allow: ["read"] }]);
    expect(joe.mounts).toEqual({ todos: ids.todos });
    expect(joe.devices).toEqual({
      dv_joemacaaaaaaaaaaaaaaaaaaaa: { id: "dv_joemacaaaaaaaaaaaaaaaaaaaa", label: "Joe's Mac", administrator: true },
      dv_joephoneaaaaaaaaaaaaaaaaa: { id: "dv_joephoneaaaaaaaaaaaaaaaaa", label: "Joe's iPhone", administrator: false },
    });
    expect(joe.apps).toEqual({
      tr_supplies: [{ resource: ids.todos, who: "me", allow: ["create-child"] }],
      tr_planner: [{ resource: ids.bob, who: "me", allow: ["read"] }],
    });
    const todos = await configOf(ids.todos, "tree");
    expect(todos.access).toEqual([
      { who: { profile: ids.joe }, allow: ["admin"] },
      { who: "everyone", app: "tr_publisher", allow: ["read"], within: "/published" },
      { who: { link: `sha256:${"c".repeat(64)}` }, allow: ["read"], within: "/shared" },
      { who: { profile: ids.bob }, allow: ["read"] },
    ]);
    const community = await configOf(ids.community, "group");
    expect(community.access).toEqual([{ who: { profile: ids.community }, allow: ["admin"] }, { who: "everyone", allow: ["read"] }]);
    expect(community.mounts).toEqual({});
    expect(await migrateTreeConfigurations(root)).toMatchObject({ migrated: false, from: "22" });

    // The migrated root serves: devices keep their credentials, and access is as before.
    const running = await serveHost({ dataRoot: root, publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
    try {
      const mac = new ProtocolClient(running.url, tokens.joeMac);
      const account = await mac.account();
      expect(account.account).toMatchObject({ id: ids.joe, handle: "joe", profileTree: ids.joe });
      expect(account.account.configuration.id).toBe(treeConfigurationID(ids.joe));
      expect((await mac.descriptor(ids.todos)).tree).toMatchObject({ access: "write", canonical: { path: "/~joe/todos" } });
      expect((await new ProtocolClient(running.url, tokens.joePhone).descriptor(ids.todos)).tree.access).toBe("write");
      const bob = new ProtocolClient(running.url, tokens.bob);
      expect((await bob.descriptor(ids.todos)).tree.access).toBe("read");
      expect(running.canopy.canAdminister(running.canopy.account(ids.bob)!, ids.community)).toBe(true);
      await expect(bob.treeConfiguration(ids.todos)).rejects.toThrow();
      expect((await mac.treeConfiguration(ids.todos)).tree.id).toBe(treeConfigurationID(ids.todos));
      expect(running.canopy.boundary("/~joe/todos")?.id).toBe(ids.todos);
      await running.canopy.verifyIntegrity();

      // The Mac's data home follows: its schema-21 account checkout becomes the profile's configuration.
      const previousHome = process.env.ARBOR_DATA_HOME, previousStore = process.env.ARBOR_CREDENTIAL_STORE;
      const home = join(root, "data-home");
      process.env.ARBOR_DATA_HOME = home;
      process.env.ARBOR_CREDENTIAL_STORE = "file";
      try {
        const oldCheckout = join(home, "accounts", ids.joeConfig);
        await mkdir(oldCheckout, { recursive: true });
        for (const name of ["account.yaml", "trees.yaml", "devices.yaml"]) await writeFile(join(oldCheckout, name), "{}\n");
        const placed = join(root, "todos-folder");
        await mkdir(placed);
        await writeFile(join(home, "placements.yaml"), `${ids.joeConfig}:\n  ${JSON.stringify(placed)}: ${ids.todos}\n`);
        const mac = "dv_joemacaaaaaaaaaaaaaaaaaaaa";
        await saveCurrentAccountDeviceID(ids.joeConfig, mac);
        await new HostAccountStore(ids.joeConfig).set(tokens.joeMac, {
          origin: running.url, account: `${running.url}/~joe`, accountID: ids.joeAccount, handle: "joe", profileTree: ids.joe, deviceID: mac,
        });
        const refs = join(home, ".state", "accounts", ids.joeConfig, "refs");
        await mkdir(refs, { recursive: true });
        await writeFile(join(refs, `${ids.todos}.json`), JSON.stringify({ ref: "sha256:kept", update: "7" }));

        const rekeyed = await rekeyDataHome();
        const configuration = treeConfigurationID(ids.joe);
        expect(rekeyed.accounts).toEqual([{ from: ids.joeConfig, to: configuration, profile: ids.joe, origin: running.url, placements: 1, rekeyed: true }]);
        expect(await readFile(join(home, "accounts", configuration, "access.yaml"), "utf8")).toContain(ids.joe);
        expect(await readFile(join(home, "placements.yaml"), "utf8")).toContain(configuration);
        expect(await readFile(join(home, "placements.yaml"), "utf8")).not.toContain(ids.joeConfig);
        expect(await readFile(join(home, ".state", "accounts", configuration, "refs", `${ids.todos}.json`), "utf8")).toContain("sha256:kept");
        expect(await readFile(join(home, ".state", "migration", "022", `accounts-${ids.joeConfig}`, "trees.yaml"), "utf8")).toBe("{}\n");
        expect(await new HostAccountStore(ids.joeConfig).safe()).toBeNull();
        expect((await new HostAccountStore(configuration).get())?.accountToken).toBe(tokens.joeMac);
        const registry = await loadTreeRegistry();
        expect(registry.diagnostics).toEqual([]);
        expect(registry.placements.map((placement) => placement.tree).sort()).toEqual([configuration, ids.todos].sort());
        expect((await rekeyDataHome()).accounts).toEqual([{ from: configuration, to: configuration, profile: ids.joe, origin: running.url, placements: 0, rekeyed: false }]);
      } finally {
        if (previousHome === undefined) delete process.env.ARBOR_DATA_HOME; else process.env.ARBOR_DATA_HOME = previousHome;
        if (previousStore === undefined) delete process.env.ARBOR_CREDENTIAL_STORE; else process.env.ARBOR_CREDENTIAL_STORE = previousStore;
      }
    } finally {
      running.server.stop(true);
      await running.canopy[Symbol.asyncDispose]();
    }
  });

  test("refuses when a member would become an administrator it was not", async () => {
    const { root } = await schema21({ bobCommunityAccess: "read" });
    await expect(migrateTreeConfigurations(root)).rejects.toThrow(UnmigratableTreeConfigError);
    const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    try { expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" }); }
    finally { db.close(); }
  });

  test("refuses to drop a rule an account holds on a tree it does not own", async () => {
    const { root } = await schema21({ extraRule: { account: "joe", tree: "bob", rule: { who: { profile: generateArborID("tr") }, allow: ["read"] } } });
    await expect(migrateTreeConfigurations(root)).rejects.toThrow("would be dropped");
  });

  test("refuses to lend access its account is not named for directly", async () => {
    const { root } = await schema21({ extraRule: { account: "bob", tree: "todos", rule: { who: "everyone", via: "tr_lender", allow: ["write"] } } });
    await expect(migrateTreeConfigurations(root)).rejects.toThrow("no rule names its profile for directly");
  });

  test("migrates a lend its account is named for directly", async () => {
    const { root, ids } = await schema21({ extraRule: { account: "bob", tree: "todos", rule: { who: "everyone", via: "tr_lender", allow: ["read"] } } });
    const report = await migrateTreeConfigurations(root);
    expect(report.lent.after).toContainEqual(expect.stringContaining(`${ids.todos} app=tr_lender apps.yaml=${ids.bob}`));
  });
});
