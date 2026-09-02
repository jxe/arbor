/**
 * Directory names that are never part of an Arbor tree's authored content:
 * tooling and platform state that discovery, watching, snapshots, and
 * materialization all skip. Shared here so the wire replica support and the
 * filesystem layer agree without the wire package depending on the watcher.
 */
export const IGNORED_WORKSPACE_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".arbor",
  "Trash",
  ".build",
  "DerivedData",
]);
