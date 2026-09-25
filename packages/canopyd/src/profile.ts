import type { Database } from "bun:sqlite";
import { parseMarkdown, plainMarkdownTitle, decodeProtocolDirectory, type ObjectHash } from "@overstory/protocol";
import type { EntryChanges } from "./updates/entry-metadata.ts";

const HANDLE_SOURCE = "[a-z0-9][a-z0-9-]{0,62}";
/** A Canopy-local account handle, the name in `/~handle`. */
export const HANDLE = new RegExp(`^${HANDLE_SOURCE}$`);
const HANDLE_PATH = new RegExp(`^/~(${HANDLE_SOURCE})/?$`);
const HANDLE_PREFIX = new RegExp(`^/~(${HANDLE_SOURCE})(?:/|$)`);
const PROFILE_LOCATOR = /^arbor:\/\/(tr_[a-z2-7]+)\/?$/;
const LEGACY_HANDLE_LOCATOR = new RegExp(`/~(${HANDLE_SOURCE})/?$`);

/** The handle a `/~handle` path names, exactly (a trailing slash allowed). */
export function handleOfPath(path: string): string | undefined {
  return HANDLE_PATH.exec(path)?.[1];
}

/** The handle in a path's leading `/~handle` segment, if it has one. */
export function leadingHandle(path: string): string | undefined {
  return HANDLE_PREFIX.exec(path)?.[1];
}

/** The Profile TreeID an `arbor://<TreeID>/` member locator names. */
export function profileLocatorTree(locator: string): string | undefined {
  return PROFILE_LOCATOR.exec(locator)?.[1];
}

/** The handle a legacy scalar member's `/~handle` locator names. */
export function legacyMemberHandle(member: { profile: string; legacy?: true }): string | undefined {
  return member.legacy ? LEGACY_HANDLE_LOCATOR.exec(member.profile)?.[1] : undefined;
}

/** The handles a group's members reserve on this Canopy: each structured
 * handle, with the Profile TreeID its locator names, and each legacy
 * `/~handle` locator's handle, which names no profile. */
export function memberReservations(members: RootProfileFacts["members"]): Map<string, { profileTree?: string }> {
  const reservations = new Map<string, { profileTree?: string }>();
  for (const member of members) {
    const handle = member.handle ?? legacyMemberHandle(member);
    if (!handle) continue;
    const profileTree = member.legacy ? undefined : profileLocatorTree(member.profile);
    reservations.set(handle, profileTree ? { profileTree } : {});
  }
  return reservations;
}

export interface RootProfileFacts {
  version: 3;
  type: "person" | "group" | null;
  members: Array<{ profile: string; handle?: string; legacy?: true }>;
  displayName?: string;
  headingTitle?: string;
  description?: string;
  avatar?: { path: string; hash: ObjectHash };
}

function scalarCount(value: string): number { return [...value].length; }

export function validateProfileDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && scalarCount(trimmed) <= 80 && !/[\r\n]/.test(trimmed) ? trimmed : undefined;
}

export function validateProfileDescription(value: unknown): string | undefined {
  return typeof value === "string" && scalarCount(value) <= 500 ? value : undefined;
}

export function validateProfileAvatarPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return /\.(?:png|jpe?g|gif|webp)$/i.test(parts.at(-1)!) ? value : undefined;
}

/**
 * The profile facts a tree root declares in its `_index.md` frontmatter: the
 * `type` and each authored profile locator / Canopy-local handle. String
 * members remain a v1 shorthand; structured members keep identity separate
 * from this Canopy's allocation policy.
 * canopyd stores them per tree (`profile_facts`) so authorization never
 * reparses mutable state; migration 020 rebuilt the rows for every head.
 */
export async function rootProfileFacts(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<RootProfileFacts> {
  return (await readRootProfile(root, load)).facts;
}

/** A root's profile as canopyd reads it for its tree: the facts, and what
 * decides whether a later update must recompute them. */
export interface RootProfileRead {
  facts: RootProfileFacts;
  /** The root `_index.md` file object, or null when the root has none. */
  indexHash: ObjectHash | null;
  /** The avatar path the frontmatter declares, whether or not a file is there. */
  avatarPath: string | null;
}

/** The root `_index.md` file object, read from the root directory alone. */
export async function rootIndexHash(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<ObjectHash | null> {
  const directory = decodeProtocolDirectory(await load(root));
  if (directory.type !== "directory") return null;
  return directory.entries.find((entry) => entry.name === "_index.md")?.file ?? null;
}

/** `rootProfileFacts` with the root `_index.md` hash and the declared avatar
 * path. It parses `_index.md` once. */
export async function readRootProfile(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<RootProfileRead> {
  const none: RootProfileRead = { facts: { version: 3, type: null, members: [] }, indexHash: null, avatarPath: null };
  const directory = decodeProtocolDirectory(await load(root));
  if (directory.type !== "directory") return none;
  const index = directory.entries.find((entry) => entry.name === "_index.md");
  if (!index?.file) return none;
  const file = await load(index.file);
  const document = parseMarkdown(new TextDecoder().decode(file));
  const { frontmatter } = document;
  const type = frontmatter.type === "person" || frontmatter.type === "group" ? frontmatter.type : null;
  const declared = Array.isArray(frontmatter.members) ? frontmatter.members : [];
  const members = declared.flatMap((value): RootProfileFacts["members"] => {
    if (typeof value === "string") return [{ profile: value, legacy: true }];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    const profile = typeof candidate.profile === "string" && PROFILE_LOCATOR.test(candidate.profile) ? candidate.profile : undefined;
    const handle = typeof candidate.handle === "string" && HANDLE.test(candidate.handle) ? candidate.handle : undefined;
    if (!profile) return [];
    if (Object.keys(candidate).some((key) => key !== "profile" && key !== "handle")) return [];
    return [{ profile, ...(handle ? { handle } : {}) }];
  });
  const displayName = validateProfileDisplayName(frontmatter.displayName);
  const headingTitle = type === "group"
    ? plainMarkdownTitle(document.blocks.find(
        (block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1,
      )?.content ?? "") || undefined
    : undefined;
  const description = validateProfileDescription(frontmatter.description);
  const avatarPath = validateProfileAvatarPath(frontmatter.avatar);
  let avatar: RootProfileFacts["avatar"];
  if (avatarPath) {
    try {
      const parts = avatarPath.split("/");
      let current = directory;
      for (const part of parts.slice(0, -1)) {
        const entry = current.entries.find((candidate) => candidate.name === part);
        if (!entry?.directory) throw new Error("Avatar directory is missing");
        current = decodeProtocolDirectory(await load(entry.directory));
      }
      const file = current.entries.find((entry) => entry.name === parts.at(-1))?.file;
      if (!file) throw new Error("Avatar file is missing");
      await load(file);
      avatar = { path: avatarPath, hash: file };
    } catch {}
  }
  return {
    facts: {
      version: 3,
      type,
      members,
      ...(displayName ? { displayName } : {}),
      ...(headingTitle ? { headingTitle } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(avatar ? { avatar } : {}),
    },
    indexHash: index.file,
    avatarPath: avatarPath ?? null,
  };
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
  return row ? { indexHash: row.index_hash, avatarPath: row.avatar_path, facts: JSON.parse(row.facts) as RootProfileFacts } : null;
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
