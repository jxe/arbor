import { parseMarkdown } from "@arbor/editor";
import { decodeWireObject, type ObjectHash } from "@arbor/wire";

const PROFILE_LOCATOR = /^arbor:\/\/tr_[a-z2-7]+\/?$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

export interface RootProfileFacts {
  type: "person" | "group" | null;
  members: Array<{ profile: string; handle?: string; legacy?: true }>;
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
  const none: RootProfileFacts = { type: null, members: [] };
  const directory = decodeWireObject(await load(root));
  if (directory.type !== "directory") return none;
  const index = directory.entries.find((entry) => entry.name === "_index.md");
  if (!index?.hash) return none;
  const file = decodeWireObject(await load(index.hash));
  if (file.type !== "file") return none;
  const { frontmatter } = parseMarkdown(new TextDecoder().decode(file.bytes));
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
  return { type, members };
}
