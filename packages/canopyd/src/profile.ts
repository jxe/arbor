import type { Database } from "bun:sqlite";
import { parseMarkdown, plainMarkdownTitle, decodeProtocolDirectory, type ObjectHash } from "@overstory/protocol";

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
 * Canopy caches these by immutable root hash so authorization never reparses
 * mutable state; the offline migration rebuilds the same cache.
 */
export async function rootProfileFacts(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>): Promise<RootProfileFacts> {
  const none: RootProfileFacts = { version: 3, type: null, members: [] };
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
    version: 3,
    type,
    members,
    ...(displayName ? { displayName } : {}),
    ...(headingTitle ? { headingTitle } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(avatar ? { avatar } : {}),
  };
}

/** A root's stored profile facts (`meta` key `profile:<root>`), or null. Only
 * accepted person and group profile roots have a row, written with their
 * acceptance; migration 016 rebuilt the rows for every current head. */
export function storedProfileFacts(db: Database, root: ObjectHash): RootProfileFacts | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(`profile:${root}`) as { value: string } | null;
  return row ? JSON.parse(row.value) as RootProfileFacts : null;
}

/** Store a profile root's facts, inside the transaction that accepts it. A
 * root that declares neither person nor group gets no row. */
export function recordProfileFacts(db: Database, root: ObjectHash, facts: RootProfileFacts | null): void {
  if (!facts?.type) return;
  db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [`profile:${root}`, JSON.stringify(facts)],
  );
}
