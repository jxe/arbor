import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostDaemon, serveHost } from "@overstory/canopyd";
import {
  ProtocolClient, decodeProtocolDirectory, encodeProtocolDirectory, generateArborID, hashObject, readAccountConfigGraph, snapshotAccountConfig,
  type ProtocolDirectoryEntry,
} from "@overstory/protocol";
import { migrateProfileFacts, UnmigratableProfileError } from "./run.ts";

const ownerToken = "migration-020-owner", bobToken = "migration-020-bob";
const encoder = new TextEncoder(), decoder = new TextDecoder();
let sandbox: string, root: string;
let ids: { community: string; ownerProfile: string; bobProfile: string; club: string; notes: string };
/** The schema-21 rows this build wrote, which the migration must rebuild exactly. */
let expected: Array<{ tree_id: string; index_hash: string; avatar_path: string | null; facts: string }>;
/** Roots the community had before its head: schema 20 kept a row for each. */
let historical: string[] = [];

type Row = (typeof expected)[number];
const rows = (db: Database) => db.query("SELECT tree_id, index_hash, avatar_path, facts FROM profile_facts ORDER BY tree_id").all() as Row[];

/** Rewrite a schema-21 data root into the layout schema 20 left: no
 * `profile_facts`, a `meta` row `profile:<root>` for every typed head, and
 * the rows the community's earlier roots left behind. */
function toSchema20(path: string): void {
  const db = new Database(join(path, "canopy.sqlite3"));
  try {
    db.transaction(() => {
      const heads = new Map((db.query("SELECT id, ref FROM trees").all() as Array<{ id: string; ref: string }>).map(({ id, ref }) => [id, ref]));
      for (const row of rows(db)) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [`profile:${heads.get(row.tree_id)}`, row.facts]);
      const community = rows(db).find((row) => row.tree_id === ids.community)!;
      for (const earlier of historical) {
        db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", [`profile:${earlier}`, community.facts]);
      }
      db.run("DROP TABLE profile_facts");
      db.run("UPDATE meta SET value = '20' WHERE key = 'schema_version'");
    })();
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-migration-020-"));
  root = join(sandbox, "canopy");
  const running = await serveHost({
    dataRoot: root,
    accounts: [{ handle: "owner", token: ownerToken, communityWriter: true }, { handle: "bob", token: bobToken, communityWriter: false }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  try {
    const owner = new ProtocolClient(running.url, ownerToken);
    const account = (await owner.account()).account;
    /** Replace root files of a tree's head and submit it. */
    const edit = async (tree: string, files: Record<string, (text: string) => string>) => {
      const head = (await owner.descriptor(tree)).tree;
      const snapshot = await owner.snapshot(tree, head.root);
      const objects = new Map(snapshot.objects);
      const directory = decodeProtocolDirectory(objects.get(snapshot.root)!);
      if (directory.type !== "directory") throw new Error("root is not a directory");
      let entries = directory.entries;
      for (const [name, change] of Object.entries(files)) {
        const current = entries.find((entry) => entry.name === name)?.file;
        const bytes = encoder.encode(change(current ? decoder.decode(objects.get(current)!) : "")), file = hashObject(bytes);
        objects.set(file, bytes);
        entries = [...entries.filter((entry) => entry.name !== name), { name, file } as ProtocolDirectoryEntry];
      }
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const bytes = encodeProtocolDirectory({ type: "directory", entries }), next = hashObject(bytes);
      objects.set(next, bytes);
      return owner.submitUpdate(tree, head.update, { root: next, objects });
    };

    const configuration = await owner.descriptor(account.configuration.id);
    const graph = readAccountConfigGraph(await owner.snapshot(configuration.tree.id, configuration.tree.root), configuration.tree.id);
    const club = generateArborID("tr"), notes = generateArborID("tr");
    await owner.submitUpdate(configuration.tree.id, configuration.tree.update, snapshotAccountConfig({
      ...graph,
      resources: {
        ...graph.resources,
        [club]: { canonical: `${running.url}/~owner/club`, access: [] },
        [notes]: { canonical: `${running.url}/~owner/notes`, access: [{ who: { profile: club }, allow: ["read"] }] },
      },
    }));
    const bobProfile = running.canopy.accountByHandle("bob")!.profileTree!;
    for (const [tree, text] of [[club, `---\ntype: group\nmembers:\n  - profile: "arbor://${bobProfile}/"\n---\n# Club\n`], [notes, "# Notes\n"]] as const) {
      const bytes = encoder.encode(text), file = hashObject(bytes);
      const directory = encodeProtocolDirectory({ type: "directory", entries: [{ name: "_index.md", file }] }), rootHash = hashObject(directory);
      await owner.submitUpdate(tree, null, { root: rootHash, objects: new Map([[file, bytes], [rootHash, directory]]) });
    }
    ids = { community: running.canopy.community().id, ownerProfile: account.profileTree!, bobProfile, club, notes };
    // Two community edits leave two earlier roots, each with a schema-20 row.
    historical.push(running.canopy.community().ref);
    await edit(ids.community, { "_index.md": (text) => `${text}\nA garden.\n` });
    historical.push(running.canopy.community().ref);
    await edit(ids.community, { "_index.md": (text) => `${text}\nOf people.\n` });
    // A declared avatar with a file, so the row carries both.
    await edit(ids.ownerProfile, { "me.png": () => "avatar", "_index.md": (text) => text.replace("type: person", "type: person\navatar: me.png") });
    const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
    expected = rows(db);
    db.close();
  } finally {
    running.server.stop(true);
    await running.canopy[Symbol.asyncDispose]();
  }
  toSchema20(root);
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the fixture has the schema-20 layout: heads' rows plus historical community rows", () => {
  expect(expected.map((row) => row.tree_id)).toEqual([ids.community, ids.ownerProfile, ids.bobProfile, ids.club].sort());
  expect(expected.find((row) => row.tree_id === ids.ownerProfile)!.avatar_path).toBe("me.png");
  expect(JSON.parse(expected.find((row) => row.tree_id === ids.ownerProfile)!.facts).avatar.path).toBe("me.png");
  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  expect((db.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'profile:%'").get() as { n: number }).n).toBe(6);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'profile_facts'").get()).toBeNull();
  db.close();
});

test("a stamp other than 20 stops the run with nothing changed", async () => {
  const copy = join(sandbox, "wrong-stamp");
  await mkdir(join(copy, "objects"), { recursive: true });
  const db = new Database(join(copy, "canopy.sqlite3"), { create: true });
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '19')");
  db.close();
  await expect(migrateProfileFacts(copy)).rejects.toThrow("requires schema 20, found 19");
});

test("a head whose facts do not rebuild its schema-20 row stops the run with nothing changed", async () => {
  const copy = join(sandbox, "tampered");
  await Bun.$`cp -R ${root} ${copy}`.quiet();
  const write = new Database(join(copy, "canopy.sqlite3"));
  const head = (write.query("SELECT ref FROM trees WHERE id = ?").get(ids.club) as { ref: string }).ref;
  write.run("UPDATE meta SET value = ? WHERE key = ?", [JSON.stringify({ version: 3, type: "group", members: [] }), `profile:${head}`]);
  write.close();
  await expect(migrateProfileFacts(copy)).rejects.toBeInstanceOf(UnmigratableProfileError);
  const after = new Database(join(copy, "canopy.sqlite3"), { readonly: true });
  expect(after.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "20" });
  expect(after.query("SELECT name FROM sqlite_master WHERE name = 'profile_facts'").get()).toBeNull();
  after.close();
});

