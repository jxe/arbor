// A profile tree's card facts as its root `_index.md` declares them
// (accounts §1): read from objects alone, so a host and any client reading
// through the API agree on them.

import { parseMarkdown } from "./documents/markdown.ts";
import { plainMarkdownTitle } from "./documents/display-title.ts";
import { parseProfileLocator } from "./model/resource-policy.ts";
import { decodeProtocolDirectory, loadProtocolContent, protocolContentObject, type ObjectHash } from "./objects.ts";

const HANDLE_SOURCE = "[a-z0-9][a-z0-9-]{0,62}";
/** A host-local account handle, the name in `/~handle`. */
export const HANDLE = new RegExp(`^${HANDLE_SOURCE}$`);
export const HANDLE_PATH = new RegExp(`^/~(${HANDLE_SOURCE})/?$`);
export const PROFILE_LOCATOR = /^overstory:\/\/(tr_[a-z2-7]+)\/?$/;

export interface RootProfileFacts {
  type: "person" | "group" | null;
  members: Array<{ profile?: string; handle?: string; inviteDigest?: string }>;
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

/** A root's profile as a host reads it for its tree: the facts, and what
 * decides whether a later update must recompute them.
 *
 * The facts are what the root declares in its `_index.md` frontmatter: the
 * `type` and each structured member's profile locator / host-local
 * handle; a member that is not a well-formed structured entry, including a
 * bare string, is ignored. Structured members keep identity separate from
 * this host's allocation policy. overstoryd stores them per tree
 * (`profile_facts`) so authorization never reparses mutable state; migration
 * 020 rebuilt the rows for every head. */
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
  return protocolContentObject(directory.entries.find((entry) => entry.name === "_index.md")) ?? null;
}

/** A root's frontmatter `members`, keeping only well-formed structured
 * entries: a profile locator (with an optional handle), or a pending
 * invitation's handle and digest. A profile is `overstory://<TreeID>/`, or the
 * canonical locator of a profile another host holds, which counts only where
 * this host pinned it (the community, accounts §1.3). A scalar entry names no
 * member. */
export function structuredMembers(declared: unknown): RootProfileFacts["members"] {
  return (Array.isArray(declared) ? declared : []).flatMap((value): RootProfileFacts["members"] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    const profile = typeof candidate.profile === "string" && PROFILE_LOCATOR.test(candidate.profile) ? candidate.profile
      : parseProfileLocator(candidate.profile)?.locator;
    const handle = typeof candidate.handle === "string" && HANDLE.test(candidate.handle) ? candidate.handle : undefined;
    const inviteDigest = typeof candidate.inviteDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(candidate.inviteDigest)
      ? candidate.inviteDigest : undefined;
    if (!(profile && !inviteDigest) && !(handle && inviteDigest && !profile)) return [];
    if (Object.keys(candidate).some((key) => key !== "profile" && key !== "handle" && key !== "inviteDigest")) return [];
    return [{ ...(profile ? { profile } : {}), ...(handle ? { handle } : {}), ...(inviteDigest ? { inviteDigest } : {}) }];
  });
}

/** A root's profile facts with its `_index.md` hash and the declared avatar
 * path. It parses `_index.md` once. A reader that needs only the card's text
 * passes `avatar: false`, and the avatar is neither found nor loaded. */
export async function readRootProfile(root: ObjectHash, load: (hash: ObjectHash) => Promise<Uint8Array>, options: { avatar?: boolean } = {}): Promise<RootProfileRead> {
  const none: RootProfileRead = { facts: { type: null, members: [] }, indexHash: null, avatarPath: null };
  const directory = decodeProtocolDirectory(await load(root));
  if (directory.type !== "directory") return none;
  const index = directory.entries.find((entry) => entry.name === "_index.md");
  const indexHash = protocolContentObject(index);
  if (!index || !indexHash) return none;
  const file = await loadProtocolContent(index, load);
  const document = parseMarkdown(new TextDecoder().decode(file));
  const { frontmatter } = document;
  const type = frontmatter.type === "person" || frontmatter.type === "group" ? frontmatter.type : null;
  const members = structuredMembers(frontmatter.members);
  const displayName = validateProfileDisplayName(frontmatter.displayName);
  const headingTitle = type === "group"
    ? plainMarkdownTitle(document.blocks.find(
        (block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1,
      )?.content ?? "") || undefined
    : undefined;
  const description = validateProfileDescription(frontmatter.description);
  const avatarPath = validateProfileAvatarPath(frontmatter.avatar);
  let avatar: RootProfileFacts["avatar"];
  if (avatarPath && options.avatar !== false) {
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
      type,
      members,
      ...(displayName ? { displayName } : {}),
      ...(headingTitle ? { headingTitle } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(avatar ? { avatar } : {}),
    },
    indexHash,
    avatarPath: avatarPath ?? null,
  };
}
