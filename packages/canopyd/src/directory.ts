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

export async function buildDirectory(canopy: HostDaemon, account: HostAccount, origin: string): Promise<DirectoryEntry[]> {
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
  for (const group of active.filter((tree) => canopy.rootProfileType(tree.ref) === "group" && canopy.canRead(account, tree))) {
    include(group.id, `group:${group.id}`);
    const facts = await canopy.profileCard(group.ref);
    for (const member of facts.members) {
      const profile = profileLocatorTree(member.profile);
      if (profile) include(profile, `group:${group.id}`, member.handle);
    }
  }
  for (const tree of active.filter((tree) => tree.accountID === account.id)) {
    for (const rule of canopy.accessEntries(tree.id)) if (rule.subjectKind === "profile") include(rule.subject, "access");
  }

  await Promise.all([...entries.values()].map(async (entry) => {
    const tree = trees.get(entry.profile);
    const handle = canopy.handleForProfile(entry.profile);
    if (handle) entry.handle = handle;
    if (!tree || !canopy.canRead(account, tree)) return;
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
