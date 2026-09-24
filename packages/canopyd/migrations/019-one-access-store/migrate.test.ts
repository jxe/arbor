import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanopyDaemon, serveCanopy } from "@overstory/canopyd";
import { generateArborID, readAccountConfigGraph, sha256, snapshotAccountConfig, WireClient, type ObjectHash } from "@overstory/protocol";
import { ObjectStore } from "@overstory/object-store";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
import { migrateAccessStore, UnmigratableAccessError } from "./run.ts";

const ownerToken = "migration-019-owner", bobToken = "migration-019-bob";
const link = `sha256:${sha256("migration-019-link")}`;
let sandbox: string, root: string;
let ids: { community: string; ownerProfile: string; bobProfile: string; notes: string; owner: string; bob: string };

/** Rewrite a schema-20 data root into the layout schema 19 left: the dropped
 * columns back, bootstrap trees without an owner, their rules only in
 * `access`, bootstrap configurations without `resource_policy` rows, and the
 * whole-tree copy of an activated tree's rules in `access`. */
function toSchema19(path: string): void {
  const db = new Database(join(path, "canopy.sqlite3"));
  try {
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      db.run("ALTER TABLE trees ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE tree_reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'awaiting-initialization'");
      db.run("ALTER TABLE tree_reservations ADD COLUMN error TEXT");
      db.run("ALTER TABLE account_challenges ADD COLUMN claim_digest TEXT");
      db.run("INSERT INTO meta (key, value) VALUES ('community_name', 'Community')");
      db.run("UPDATE trees SET account_id = NULL WHERE id IN (?, ?, ?)", [ids.community, ids.ownerProfile, ids.bobProfile]);
      db.run("DELETE FROM resource_policy WHERE tree_id <> ?", [ids.notes]);
      const row = (tree: string, kind: string, subject: string, access: string) =>
        db.run("INSERT INTO access (id, tree_id, subject_kind, subject, access) VALUES (?, ?, ?, ?, ?)", [generateArborID("ax"), tree, kind, subject, access]);
      row(ids.community, "everyone", "everyone", "read");
      row(ids.community, "profile", ids.ownerProfile, "write");
      row(ids.ownerProfile, "everyone", "everyone", "read");
      row(ids.ownerProfile, "profile", ids.ownerProfile, "write");
      row(ids.bobProfile, "everyone", "everyone", "read");
      row(ids.bobProfile, "profile", ids.bobProfile, "write");
      row(ids.notes, "link", link, "read");
      db.run("UPDATE meta SET value = '19' WHERE key = 'schema_version'");
    })();
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-migration-019-"));
  root = join(sandbox, "canopy");
  const running = await serveCanopy({
    dataRoot: root,
    accounts: [{ handle: "owner", token: ownerToken, communityWriter: true }, { handle: "bob", token: bobToken, communityWriter: false }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  try {
    const owner = new WireClient(running.url, ownerToken);
    const account = (await owner.account()).account;
    const configuration = await owner.descriptor(account.configuration.id);
    const graph = readAccountConfigGraph(await owner.snapshot(configuration.tree.id, configuration.tree.root), configuration.tree.id);
    const notes = generateArborID("tr");
    await owner.submitUpdate(configuration.tree.id, configuration.tree.update, snapshotAccountConfig({
      ...graph,
      resources: { ...graph.resources, [notes]: { canonical: `${running.url}/~owner/notes`, access: [{ who: { link }, allow: ["read"] }] } },
    }));
    const source = join(sandbox, "notes");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "_index.md"), "# Notes\n");
    await owner.submitUpdate(notes, null, await resolveSnapshot(await snapshotDirectory(source)));
    ids = {
      community: running.canopy.community().id,
      ownerProfile: account.profileTree!,
      bobProfile: running.canopy.accountByHandle("bob")!.profileTree!,
      notes,
      owner: running.canopy.accountByHandle("owner")!.id,
      bob: running.canopy.accountByHandle("bob")!.id,
    };
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
  }
  toSchema19(root);
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("a stamp other than 19 stops the run with nothing changed", async () => {
  const copy = join(sandbox, "wrong-stamp");
  await mkdir(join(copy, "objects"), { recursive: true });
  const db = new Database(join(copy, "canopy.sqlite3"), { create: true });
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '18')");
  db.close();
  await expect(migrateAccessStore(copy)).rejects.toThrow("requires schema 19, found 18");
});

