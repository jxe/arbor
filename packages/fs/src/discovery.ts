import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { isPageID, nodePathFromPhysical, parseMarkdown, type Diagnostic } from "@overstory/protocol";
import { toTreePath } from "@overstory/protocol/path";
import { loadIgnorePolicy, MANDATORY_DIRECTORY_NAMES, type IgnorePolicy } from "./ignore-policy.ts";

/**
 * The mandatory directory names, for the watcher's static globs. Membership
 * decisions go through `IgnorePolicy`, never this set.
 */
export const IGNORED_WORKSPACE_DIRECTORIES: ReadonlySet<string> = MANDATORY_DIRECTORY_NAMES;

/** A watcher optimization only: queued events are still filtered through the policy. */
export const WORKSPACE_WATCHER_IGNORE_GLOBS = [
  ...[...IGNORED_WORKSPACE_DIRECTORIES].map((name) => `**/${name}/**`),
  "**/*.arbor-txn-*",
  "**/*.arbor-write-*",
  "**/.DS_Store",
  "**/._*",
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
  /** Ignore files whose rules could not apply. */
  diagnostics: readonly Diagnostic[];
}

/**
 * Walk a folder's tree content. One membership policy decides both descent
 * and admission; pass `policy` to share one already loaded.
 */
export async function discoverWorkspace(
  path: string,
  options: { recursive?: boolean; excludedRoots?: readonly string[]; policy?: IgnorePolicy } = {},
): Promise<WorkspaceDiscovery> {
  const root = await realpath(path);
  const policy = options.policy ?? await loadIgnorePolicy(root, { excludedRoots: options.excludedRoots });
  const files: DiscoveredWorkspaceFile[] = [];
  const directories: DiscoveredWorkspaceDirectory[] = [];
  const pagePathsByID = new Map<string, string>();
  const pageIDOwners = new Map<string, string[]>();

  const walk = async (absoluteDirectory: string): Promise<void> => {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch((error) => {
      if (absoluteDirectory === root) throw error;
      return null;
    });
    if (!entries) return;
    const directoryTreePath = toTreePath(root, absoluteDirectory);
    const visibleEntries = [];
    for (const entry of entries) {
      const treePath = toTreePath(root, join(absoluteDirectory, entry.name));
      if ((await policy.decision(treePath, entry.isDirectory())).membership === "included") visibleEntries.push(entry);
    }
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
        if (options.recursive !== false) await walk(absolutePath);
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
  return { root, files, directories, pagePathsByID, pageIDOwners, diagnostics: policy.diagnostics };
}
