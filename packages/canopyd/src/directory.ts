import { canonicalArborLocator, type TreeID } from "@overstory/protocol";
import type { HostDaemon } from "./canopy.ts";
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
  return canonicalArborLocator({ path: tree.canonicalPath as `/${string}`, endpoint: `${origin}/.arbor/trees/${encodeURIComponent(tree.id)}` });
}

export function buildDirectory(canopy: HostDaemon, account: HostAccount, origin: string): DirectoryEntry[] {
  const entries = new Map<string, DirectoryEntry>();
  const include = (profile: string, source: DirectorySource, handle?: string) => {
    const existing = entries.get(profile);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (handle && !existing.handle) existing.handle = handle;
    } else entries.set(profile, { profile, kind: "unknown", ...(handle ? { handle } : {}), sources: [source] });
  };

  // Every tree read once; each entry below reuses its row.
  const trees = new Map(canopy.list().map((tree) => [tree.id, tree]));
  const active = [...trees.values()].filter((tree) => tree.status === "active");
  for (const member of canopy.communityMembers()) {
    const profile = profileLocatorTree(member.profile);
    if (profile) include(profile, "community", member.handle);
  }
  // Every active group in one query, visited in tree order.
  const groups = new Map(canopy.groupProfiles().map(({ tree, facts }) => [tree, facts]));
  for (const group of active) {
    const facts = groups.get(group.id);
    if (!facts || !canopy.canRead(account, group)) continue;
    include(group.id, `group:${group.id}`);
    for (const member of facts.members) {
      const profile = profileLocatorTree(member.profile);
      if (profile) include(profile, `group:${group.id}`, member.handle);
    }
  }
  for (const tree of active.filter((tree) => canopy.canAdminister(account, tree))) {
    for (const rule of canopy.accessEntries(tree.id)) if (rule.subjectKind === "profile") include(rule.subject, "access");
  }

  for (const entry of entries.values()) {
    const tree = trees.get(entry.profile);
    const handle = canopy.handleForProfile(entry.profile);
    if (handle) entry.handle = handle;
    if (!tree || !canopy.canRead(account, tree)) continue;
    const card = canopy.profileCard(tree);
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
