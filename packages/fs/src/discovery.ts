import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { isPageID, nodePathFromPhysical } from "@arbor/core";
import { toTreePath } from "@arbor/core/path";
import { parseMarkdown } from "@arbor/editor";

/**
 * Directory names that are never part of an Arbor tree's authored content:
 * tooling and platform state that discovery, watching, snapshots, and
 * materialization all skip.
 */
export const IGNORED_WORKSPACE_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".arbor",
  "Trash",
  ".build",
  "DerivedData",
]);

export const WORKSPACE_WATCHER_IGNORE_GLOBS = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.arbor/**",
  "**/Trash/**",
  "**/.build/**",
  "**/DerivedData/**",
  "**/*.arbor-txn-*",
  "**/*.arbor-write-*",
];


export interface DiscoveredWorkspaceFile {
  absolutePath: string;
  treePath: string;
  name: string;
}

export interface DiscoveredWorkspaceDirectory {
  absolutePath: string;
  treePath: string;
  name: string;
  childNames: ReadonlySet<string>;
}

export interface WorkspaceDiscovery {
  root: string;
  files: readonly DiscoveredWorkspaceFile[];
  directories: readonly DiscoveredWorkspaceDirectory[];
  pagePathsByID: ReadonlyMap<string, string>;
  pageIDOwners: ReadonlyMap<string, readonly string[]>;
}

export function isIgnoredWorkspaceDirectory(name: string): boolean {
  return IGNORED_WORKSPACE_DIRECTORIES.has(name);
}

export async function discoverWorkspace(
  path: string,
  options: { recursive?: boolean; excludedRoots?: readonly string[] } = {},
): Promise<WorkspaceDiscovery> {
  const root = await realpath(path);
  const excludedRoots = await Promise.all((options.excludedRoots ?? []).map(async (item) =>
    realpath(item).catch(() => resolve(item))
  ));
  const isExcluded = (absolutePath: string): boolean => excludedRoots.some((excluded) => {
    const remainder = relative(excluded, resolve(absolutePath));
    return remainder === "" || (!remainder.startsWith("..") && remainder !== "..");
  });
  const files: DiscoveredWorkspaceFile[] = [];
  const directories: DiscoveredWorkspaceDirectory[] = [];
  const pagePathsByID = new Map<string, string>();
  const pageIDOwners = new Map<string, string[]>();

  const walk = async (absoluteDirectory: string): Promise<void> => {
    if (absoluteDirectory !== root && isExcluded(absoluteDirectory)) return;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch((error) => {
      if (absoluteDirectory === root) throw error;
      return null;
    });
    if (!entries) return;
    const directoryTreePath = toTreePath(root, absoluteDirectory);
    const visibleEntries = entries.filter((entry) => !isExcluded(join(absoluteDirectory, entry.name)));
    directories.push({
      absolutePath: absoluteDirectory,
      treePath: directoryTreePath,
      name: absoluteDirectory === root ? basename(root) : basename(absoluteDirectory),
      childNames: new Set(visibleEntries.map((entry) => entry.name)),
    });

    for (const entry of visibleEntries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        if (options.recursive !== false && !isIgnoredWorkspaceDirectory(entry.name)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const treePath = toTreePath(root, absolutePath);
      files.push({ absolutePath, treePath, name: entry.name });
      if (!entry.name.endsWith(".md")) continue;
      try {
        const id = parseMarkdown(await readFile(absolutePath, "utf8")).frontmatter.id;
        if (isPageID(id)) {
          const path = nodePathFromPhysical(treePath);
          const owners = pageIDOwners.get(id) ?? [];
          owners.push(path);
          pageIDOwners.set(id, owners);
          if (!pagePathsByID.has(id)) pagePathsByID.set(id, path);
        }
      } catch {}
    }
  };

  await walk(root);
  for (const owners of pageIDOwners.values()) owners.sort();
  return { root, files, directories, pagePathsByID, pageIDOwners };
}
