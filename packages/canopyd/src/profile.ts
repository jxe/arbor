import { parseMarkdown, plainMarkdownTitle, decodeWireDirectory, type ObjectHash } from "@overstory/protocol";

const PROFILE_LOCATOR = /^arbor:\/\/tr_[a-z2-7]+\/?$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

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
  const directory = decodeWireDirectory(await load(root));
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
        current = decodeWireDirectory(await load(entry.directory));
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