test("two accounts hosting one unowned tree stop the run with nothing changed", async () => {
  const copy = join(sandbox, "double-host");
  await Bun.$`cp -R ${root} ${copy}`.quiet();
  // Bob's configuration now claims to host the owner's profile as well.
  const read = new Database(join(copy, "canopy.sqlite3"), { readonly: true });
  const bobConfig = read.query("SELECT t.id, t.ref FROM accounts a JOIN trees t ON t.id = a.config_tree WHERE a.id = ?").get(ids.bob) as { id: string; ref: ObjectHash };
  read.close();
  const objects = new ObjectStore(join(copy, "objects"));
  const graph = readAccountConfigGraph(await objects.completeSnapshot(bobConfig.ref), bobConfig.id);
  const next = snapshotAccountConfig({ ...graph, resources: { ...graph.resources, [ids.ownerProfile]: { canonical: `${graph.account.canopy}/~owner`, access: [] } } });
  await objects.store([...next.objects].map(([hash, bytes]) => ({ hash, bytes })));
  const write = new Database(join(copy, "canopy.sqlite3"));
  write.run("UPDATE trees SET ref = ? WHERE id = ?", [next.root, bobConfig.id]);
  write.close();
  await expect(migrateAccessStore(copy)).rejects.toBeInstanceOf(UnmigratableAccessError);
  const after = new Database(join(copy, "canopy.sqlite3"), { readonly: true });
  expect(after.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "19" });
  after.close();
});

test("owners, rules and columns after the run, once", async () => {
  const report = await migrateAccessStore(root);
  expect(report.migrated).toBe(true);
  expect(new Set(report.adopted.map(({ tree, account }) => `${tree}:${account}`))).toEqual(new Set([
    `${ids.community}:${ids.owner}`, `${ids.ownerProfile}:${ids.owner}`, `${ids.bobProfile}:${ids.bob}`,
  ]));
  expect(new Set(report.policyRewritten)).toEqual(new Set([ids.owner, ids.bob]));
  expect(report.accessRowsDeleted).toBe(7);
  expect(report.accessDifferences).toEqual([]);
  expect(report.unownedAccess).toEqual([]);
  expect(JSON.stringify(report)).not.toContain(link);

  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
  expect(columns("trees")).toEqual(["id", "ref", "policy", "status", "account_id"]);
  expect(columns("tree_reservations")).toEqual(["id", "account_id", "canonical_path"]);
  expect(columns("account_challenges")).toEqual(["id", "challenge_json", "expires_at", "consumed_at"]);
  expect(db.query("SELECT value FROM meta WHERE key = 'community_name'").get()).toBeNull();
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "20" });
  db.close();

  const again = await migrateAccessStore(root);
  expect(again.migrated).toBe(false);
  expect(again.trees).toEqual(report.trees);

  // This build serves the migrated root with the access schema 19 gave.
  const canopy = await CanopyDaemon.open(root);
  try {
    const owner = canopy.accountByHandle("owner")!, bob = canopy.accountByHandle("bob")!;
    expect(canopy.canRead(null, ids.community)).toBe(true);
    expect(canopy.canWrite(owner, ids.community)).toBe(true);
    expect(canopy.canWrite(bob, ids.community)).toBe(false);
    expect(canopy.canAdminister(owner, ids.community)).toBe(true);
    expect(canopy.canRead(null, ids.bobProfile)).toBe(true);
    expect(canopy.canWrite(bob, ids.bobProfile)).toBe(true);
    expect(canopy.canWrite(owner, ids.bobProfile)).toBe(false);
    expect(canopy.canRead(null, ids.notes)).toBe(false);
    expect(canopy.canRead(null, ids.notes, link)).toBe(true);
    expect(canopy.accessEntries(ids.notes).map(({ subjectKind, access }) => ({ subjectKind, access }))).toEqual([{ subjectKind: "link", access: "read" }]);
    await canopy.verifyIntegrity();
  } finally {
    await canopy[Symbol.asyncDispose]();
  }
});
