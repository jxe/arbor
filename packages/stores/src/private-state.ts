import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Diagnostic } from "@arbor/core";
import { sha256 } from "@arbor/core";

export interface WorkspaceRegistryRecord {
  stateID: string;
  rootID: string;
  path: string;
  device?: string;
  inode?: string;
}

export interface WorkspaceState {
  identity: WorkspaceRegistryRecord;
  directory: string;
}

export class AmbiguousWorkspaceIdentityError extends Error {
  constructor(
    readonly path: string,
    readonly previousPaths: string[],
  ) {
    super(`Several private workspace records match ${path}: ${previousPaths.join(", ")}`);
    this.name = "AmbiguousWorkspaceIdentityError";
  }
}

type StoredWorkspaceRegistry = Record<string, string | WorkspaceRegistryRecord>;

/**
 * Arbor's one default local state home. Tests and isolated runs may override
 * it; the test preload also sets ARBOR_REQUIRE_DATA_HOME so that a test which
 * loses its override fails instead of preparing the developer's real home.
 */
export function arborDataRoot(): string {
  const explicit = process.env.ARBOR_DATA_HOME;
  const fallback = join(homedir(), ".arbor");
  if (process.env.ARBOR_REQUIRE_DATA_HOME) {
    if (!explicit) throw new Error("ARBOR_DATA_HOME is unset while ARBOR_REQUIRE_DATA_HOME forbids the default Arbor data home");
    if (explicit === fallback || explicit.startsWith(`${fallback}/`)) {
      throw new Error(`ARBOR_DATA_HOME (${explicit}) is the real Arbor data home, which ARBOR_REQUIRE_DATA_HOME forbids`);
    }
  }
  return explicit || fallback;
}

export function arborPrivateRoot(): string {
  return join(arborDataRoot(), ".state");
}

function rootIDForInitialPath(path: string): string {
  return `rt_${sha256(path).slice(0, 10)}`;
}

async function pathKind(path: string): Promise<"missing" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Prepare the selected data home. An explicit ARBOR_DATA_HOME is isolated:
 * it never consults the user's default state.
 */
export async function prepareArborDataRoot(): Promise<Diagnostic[]> {
  const target = arborDataRoot();
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700).catch(() => {});
  await mkdir(arborPrivateRoot(), { recursive: true, mode: 0o700 });
  await migratePrivateState(target);
  await reconcilePrivateStateVersion(arborPrivateRoot());
  return [];
}

/**
 * The private-state version this build writes. It changes whenever the wire
 * format or the daemon's rebuildable state changes shape, and is the client
 * half of the schema stamp Canopy asserts at startup.
 */
export const ARBOR_SYNC_STATE_VERSION = "2";

const REBUILDABLE_PRIVATE_ENTRIES = ["sync", "refs"] as const;

/**
 * A private state written by an older build discards what can be rebuilt,
 * the per-tree sync journals, placement refs, and workspace indexes, so every
 * placement re-places itself from a snapshot on the next pass; authored files
 * are compared byte for byte before anything is rewritten. Credentials,
 * device identity, and system records are kept.
 */
async function reconcilePrivateStateVersion(state: string): Promise<void> {
  const stampPath = join(state, "version");
  const stamp = await readFile(stampPath, "utf8").then((value) => value.trim()).catch(() => null);
  if (stamp === ARBOR_SYNC_STATE_VERSION) return;
  // An unstamped state that already holds placement refs was written by a build
  // before the stamp existed; an unstamped state without them is new.
  const olderBuild = stamp !== null || await pathKind(join(state, "refs")) !== "missing";
  if (olderBuild) {
    for (const name of REBUILDABLE_PRIVATE_ENTRIES) await rm(join(state, name), { recursive: true, force: true });
    const workspaces = join(state, "workspaces");
    if (await pathKind(workspaces) === "directory") {
      for (const id of await readdir(workspaces)) {
        const directory = join(workspaces, id);
        if (await pathKind(directory) !== "directory") continue;
        for (const name of await readdir(directory)) {
          if (name.startsWith("index")) await rm(join(directory, name), { recursive: true, force: true });
        }
      }
    }
  }
  await writeFile(stampPath, `${ARBOR_SYNC_STATE_VERSION}\n`, { mode: 0o600 });
}

const LEGACY_PRIVATE_ENTRIES = [
  "system",
  "sync",
  "workspaces",
  "workspaces.json",
  "LinkPreviews",
  "Hunch Rehearsals",
  ".DS_Store",
] as const;

