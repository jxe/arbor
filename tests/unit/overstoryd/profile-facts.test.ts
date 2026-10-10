import { describe, expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, type ObjectHash, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HostDaemon, currentProfileSpelling, memberReservations, parseStoredFacts, profileChanged, profileLocatorTree,
  readRootProfile, rootIndexHash, storedProfileOf,
} from "@ovst/overstoryd";
import { testAccount } from "../../helpers/devices.ts";

const rootProfileFacts = async (root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>) => (await readRootProfile(root, load)).facts;

function fixture(frontmatter: string, files: Record<string, Uint8Array> = {}, title = "Profile") {
  const objects = new Map<ObjectHash, Uint8Array>();
  const index = new TextEncoder().encode(`---\n${frontmatter}\n---\n\n# ${title}\n`);
  const indexHash = hashObject(index);
  objects.set(indexHash, index);
  const rootEntries: ProtocolDirectoryEntry[] = [{ name: "_index.md", file: indexHash }];
  const nested = new Map<string, ProtocolDirectoryEntry[]>();
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split("/");
    const file = hashObject(bytes);
    objects.set(file, bytes);
    if (parts.length === 1) rootEntries.push({ name: parts[0]!, file });
    else nested.set(parts[0]!, [{ name: parts[1]!, file }]);
  }
  for (const [name, entries] of nested) {
    const bytes = encodeProtocolDirectory({ type: "directory", entries });
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    rootEntries.push({ name, directory: hash });
  }
  const rootBytes = encodeProtocolDirectory({ type: "directory", entries: rootEntries });
  const root = hashObject(rootBytes);
  objects.set(root, rootBytes);
  return { root, load: async (hash: ObjectHash) => {
    const value = objects.get(hash);
    if (!value) throw new Error(`Missing ${hash}`);
    return value;
  } };
}

describe("profile presentation facts", () => {
  test("accepts bounded card fields and resolves a nested avatar", async () => {
    const source = fixture('type: person\ndisplayName: "  José Story  "\ndescription: Builder\navatar: images/me.webp', {
      "images/me.webp": new Uint8Array([1, 2, 3]),
    });
    const facts = await rootProfileFacts(source.root, source.load);
    expect(facts).toMatchObject({ type: "person", displayName: "José Story", description: "Builder", avatar: { path: "images/me.webp" } });
  });

  test("drops malformed and unavailable card fields without rejecting identity", async () => {
    for (const avatar of ["../x.png", "/x.png", "https://example/x.png", "missing.png"]) {
      const source = fixture(`type: group\ndisplayName: "${"x".repeat(81)}"\ndescription: "${"y".repeat(501)}"\navatar: ${avatar}`);
      expect(await rootProfileFacts(source.root, source.load)).toEqual({
        type: "group",
        members: [],
        headingTitle: "Profile",
      });
    }
  });

  test("keeps the first H1 as a group directory title without inventing a displayName", async () => {
    const source = fixture("type: group\nmembers: []", {}, "**Garden Club**");
    expect(await rootProfileFacts(source.root, source.load)).toMatchObject({
      type: "group",
      headingTitle: "Garden Club",
    });
    expect((await rootProfileFacts(source.root, source.load)).displayName).toBeUndefined();
  });

  test("ignores a bare-string member, keeping only structured entries", async () => {
    const profile = "overstory://tr_aaaaaaaaaaaaaaaaaaaaaaaaaa/";
    const source = fixture(`type: group\nmembers:\n  - /~alice\n  - ${profile}\n  - profile: ${profile}\n    handle: bob`);
    expect((await rootProfileFacts(source.root, source.load)).members).toEqual([{ profile, handle: "bob" }]);
  });
});

