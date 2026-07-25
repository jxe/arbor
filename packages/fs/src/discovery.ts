import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { isPageID, nodePathFromPhysical, toTreePath } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";

export const IGNORED_WORKSPACE_DIRECTORIES = new Set([
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

export async function discoverWorkspace(path: string): Promise<WorkspaceDiscovery> {
  const root = await realpath(path);
  const files: DiscoveredWorkspaceFile[] = [];
  const directories: DiscoveredWorkspaceDirectory[] = [];
  const pagePathsByID = new Map<string, string>();
  const pageIDOwners = new Map<string, string[]>();

  const walk = async (absoluteDirectory: string): Promise<void> => {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const directoryTreePath = toTreePath(root, absoluteDirectory);
    directories.push({
      absolutePath: absoluteDirectory,
      treePath: directoryTreePath,
      name: absoluteDirectory === root ? basename(root) : basename(absoluteDirectory),
      childNames: new Set(entries.map((entry) => entry.name)),
    });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredWorkspaceDirectory(entry.name)) await walk(absolutePath);
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
