import type { Database } from "bun:sqlite";
import { HANDLE_PATH, PROFILE_LOCATOR, parseProfileLocator, type ObjectHash, type RootProfileFacts, type RootProfileRead } from "@ovst/protocol";
import type { EntryChanges } from "./updates/entry-metadata.ts";

// A profile's card facts are read from objects alone, in @ovst/protocol.
export {
  HANDLE, readRootProfile, rootIndexHash, structuredMembers,
  validateProfileAvatarPath, validateProfileDescription, validateProfileDisplayName,
  type RootProfileFacts, type RootProfileRead,
} from "@ovst/protocol";

/** Stored `profile_facts.facts`. */
export function parseStoredFacts(json: string): RootProfileFacts {
  return JSON.parse(json) as RootProfileFacts;
}

/** The handle a `/~handle` path names, exactly (a trailing slash allowed). */
export function handleOfPath(path: string): string | undefined {
  return HANDLE_PATH.exec(path)?.[1];
}

/** The Profile TreeID an `overstory://<TreeID>/` member locator names. */
export function profileLocatorTree(locator: string | undefined): string | undefined {
  return locator ? PROFILE_LOCATOR.exec(locator)?.[1] : undefined;
}

/** A community reservation: a profile this host holds (its Profile TreeID),
 * a profile another host holds (its locator there, a placement account,
 * accounts §1.3), or a pending invitation's digest. */
export interface MemberReservation {
  profileTree?: string;
  locator?: string;
  inviteDigest?: string;
}

/** The handles a group's members reserve on this host: each structured
 * handle, with the Profile TreeID its `overstory://<TreeID>/` locator names, the
 * canonical locator of a profile another host holds, or its pending
 * invitation's digest. */
export function memberReservations(members: RootProfileFacts["members"]): Map<string, MemberReservation> {
  const reservations = new Map<string, MemberReservation>();
  for (const member of members) {
    const handle = member.handle;
    if (!handle) continue;
    const profileTree = profileLocatorTree(member.profile);
    const locator = profileTree ? null : parseProfileLocator(member.profile);
    reservations.set(handle, profileTree ? { profileTree } : locator ? { locator: locator.locator }
      : member.inviteDigest ? { inviteDigest: member.inviteDigest } : {});
  }
  return reservations;
}

/** A tree's stored profile: its row of `profile_facts`. */
export interface StoredProfile {
  /** The head's root `_index.md` object the facts were read from. */
  indexHash: ObjectHash;
  /** The avatar path the frontmatter declares, even when no file is there, so
   * adding, changing or removing that file recomputes the facts. */
  avatarPath: string | null;
  facts: RootProfileFacts;
}

/** The row a root's profile stores: none unless it declares a type. */
export function storedProfileOf(read: RootProfileRead): StoredProfile | null {
  return read.facts.type && read.indexHash
    ? { indexHash: read.indexHash, avatarPath: read.avatarPath, facts: read.facts }
    : null;
}

const PROFILE_INDEX_PATH = "/_index.md";

/** Whether an accepted update must recompute its tree's profile: its entry
 * changes set or remove the root `_index.md`, or the avatar file the stored
 * row declares. A tree without a row declares no type, so only a change to
 * its `_index.md` can make it a profile. */
export function profileChanged(row: StoredProfile | null, changes: EntryChanges): boolean {
  const paths = new Set([PROFILE_INDEX_PATH, ...(row?.avatarPath ? [`/${row.avatarPath}`] : [])]);
  return changes.set.some((change) => paths.has(change.path)) || changes.removed.some((path) => paths.has(path));
}

/** The `profile_facts` table: one row per tree whose head declares
 * `type: person` or `type: group`. `createHostSchema` and migration 020
 * create it. */
export function createProfileFactsTable(db: Database): void {
  db.run(`
    CREATE TABLE profile_facts (
      tree_id TEXT PRIMARY KEY REFERENCES trees(id),
      index_hash TEXT NOT NULL,
      avatar_path TEXT,
      facts TEXT NOT NULL
    ) WITHOUT ROWID
  `);
}

/** A tree's stored profile, or null: only a tree whose head declares a type has one. */
export function readStoredProfile(db: Database, tree: string): StoredProfile | null {
  const row = db.query("SELECT index_hash, avatar_path, facts FROM profile_facts WHERE tree_id = ?").get(tree) as
    { index_hash: ObjectHash; avatar_path: string | null; facts: string } | null;
  return row ? { indexHash: row.index_hash, avatarPath: row.avatar_path, facts: parseStoredFacts(row.facts) } : null;
}

/** Store or remove a tree's profile, inside the transaction that accepts its head. */
export function writeStoredProfile(db: Database, tree: string, row: StoredProfile | null): void {
  if (!row) {
    db.run("DELETE FROM profile_facts WHERE tree_id = ?", [tree]);
    return;
  }
  db.run(
    `INSERT INTO profile_facts (tree_id, index_hash, avatar_path, facts) VALUES (?, ?, ?, ?)
     ON CONFLICT(tree_id) DO UPDATE SET index_hash = excluded.index_hash, avatar_path = excluded.avatar_path, facts = excluded.facts`,
    [tree, row.indexHash, row.avatarPath, JSON.stringify(row.facts)],
  );
}