describe("stored profile rows", () => {
  test("a read records the _index.md object and the declared avatar path, even when its file is missing", async () => {
    const source = fixture("type: person\navatar: missing.png");
    const read = await readRootProfile(source.root, source.load);
    expect(read.facts.avatar).toBeUndefined();
    expect(read.avatarPath).toBe("missing.png");
    expect(read.indexHash).toBe(await rootIndexHash(source.root, source.load));
    expect(storedProfileOf(read)).toEqual({ indexHash: read.indexHash!, avatarPath: "missing.png", facts: read.facts });
  });

  test("a root that declares no type stores no row", async () => {
    const source = fixture("title: Notes");
    expect(storedProfileOf(await readRootProfile(source.root, source.load))).toBeNull();
  });

  test("only _index.md and the row's declared avatar path decide a recompute", () => {
    const sha = `sha256:${"0".repeat(64)}` as ObjectHash;
    const row = { indexHash: sha, avatarPath: "images/me.png", facts: { type: "person" as const, members: [] } };
    const set = (path: string) => ({ set: [{ path, hash: sha }], removed: [] });
    const removed = (path: string) => ({ set: [], removed: [path] });
    expect(profileChanged(row, set("/_index.md"))).toBe(true);
    expect(profileChanged(row, removed("/_index.md"))).toBe(true);
    expect(profileChanged(row, set("/images/me.png"))).toBe(true);
    expect(profileChanged(row, removed("/images/me.png"))).toBe(true);
    expect(profileChanged(row, set("/notes.md"))).toBe(false);
    expect(profileChanged(row, set("/sub/_index.md"))).toBe(false);
    expect(profileChanged(null, set("/_index.md"))).toBe(true);
    expect(profileChanged(null, set("/images/me.png"))).toBe(false);
  });
});

// Rename 002: these cover the `arbor://` read alias and go with it.
describe("member locators written before the rename", () => {
  const tree = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const old = `arbor://${tree}/`, current = `overstory://${tree}/`;

  test("both spellings name the same profile tree, and anything else names none", () => {
    expect(profileLocatorTree(old)).toBe(tree);
    expect(profileLocatorTree(current)).toBe(tree);
    expect(profileLocatorTree(`arbor://${tree}`)).toBe(tree);
    expect(profileLocatorTree(`story://${tree}/`)).toBeUndefined();
    expect(profileLocatorTree(`https://${tree}/`)).toBeUndefined();
  });

  test("an authored old-spelling member is read, and its facts carry the current spelling", async () => {
    const source = fixture(`type: group\nmembers:\n  - profile: ${old}\n    handle: bob\n  - profile: ${current}\n    handle: carol`);
    const { members } = await rootProfileFacts(source.root, source.load);
    expect(members).toEqual([{ profile: current, handle: "bob" }, { profile: current, handle: "carol" }]);
    expect(memberReservations(members).get("bob")).toEqual({ profileTree: tree });
  });

  test("stored facts in the old spelling are read as the current one", () => {
    const stored = JSON.stringify({ type: "group", members: [{ profile: old, handle: "bob" }, { handle: "dan", inviteDigest: `sha256:${"a".repeat(64)}` }, { profile: "https://other.example/~eve", handle: "eve" }] });
    expect(parseStoredFacts(stored).members).toEqual([
      { profile: current, handle: "bob" },
      { handle: "dan", inviteDigest: `sha256:${"a".repeat(64)}` },
      { profile: "https://other.example/~eve", handle: "eve" },
    ]);
    expect(currentProfileSpelling(current)).toBe(current);
    expect(currentProfileSpelling("arbor://other.example/~eve")).toBe("arbor://other.example/~eve");
  });

  test("a host writes overstory:// members, and still recognizes them in a database that stores arbor://", async () => {
    const root = await mkdtemp(join(tmpdir(), "overstoryd-member-locators-"));
    try {
      const first = await HostDaemon.open(root, { handle: "community", name: "Community", accounts: [testAccount("owner", "owner-token", { communityWriter: true })] });
      const profile = first.accountByHandle("owner")!.id;
      const community = first.community().id;
      expect(first.communityMembers()).toContainEqual({ profile: `overstory://${profile}/`, handle: "owner" });
      await first[Symbol.asyncDispose]();

      const db = new Database(join(root, "overstoryd.sqlite3"));
      const before = db.query("SELECT facts FROM profile_facts WHERE tree_id = ?").get(community) as { facts: string };
      expect(before.facts).toContain("overstory://");
      expect(before.facts).not.toContain("arbor://");
      db.run("UPDATE profile_facts SET facts = replace(facts, 'overstory://', 'arbor://')");
      db.close();

      const reopened = await HostDaemon.open(root);
      try {
        expect(reopened.communityMembers()).toContainEqual({ profile: `overstory://${profile}/`, handle: "owner" });
        expect(reopened.groupProfiles().find((group) => group.tree === community)!.facts.members)
          .toContainEqual({ profile: `overstory://${profile}/`, handle: "owner" });
        const owner = reopened.accountByHandle("owner")!;
        expect(reopened.canWrite(owner, community)).toBe(true);
      } finally {
        await reopened[Symbol.asyncDispose]();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
