import { canonicalArborLocator, type TreeID } from "@overstory/protocol";
import type { CanopyDaemon } from "./canopy.ts";
import type { CanopyAccount, CanopyTree } from "./model.ts";
import { profileLocatorTree } from "./profile.ts";

export type DirectorySource = "community" | `group:${TreeID}` | "access";

export interface DirectoryEntry {
  profile: TreeID;
  kind: "person" | "group" | "unknown";
  handle?: string;
  locator?: string;
  displayName?: string;
  description?: string;
  avatar?: { tree: TreeID; path: string; hash: string };
  sources: DirectorySource[];
}

function treeLocator(origin: string, tree: CanopyTree): string | undefined {
  if (!tree.canonicalPath) return undefined;
  return canonicalArborLocator({ path: tree.canonicalPath as `/${string}`, endpoint: `${origin}/.arbor/trees/${encodeURIComponent(tree.id)}` });
}

export async function buildDirectory(canopy: CanopyDaemon, account: CanopyAccount, origin: string): Promise<DirectoryEntry[]> {
  const entries = new Map<string, DirectoryEntry>();
  const include = (profile: string, source: DirectorySource, handle?: string) => {
    const existing = entries.get(profile);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (handle && !existing.handle) existing.handle = handle;
    } else entries.set(profile, { profile, kind: "unknown", ...(handle ? { handle } : {}), sources: [source] });
  };

  for (const member of canopy.communityMembers()) {
    const profile = profileLocatorTree(member.profile);
    if (profile) include(profile, "community", member.handle);
  }
  for (const group of canopy.readableGroupTrees(account)) {
    include(group.id, `group:${group.id}`);
    const facts = await canopy.profileCard(group.ref);
    for (const member of facts.members) {
      const profile = profileLocatorTree(member.profile);
      if (profile) include(profile, `group:${group.id}`, member.handle);
    }
  }
  for (const tree of canopy.administeredTrees(account)) {
    for (const rule of canopy.accessEntries(tree.id)) if (rule.subjectKind === "profile") include(rule.subject, "access");
  }

  await Promise.all([...entries.values()].map(async (entry) => {
    const tree = canopy.get(entry.profile);
    const handle = canopy.handleForProfile(entry.profile);
    if (handle) entry.handle = handle;
    if (!tree || !canopy.canRead(account, tree.id)) return;
    const card = await canopy.profileCard(tree.ref);
    entry.kind = card.type ?? "unknown";
    const locator = treeLocator(origin, tree);
    if (locator) entry.locator = locator;
    if (card.displayName) entry.displayName = card.displayName;
    else if (card.type === "group" && card.headingTitle) entry.displayName = card.headingTitle;
    if (card.description !== undefined) entry.description = card.description;
    if (card.avatar) entry.avatar = { tree: tree.id, ...card.avatar };
  }));

  const key = (entry: DirectoryEntry) => entry.displayName ?? entry.handle ?? entry.locator ?? entry.profile;
  return [...entries.values()].sort((a, b) => key(a).localeCompare(key(b), undefined, { sensitivity: "base" }));
}
