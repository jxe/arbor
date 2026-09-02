import { parseMarkdown } from "@arbor/editor";
import { decodeWireObject, type ObjectHash } from "@arbor/wire";

export interface RootProfileFacts {
  type: "person" | "group" | null;
  members: string[];
}

/**
 * The profile facts a tree root declares in its `_index.md` frontmatter: the
 * `type` and the normalized `host/~handle` of every authored member locator.
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
  const members = declared.flatMap((value) => {
    if (typeof value !== "string") return [];
    const match = /arbor:\/\/([^/\s"']+)\/~([a-z0-9][a-z0-9-]{0,62})/.exec(value);
    return match ? [`${match[1]!.toLowerCase()}/~${match[2]!}`] : [];
  });
  return { type, members: [...new Set(members)] };
}
