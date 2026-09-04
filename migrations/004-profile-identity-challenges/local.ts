import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPersonProfileTreeID, type AccessRule } from "@arbor/core";
import {
  configurationTreeID,
  parseAccountDevicesConfiguration,
  parseCanopyAccountConfiguration,
  parseHostedTreesConfiguration,
  parseLocalPlacements,
  type WorkspaceRegistryRecord,
} from "@arbor/stores";
import { isMap, parseDocument } from "yaml";
import { accountConfigSourcesV2 } from "../../packages/canopy/src/account-policy-v2.ts";

export interface LocalProfileIdentityMigrationInput {
  dataHome: string;
  configurationTree: string;
  previous: string;
  profileTree: string;
  profilePath: string;
  backup: string;
}

export interface LocalProfileIdentityMigrationReport {
  mode: "local-home";
  alreadyMigrated: boolean;
  dataHome: string;
  backup: string | null;
  configurationTree: string;
  previous: string;
  profileTree: string;
  profilePath: string;
  removedProfilePlacement: boolean;
  clearedCaches: string[];
}

type Registry = Record<string, WorkspaceRegistryRecord>;

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function atomicWrite(path: string, source: string): Promise<void> {
  const temporary = `${path}.migration-004-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function replaceProfileRule(rule: AccessRule, previous: string, profileTree: string): AccessRule {
  return rule.subject.kind === "profile" && rule.subject.tree === previous
    ? { ...rule, subject: { kind: "profile", tree: profileTree } }
    : rule;
}

function placementSourceWithoutProfile(source: string, profilePath: string, previous: string): {
  source: string;
  removed: boolean;
} {
  const placements = parseLocalPlacements(source);
  const atPath = placements.find((placement) => placement.path === profilePath);
  if (atPath && atPath.tree !== previous) {
    throw new Error(`Profile path is placed as another tree: ${atPath.tree}`);
  }
  if (!atPath) return { source, removed: false };
  const document = parseDocument(source, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  document.deleteIn([atPath.configurationTree, profilePath]);
  const accountNode = document.get(atPath.configurationTree, true);
  if (isMap(accountNode) && accountNode.items.length === 0) document.deleteIn([atPath.configurationTree]);
  const next = document.toString({ lineWidth: 0 });
  parseLocalPlacements(next);
  return { source: next, removed: true };
}

function parseRegistry(source: string): Registry {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspaces.json must be a mapping");
  return value as Registry;
}

function connectionWithProfile(source: string, configurationTree: string, previous: string, profileTree: string): {
  source: string;
  changed: boolean;
} {
  const value = JSON.parse(source) as Record<string, unknown>;
  if (value.configurationTree !== configurationTree) throw new Error("Connection metadata names another configuration tree");
  if (value.profileTree !== previous && value.profileTree !== profileTree) {
    throw new Error("Connection metadata names another profile identity");
  }
  const changed = value.profileTree !== profileTree || "configurationRef" in value || "configurationUpdate" in value;
  value.profileTree = profileTree;
  delete value.configurationRef;
  delete value.configurationUpdate;
  return { source: `${JSON.stringify(value, null, 2)}\n`, changed };
}

function syncStateName(tree: string): string {
  return `${Buffer.from(tree).toString("base64url")}.json`;
}

/**
 * Offline, restart-safe local half of an explicit profile rekey. The identity
 * secret is restored separately so this operation never accepts key material
 * in command arguments or copies it into the Arbor data home.
 */
export async function migrateLocalHome(input: LocalProfileIdentityMigrationInput): Promise<LocalProfileIdentityMigrationReport> {
  const dataHome = await realpath(resolve(input.dataHome));
  const state = join(dataHome, ".state");
  const profilePath = await realpath(resolve(input.profilePath));
  const configurationTree = configurationTreeID(input.configurationTree);
  if (!/^tr_[a-z2-7]+$/.test(input.previous)) throw new Error("Previous profile must be a TreeID");
  if (!isPersonProfileTreeID(input.profileTree)) throw new Error("Replacement profile must be a self-certifying person Profile TreeID");
  if (input.previous === input.profileTree) throw new Error("Previous and replacement profile TreeIDs are the same");
  const index = await readFile(join(profilePath, "_index.md"), "utf8");
  if (!/^type:\s*person\s*$/m.test(index)) throw new Error("Profile _index.md must declare type: person");

  const accountPath = join(dataHome, "accounts", configurationTree);
  const accountSource = await readFile(join(accountPath, "account.yaml"), "utf8");
  const treesSource = await readFile(join(accountPath, "trees.yaml"), "utf8");
  const devicesSource = await readFile(join(accountPath, "devices.yaml"), "utf8");
  const account = parseCanopyAccountConfiguration(accountSource);
  if (account.profile !== input.previous && account.profile !== input.profileTree) {
    throw new Error("Selected account belongs to another profile identity");
  }
  const trees = parseHostedTreesConfiguration(treesSource, account);
  const devices = parseAccountDevicesConfiguration(devicesSource);
  if (trees[configurationTree]) throw new Error("The account-configuration tree declares itself");
  const nextSources = accountConfigSourcesV2({
    account: { ...account, profile: input.profileTree },
    trees: Object.fromEntries(Object.entries(trees).map(([tree, declaration]) => [tree, {
      ...declaration,
      access: declaration.access.map((rule) => replaceProfileRule(rule, input.previous, input.profileTree)),
    }])),
    devices,
  });

  const connectionPath = join(state, "accounts", configurationTree, "connection.json");
  const connection = connectionWithProfile(
    await readFile(connectionPath, "utf8"),
    configurationTree,
    input.previous,
    input.profileTree,
  );
  const placementsPath = join(dataHome, "placements.yaml");
  const originalPlacements = await readFile(placementsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}\n";
    throw error;
  });
  const placements = placementSourceWithoutProfile(originalPlacements, profilePath, input.previous);
  const registryPath = join(state, "workspaces.json");
  const registry = parseRegistry(await readFile(registryPath, "utf8"));
  const workspace = registry[profilePath];
  if (!workspace || typeof workspace !== "object" || workspace.path !== profilePath || typeof workspace.stateID !== "string") {
    throw new Error("Profile folder has no exact private workspace identity");
  }
  if (workspace.rootID !== input.profileTree && !/^rt_[a-z0-9]+$/.test(workspace.rootID) && workspace.rootID !== input.previous) {
    throw new Error(`Profile folder is bound to another public tree: ${workspace.rootID}`);
  }
  const duplicate = Object.entries(registry).find(([path, record]) => path !== profilePath && record.rootID === input.profileTree);
  if (duplicate) throw new Error(`Replacement profile TreeID is already bound to ${duplicate[0]}`);
  const nextRegistry: Registry = { ...registry, [profilePath]: { ...workspace, rootID: input.profileTree } };

  const changed = account.profile !== input.profileTree
    || accountSource !== nextSources["account.yaml"]
    || treesSource !== nextSources["trees.yaml"]
    || devicesSource !== nextSources["devices.yaml"]
    || connection.changed
    || placements.removed
    || workspace.rootID !== input.profileTree;
  const report = (backup: string | null, clearedCaches: string[]): LocalProfileIdentityMigrationReport => ({
    mode: "local-home",
    alreadyMigrated: !changed,
    dataHome,
    backup,
    configurationTree,
    previous: input.previous,
    profileTree: input.profileTree,
    profilePath,
    removedProfilePlacement: placements.removed,
    clearedCaches,
  });
  if (!changed) return report(null, []);

  const backup = resolve(input.backup);
  if (backup === dataHome || backup.startsWith(`${dataHome}/`)) throw new Error("Migration backup must be outside the Arbor data home");
  if (await exists(backup)) throw new Error(`Migration backup already exists: ${backup}`);
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  const lock = join(state, "migration.lock");
  await writeFile(lock, `migration-004 ${new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" });
  try {
    await cp(dataHome, backup, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => source !== lock,
    });
    await atomicWrite(join(accountPath, "account.yaml"), nextSources["account.yaml"]);
    await atomicWrite(join(accountPath, "devices.yaml"), nextSources["devices.yaml"]);
    await atomicWrite(join(accountPath, "trees.yaml"), nextSources["trees.yaml"]);
    await atomicWrite(connectionPath, connection.source);
    if (originalPlacements !== placements.source) await atomicWrite(placementsPath, placements.source);
    await atomicWrite(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`);

    const cachePaths = [
      join(state, "refs", `${input.previous}.json`),
      join(state, "refs", `${input.profileTree}.json`),
      join(state, "refs", `${configurationTree}.json`),
      join(state, "sync", syncStateName(input.previous)),
      join(state, "sync", syncStateName(input.profileTree)),
      join(state, "sync", syncStateName(configurationTree)),
      join(state, "workspaces", workspace.stateID),
    ];
    const clearedCaches: string[] = [];
    for (const path of cachePaths) {
      if (!await exists(path)) continue;
      await rm(path, { recursive: true, force: true });
      clearedCaches.push(path.slice(dataHome.length + 1));
    }
    return report(backup, clearedCaches);
  } finally {
    await rm(lock, { force: true });
  }
}
