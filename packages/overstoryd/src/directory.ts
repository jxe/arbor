import { canonicalOverstoryLocator, type TreeID } from "@ovst/protocol";
import type { HostDaemon } from "./overstoryd.ts";
import type { HostAccount, HostTree } from "./model.ts";
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

function treeLocator(origin: string, tree: HostTree): string | undefined {
  if (!tree.canonicalPath) return undefined;
  return canonicalOverstoryLocator({ path: tree.canonicalPath as `/${string}`, endpoint: `${origin}/.overstory/trees/${encodeURIComponent(tree.id)}` });
}

export function buildDirectory(overstoryd: HostDaemon, account: HostAccount, origin: string): DirectoryEntry[] {
  const entries = new Map<string, DirectoryEntry>();
  const include = (profile: string, source: DirectorySource, handle?: string) => {
    const existing = entries.get(profile);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (handle && !existing.handle) existing.handle = handle;
    } else entries.set(profile, { profile, kind: "unknown", ...(handle ? { handle } : {}), sources: [source] });
  };

  // Every tree read once; each entry below reuses its row.
  const trees = new Map(overstoryd.list().map((tree) => [tree.id, tree]));
  for (const member of overstoryd.communityMembers()) {
    const profile = profileLocatorTree(member.profile);
    if (profile) include(profile, "community", member.handle);
  }
  // Every group in one query, visited in tree order.
  const groups = new Map(overstoryd.groupProfiles().map(({ tree, facts }) => [tree, facts]));
  for (const group of trees.values()) {
    const facts = groups.get(group.id);
    if (!facts || !overstoryd.canRead(account, group)) continue;
    include(group.id, `group:${group.id}`);
    for (const member of facts.members) {
      const profile = profileLocatorTree(member.profile);
      if (profile) include(profile, `group:${group.id}`, member.handle);
    }
  }
  for (const tree of [...trees.values()].filter((tree) => overstoryd.canAdminister(account, tree))) {
    for (const profile of overstoryd.ruleProfiles(tree.id)) include(profile, "access");
  }

  for (const entry of entries.values()) {
    const tree = trees.get(entry.profile);
    const handle = overstoryd.handleForProfile(entry.profile);
    if (handle) entry.handle = handle;
    if (!tree || !overstoryd.canRead(account, tree)) continue;
    const card = overstoryd.profileCard(tree);
    entry.kind = card.type ?? "unknown";
    const locator = treeLocator(origin, tree);
    if (locator) entry.locator = locator;
    if (card.displayName) entry.displayName = card.displayName;
    else if (card.type === "group" && card.headingTitle) entry.displayName = card.headingTitle;
    if (card.description !== undefined) entry.description = card.description;
    if (card.avatar) entry.avatar = { tree: tree.id, ...card.avatar };
  }

  const key = (entry: DirectoryEntry) => entry.displayName ?? entry.handle ?? entry.locator ?? entry.profile;
  return [...entries.values()].sort((a, b) => key(a).localeCompare(key(b), undefined, { sensitivity: "base" }));
}