/** Restart-safe alpha migration of implementation-only state into the reserved mount. */
async function migratePrivateState(dataHome: string): Promise<void> {
  const state = join(dataHome, ".state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const moves: Array<{ source: string; destination: string }> = [];
  const emptyLegacyDirectories: string[] = [];
  for (const name of LEGACY_PRIVATE_ENTRIES) {
    const source = join(dataHome, name);
    const destination = join(state, name);
    const [sourceKind, destinationKind] = await Promise.all([pathKind(source), pathKind(destination)]);
    if (sourceKind === "missing") continue;
    if (destinationKind !== "missing") {
      if (sourceKind === "directory" && (await readdir(source)).length === 0) {
        emptyLegacyDirectories.push(source);
        continue;
      }
      throw new Error(`Private-state migration collision: both ${source} and ${destination} exist`);
    }
    moves.push({ source, destination });
  }
  // Every destination was checked before the first rename, so a collision can
  // never produce a partially merged state tree. Completed moves are harmless
  // when startup retries after interruption.
  for (const move of moves) await rename(move.source, move.destination);
  // Old app builds may harmlessly recreate an empty cache directory after the
  // cache has moved. Removing only an empty duplicate keeps restart migration
  // idempotent without merging or discarding private state.
  for (const source of emptyLegacyDirectories) await rmdir(source);
}

async function directoryFingerprint(path: string): Promise<{ device?: string; inode?: string }> {
  try {
    const info = await stat(path);
    return { device: String(info.dev), inode: String(info.ino) };
  } catch {
    return {};
  }
}

async function normalizeRegistry(stored: StoredWorkspaceRegistry): Promise<{
  registry: Record<string, WorkspaceRegistryRecord>;
  changed: boolean;
}> {
  const registry: Record<string, WorkspaceRegistryRecord> = {};
  let changed = false;
  for (const [path, value] of Object.entries(stored)) {
    const fingerprint = await directoryFingerprint(path);
    if (typeof value === "string") {
      registry[path] = {
        stateID: value,
        rootID: rootIDForInitialPath(path),
        path,
        ...fingerprint,
      };
      changed = true;
      continue;
    }
    const device = fingerprint.device ?? value.device;
    const inode = fingerprint.inode ?? value.inode;
    registry[path] = {
      ...value,
      path,
      rootID: value.rootID || rootIDForInitialPath(path),
      ...(device ? { device } : {}),
      ...(inode ? { inode } : {}),
    };
    if (
      value.path !== path
      || !value.rootID
      || value.device !== device
      || value.inode !== inode
    ) changed = true;
  }
  return { registry, changed };
}

async function loadWorkspaceRegistry(): Promise<{
  path: string;
  registry: Record<string, WorkspaceRegistryRecord>;
  changed: boolean;
}> {
  await prepareArborDataRoot();
  const path = join(arborPrivateRoot(), "workspaces.json");
  let stored: StoredWorkspaceRegistry = {};
  try {
    stored = JSON.parse(await readFile(path, "utf8")) as StoredWorkspaceRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path, ...await normalizeRegistry(stored) };
}

async function saveWorkspaceRegistry(
  path: string,
  registry: Record<string, WorkspaceRegistryRecord>,
): Promise<void> {
  const temporary = `${path}.arbor-write-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Resolve or mint the private identity for one physical directory. Directory
 * device/inode matching preserves it across same-filesystem path-key moves.
 */
export async function workspaceIdentity(root: string): Promise<WorkspaceRegistryRecord> {
  const canonical = await realpath(root);
  const loaded = await loadWorkspaceRegistry();
  let changed = loaded.changed;
  let record = loaded.registry[canonical];
  const fingerprint = await directoryFingerprint(canonical);

  if (!record && fingerprint.device && fingerprint.inode) {
    const matches = Object.entries(loaded.registry).filter(([, candidate]) =>
      candidate.device === fingerprint.device && candidate.inode === fingerprint.inode
    );
    if (matches.length === 1) {
      const [previousPath, previous] = matches[0]!;
      delete loaded.registry[previousPath];
      record = { ...previous, path: canonical, ...fingerprint };
      changed = true;
    } else if (matches.length > 1) {
      throw new AmbiguousWorkspaceIdentityError(canonical, matches.map(([path]) => path));
    }
  }

  if (!record) {
    record = {
      stateID: `${sha256(canonical).slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`,
      rootID: rootIDForInitialPath(canonical),
      path: canonical,
      ...fingerprint,
    };
    changed = true;
  } else if (
    record.path !== canonical
    || record.device !== fingerprint.device
    || record.inode !== fingerprint.inode
  ) {
    record = { ...record, path: canonical, ...fingerprint };
    changed = true;
  }

  loaded.registry[canonical] = record;
  if (changed) await saveWorkspaceRegistry(loaded.path, loaded.registry);
  return record;
}

/** Resolve a stable private migration/workspace ID without requiring a missing path to exist. */
export async function privateRootID(path: string): Promise<string> {
  const loaded = await loadWorkspaceRegistry();
  const exact = loaded.registry[path];
  if (exact) return exact.rootID;
  try {
    return (await workspaceIdentity(path)).rootID;
  } catch {
    return rootIDForInitialPath(path);
  }
}

export async function workspaceState(root: string): Promise<WorkspaceState> {
  const identity = await workspaceIdentity(root);
  const directory = join(arborPrivateRoot(), "workspaces", identity.stateID);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  return { identity, directory };
}

export async function workspaceStateDirectory(root: string): Promise<string> {
  return (await workspaceState(root)).directory;
}