test("a typed head without a schema-20 row stops the run", async () => {
  const copy = join(sandbox, "missing-row");
  await Bun.$`cp -R ${root} ${copy}`.quiet();
  const write = new Database(join(copy, "canopy.sqlite3"));
  const head = (write.query("SELECT ref FROM trees WHERE id = ?").get(ids.bobProfile) as { ref: string }).ref;
  write.run("DELETE FROM meta WHERE key = ?", [`profile:${head}`]);
  write.close();
  await expect(migrateProfileFacts(copy)).rejects.toThrow(/has no profile:/);
});

test("one row per profile tree, no profile rows in meta, once, served by this build", async () => {
  const report = await migrateProfileFacts(root);
  expect(report.migrated).toBe(true);
  expect(report.from).toBe("20");
  expect(report.metaRowsDeleted).toBe(6);
  expect(report.historicalRows).toBe(2);
  expect(report.profiles.map((profile) => [profile.tree, profile.type]).sort()).toEqual([
    [ids.community, "group"], [ids.club, "group"], [ids.ownerProfile, "person"], [ids.bobProfile, "person"],
  ].sort());
  expect(JSON.stringify(report)).not.toContain("arbor://");

  const db = new Database(join(root, "canopy.sqlite3"), { readonly: true });
  expect(rows(db)).toEqual(expected);
  expect(db.query("SELECT key FROM meta WHERE key LIKE 'profile:%'").all()).toEqual([]);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "21" });
  db.close();

  const again = await migrateProfileFacts(root);
  expect(again.migrated).toBe(false);
  expect(again.trees).toEqual(report.trees);
  expect(again.profiles).toEqual([...report.profiles].sort((a, b) => a.tree < b.tree ? -1 : 1));

  const canopy = await HostDaemon.open(root);
  try {
    const bob = canopy.accountByHandle("bob")!;
    expect(canopy.rootProfileType(ids.community)).toBe("group");
    expect(canopy.rootProfileType(ids.club)).toBe("group");
    expect(canopy.rootProfileType(ids.notes)).toBeNull();
    expect(canopy.canRead(bob, ids.notes)).toBe(true);
    expect(canopy.profileCard(ids.ownerProfile).avatar?.path).toBe("me.png");
    expect(canopy.communityMembers().map((member) => member.handle).sort()).toEqual(["bob", "owner"]);
    await canopy.verifyIntegrity();
  } finally {
    await canopy[Symbol.asyncDispose]();
  }
});
