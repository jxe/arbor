import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostTree } from "../../helpers/tree-config.ts";
import { serveHost } from "@overstory/canopyd";
import {
  ProtocolClient, decodeProtocolDirectory, encodeProtocolDirectory, generateArborID, hashObject, 
  type ObjectHash, type ProtocolDirectoryEntry,
} from "@overstory/protocol";
import { PhaseTimer } from "../../../packages/canopyd/src/updates/timing.ts";

const ownerToken = "profile-facts-owner", bobToken = "profile-facts-bob";
let sandbox: string, running: Awaited<ReturnType<typeof serveHost>>, owner: ProtocolClient;
/** A second connection: reads rows and counts writes to `profile_facts`. */
let db: Database;
let ids: { community: string; ownerProfile: string; bobProfile: string; club: string; notes: string };
const parses = spyOn(PhaseTimer.prototype, "count");

const encoder = new TextEncoder(), decoder = new TextDecoder();

/** Replace, add (text) or remove (null) root entries of a tree's head, and submit it. */
async function edit(tree: string, files: Record<string, string | null>) {
  const head = (await owner.descriptor(tree)).tree;
  const snapshot = await owner.snapshot(tree, head.root);
  const objects = new Map(snapshot.objects);
  const root = decodeProtocolDirectory(objects.get(snapshot.root)!);
  if (root.type !== "directory") throw new Error("root is not a directory");
  let entries = root.entries;
  for (const [name, text] of Object.entries(files)) {
    entries = entries.filter((entry) => entry.name !== name);
    if (text === null) continue;
    const bytes = encoder.encode(text), hash = hashObject(bytes);
    objects.set(hash, bytes);
    entries.push({ name, file: hash } as ProtocolDirectoryEntry);
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeProtocolDirectory({ type: "directory", entries }), next = hashObject(bytes);
  objects.set(next, bytes);
  return owner.submitUpdate(tree, head.update, { root: next, objects });
}

/** The head's `_index.md` text. */
async function index(tree: string): Promise<string> {
  const head = (await owner.descriptor(tree)).tree;
  const snapshot = await owner.snapshot(tree, head.root);
  const root = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
  if (root.type !== "directory") throw new Error("root is not a directory");
  return decoder.decode(snapshot.objects.get(root.entries.find((entry) => entry.name === "_index.md")!.file!)!);
}

function row(tree: string) {
  return db.query("SELECT index_hash, avatar_path, facts FROM profile_facts WHERE tree_id = ?").get(tree) as
    { index_hash: ObjectHash; avatar_path: string | null; facts: string } | null;
}
function facts(tree: string) {
  const value = row(tree);
  return value ? JSON.parse(value.facts) : null;
}
function writes(): number {
  return (db.query("SELECT COUNT(*) AS n FROM profile_writes").get() as { n: number }).n;
}
function parseCount(): number {
  return parses.mock.calls.filter(([name]) => name === "profile-parse").length;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-profile-facts-"));
  running = await serveHost({
    dataRoot: join(sandbox, "canopy"),
    accounts: [{ handle: "owner", token: ownerToken, communityWriter: true }, { handle: "bob", token: bobToken, communityWriter: false }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  owner = new ProtocolClient(running.url, ownerToken);
  const account = (await owner.account()).account;
  const snapshotOf = (text: string) => {
    const bytes = encoder.encode(text), file = hashObject(bytes);
    const directory = encodeProtocolDirectory({ type: "directory", entries: [{ name: "_index.md", file }] }), root = hashObject(directory);
    return { root, objects: new Map([[file, bytes], [root, directory]]) };
  };
  const parent = { tree: account.profileTree!, kind: "person" as const };
  const club = await hostTree(owner, snapshotOf("# Club\n"), { parent: { ...parent, name: "club" } });
  const notes = await hostTree(owner, snapshotOf("# Notes\n"), { parent: { ...parent, name: "notes" }, access: [{ who: { profile: club }, allow: ["read"] }] });
  ids = {
    community: running.canopy.community().id,
    ownerProfile: account.profileTree!,
    bobProfile: running.canopy.accountByHandle("bob")!.profileTree!,
    club,
    notes,
  };
  db = new Database(join(sandbox, "canopy", "canopy.sqlite3"));
  db.run("CREATE TABLE profile_writes (tree_id TEXT)");
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    const row = event === "DELETE" ? "OLD" : "NEW";
    db.run(`CREATE TRIGGER profile_writes_${event.toLowerCase()} AFTER ${event} ON profile_facts BEGIN INSERT INTO profile_writes VALUES (${row}.tree_id); END`);
  }
});

afterAll(async () => {
  db.close();
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
  parses.mockRestore();
});

beforeEach(() => {
  parses.mockClear();
  db.run("DELETE FROM profile_writes");
});

test("only trees whose head declares a type have a row, and meta holds no profile rows", () => {
  const trees = (db.query("SELECT tree_id FROM profile_facts ORDER BY tree_id").all() as Array<{ tree_id: string }>).map((r) => r.tree_id);
  expect(trees).toEqual([ids.community, ids.ownerProfile, ids.bobProfile].sort());
  expect(facts(ids.community).type).toBe("group");
  expect(facts(ids.ownerProfile).type).toBe("person");
  expect(db.query("SELECT key FROM meta WHERE key LIKE 'profile:%'").all()).toEqual([]);
});

test("an update that leaves _index.md alone parses nothing and writes no profile row", async () => {
  const before = row(ids.community);
  await edit(ids.community, { "notes.md": "# Notes\n" });
  await edit(ids.ownerProfile, { "journal.md": "# Journal\n" });
  await edit(ids.notes, { "todo.md": "# Todo\n" });
  expect(parseCount()).toBe(0);
  expect(writes()).toBe(0);
  expect(row(ids.community)).toEqual(before);
});

test("a change to _index.md parses it once and updates the row", async () => {
  const text = (await index(ids.ownerProfile)).replace(/^displayName: .*$/m, "displayName: Owner Person");
  const accepted = await edit(ids.ownerProfile, { "_index.md": text });
  expect(parseCount()).toBe(1);
  expect(writes()).toBe(1);
  expect(facts(ids.ownerProfile).displayName).toBe("Owner Person");
  const root = decodeProtocolDirectory((await owner.snapshot(ids.ownerProfile, accepted.update.root)).objects.get(accepted.update.root)!);
  expect(root.type === "directory" && root.entries.find((entry) => entry.name === "_index.md")!.file).toBe(row(ids.ownerProfile)!.index_hash);
  expect(running.canopy.profileCard(ids.ownerProfile).displayName).toBe("Owner Person");
});

test("a change to the declared avatar file updates the row", async () => {
  const text = (await index(ids.ownerProfile)).replace("type: person", "type: person\navatar: me.png");
  await edit(ids.ownerProfile, { "_index.md": text });
  // Declared before its file exists: recorded, but no avatar yet.
  expect(row(ids.ownerProfile)!.avatar_path).toBe("me.png");
  expect(facts(ids.ownerProfile).avatar).toBeUndefined();

  parses.mockClear();
  await edit(ids.ownerProfile, { "me.png": "first" });
  expect(parseCount()).toBe(1);
  expect(facts(ids.ownerProfile).avatar).toEqual({ path: "me.png", hash: hashObject(encoder.encode("first")) });
  await edit(ids.ownerProfile, { "me.png": "second" });
  expect(facts(ids.ownerProfile).avatar).toEqual({ path: "me.png", hash: hashObject(encoder.encode("second")) });
  await edit(ids.ownerProfile, { "me.png": null });
  expect(facts(ids.ownerProfile).avatar).toBeUndefined();
  expect(writes()).toBe(4);

  db.run("DELETE FROM profile_writes");
  await edit(ids.ownerProfile, { "other.png": "unrelated" });
  expect(writes()).toBe(0);
});

test("a tree that gains type: group is a group for authorization in the same accept, and loses its row when it drops type", async () => {
  const bob = running.canopy.accountByHandle("bob")!;
  expect(row(ids.club)).toBeNull();
  expect(running.canopy.canRead(bob, ids.notes)).toBe(false);

  await edit(ids.club, { "_index.md": `---\ntype: group\nmembers:\n  - profile: "arbor://${ids.bobProfile}/"\n---\n# Club\n` });
  expect(running.canopy.rootProfileType(ids.club)).toBe("group");
  expect(running.canopy.canRead(bob, ids.notes)).toBe(true);
  // The directory finds the group through its stored row.
  const response = await fetch(`${running.url}/.arbor/directory`, { headers: { authorization: `Bearer ${ownerToken}` } });
  expect(response.status).toBe(200);
  const directory = await response.json() as { snapshot: Array<{ profile: string; kind: string; sources: string[] }> };
  const club = directory.snapshot.find((entry) => entry.profile === ids.club)!;
  expect(club.kind).toBe("group");
  expect(club.sources).toContain(`group:${ids.club}`);
  expect(directory.snapshot.find((entry) => entry.profile === ids.bobProfile)?.sources).toContain(`group:${ids.club}`);

  await edit(ids.club, { "_index.md": "# Club\n" });
  expect(row(ids.club)).toBeNull();
  expect(running.canopy.rootProfileType(ids.club)).toBeNull();
  expect(running.canopy.canRead(bob, ids.notes)).toBe(false);
});

test("the community's accounts reconcile only when its members change", async () => {
  const setBob = (enabled: number) => db.run("UPDATE accounts SET enabled = ? WHERE handle = 'bob'", [enabled]);
  const bobEnabled = () => (db.query("SELECT enabled FROM accounts WHERE handle = 'bob'").get() as { enabled: number }).enabled;
  setBob(0);
  // The document changes, its members do not.
  await edit(ids.community, { "_index.md": `${await index(ids.community)}\nA garden of people.\n` });
  expect(writes()).toBe(1);
  expect(bobEnabled()).toBe(0);

  // A new member reconciles every account with the members, bob included.
  const text = (await index(ids.community)).replace("members:\n", `members:\n  - profile: "arbor://${generateArborID("tr")}/"\n    handle: carol\n`);
  await edit(ids.community, { "_index.md": text });
  expect(facts(ids.community).members.map((member: { handle?: string }) => member.handle)).toContain("carol");
  expect(bobEnabled()).toBe(1);
});

test("a pending invitation does not reactivate an existing account with the same handle", async () => {
  const current = await index(ids.community);
  const bob = `  -\n    profile: ${JSON.stringify(`arbor://${ids.bobProfile}/`)}\n    handle: "bob"`;
  expect(current).toContain(bob);
  const pending = `  - handle: bob\n    inviteDigest: sha256:${"a".repeat(64)}`;
  await edit(ids.community, { "_index.md": current.replace(bob, pending) });
  expect((db.query("SELECT enabled FROM accounts WHERE handle = 'bob'").get() as { enabled: number }).enabled).toBe(0);
  expect(running.canopy.accountReservation(`${new URL(running.url).origin}/~bob`)?.inviteDigest)
    .toBe(`sha256:${"a".repeat(64)}`);
});
