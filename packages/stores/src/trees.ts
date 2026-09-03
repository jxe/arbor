import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, TreeID, TreeKind } from "@arbor/core";
import { revisionOf } from "@arbor/core";
import {
  loadAccountConfiguration,
  watchAccountConfiguration,
  type AccountConfigurationSnapshot,
} from "./account-config.ts";
import {
  loadCanopyAccountConfigurations,
  watchCanopyAccountConfigurations,
  type CanopyAccountConfigurationSnapshot,
} from "./account-config-v2.ts";
import { loadLocalPlacements, placementsFilePath, watchLocalPlacements } from "./placements.ts";
import { CanopyAccountStore, CommunityConfigStore } from "./server-config.ts";
import { arborDataRoot, arborPrivateRoot } from "./private-state.ts";

export interface SharedTreePlacement {
  configurationTree?: TreeID;
  path: string;
  tree: TreeID;
  canonical?: string;
  canonicalPath?: string;
  kind?: TreeKind;
  access: "read" | "write";
  endpoint: string;
  ref?: string;
  update?: string;
  replica?: boolean;
}

export type TreePlacement = SharedTreePlacement;

export interface TreeRegistrySnapshot {
  placements: TreePlacement[];
  diagnostics: Diagnostic[];
  revision: string;
  source: string;
  /** Legacy singleton projection retained only by the removable v1 adapter. */
  configuration?: AccountConfigurationSnapshot;
  accounts?: CanopyAccountConfigurationSnapshot[];
  plural: boolean;
  /** V2 accounts whose authored graph could not safely replace its last accepted local projection. */
  invalidAccounts: TreeID[];
  /** False means keep the last accepted local placement projection unchanged. */
  placementsValid: boolean;
}

interface PlacementSyncMetadata {
  ref?: string;
  update?: string;
  access?: "read" | "write";
}

function syncMetadataPath(tree: string, configurationTree?: string): string {
  return configurationTree
    ? join(arborPrivateRoot(), "accounts", configurationTree, "refs", `${tree}.json`)
    : join(arborPrivateRoot(), "refs", `${tree}.json`);
}

async function loadPlacementSyncMetadata(tree: string, configurationTree?: string): Promise<PlacementSyncMetadata> {
  try { return JSON.parse(await readFile(syncMetadataPath(tree, configurationTree), "utf8")) as PlacementSyncMetadata; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function savePlacementSyncMetadata(tree: string, metadata: PlacementSyncMetadata, configurationTree?: string): Promise<void> {
  const directory = configurationTree
    ? join(arborPrivateRoot(), "accounts", configurationTree, "refs")
    : join(arborPrivateRoot(), "refs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = syncMetadataPath(tree, configurationTree);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export function treesFilePath(): string {
  return join(arborDataRoot(), "trees.yaml");
}

function canonicalLocator(origin: string, path: string): string {
  const url = new URL(origin);
  return `arbor://${url.host}${path}`;
}

/**
 * Complete v1 singleton adapter. Delete this function, its two imports, and
 * the one fallback call in loadTreeRegistry after the offline layout cutover.
 */
async function loadLegacySingletonTreeRegistry(): Promise<TreeRegistrySnapshot> {
  const configuration = await loadAccountConfiguration();
  const placements: SharedTreePlacement[] = [];
  const diagnostics = [...configuration.diagnostics];
  if (configuration.account && configuration.trees && configuration.currentDevice) {
    for (const [tree, placement] of Object.entries(configuration.currentDevice.placements)) {
      const declaration = configuration.trees.trees[tree];
      if (!declaration) {
        diagnostics.push({
          code: "undeclared-tree-placement",
          message: `Placement ${tree} is not declared in trees.yaml`,
          path: join(arborDataRoot(), "devices", `${configuration.currentDevice.id}.yaml`),
          severity: "warning",
        });
        continue;
      }
      const replica = placement.path === undefined;
      const path = placement.path ?? join(arborPrivateRoot(), "replicas", tree);
      if (replica) await mkdir(path, { recursive: true, mode: 0o700 });
      const sync = await loadPlacementSyncMetadata(tree);
      placements.push({
        path,
        tree,
        canonical: canonicalLocator(placement.server, declaration.canonicalPath),
        canonicalPath: declaration.canonicalPath,
        access: "write",
        endpoint: placement.server,
        replica,
        ...sync,
      });
    }
  }
  const community = await new CommunityConfigStore().safe();
  if (community && configuration.account?.community === community.origin) {
    const sync = await loadPlacementSyncMetadata(community.configurationTree);
    placements.push({
      path: await realpath(arborDataRoot()),
      tree: community.configurationTree,
      kind: "account-configuration",
      access: "write",
      endpoint: community.origin,
      ref: community.configurationRef,
      update: community.configurationUpdate,
      ...sync,
    });
  }
  const source = JSON.stringify(configuration);
  return {
    placements,
    diagnostics,
    revision: revisionOf(source),
    source,
    configuration,
    plural: false,
    invalidAccounts: [],
    placementsValid: true,
  };
}

export async function loadTreeRegistry(): Promise<TreeRegistrySnapshot> {
  const pluralConfigurations = await loadCanopyAccountConfigurations();
  const local = await loadLocalPlacements();
  if (pluralConfigurations.length || local.source) {
    const placements: SharedTreePlacement[] = [];
    const diagnostics = [...local.diagnostics, ...pluralConfigurations.flatMap((configuration) => configuration.diagnostics)];
    const invalidAccounts = new Set(pluralConfigurations
      .filter((configuration) => configuration.diagnostics.length > 0 || !configuration.account || !configuration.trees || !configuration.devices || !configuration.currentDevice)
      .map((configuration) => configuration.configurationTree));
    const accounts = new Map(pluralConfigurations.map((configuration) => [configuration.configurationTree, configuration]));
    for (const configuration of pluralConfigurations) {
      if (!configuration.account || !configuration.trees || !configuration.devices || !configuration.currentDevice) continue;
      const connected = await new CanopyAccountStore(configuration.configurationTree).safe();
      if (!connected) {
        invalidAccounts.add(configuration.configurationTree);
        diagnostics.push({
          code: "account-credential-unavailable",
          message: `Account ${configuration.configurationTree} has no authenticated local connection`,
          path: configuration.path,
          severity: "warning",
        });
        continue;
      }
      if (
        connected.origin !== configuration.account.canopy
        || connected.profileTree !== configuration.account.profile
        || connected.deviceID !== configuration.currentDevice.id
      ) {
        invalidAccounts.add(configuration.configurationTree);
        diagnostics.push({
          code: "account-identity-mismatch",
          message: `Authenticated metadata disagrees with account checkout ${configuration.configurationTree}`,
          path: configuration.path,
          severity: "warning",
        });
        continue;
      }
      const sync = await loadPlacementSyncMetadata(configuration.configurationTree, configuration.configurationTree);
      placements.push({
        configurationTree: configuration.configurationTree,
        path: configuration.path,
        tree: configuration.configurationTree,
        kind: "account-configuration",
        access: "write",
        endpoint: configuration.account.canopy,
        ref: connected.configurationRef,
        update: connected.configurationUpdate,
        ...sync,
      });
    }
    for (const placement of local.placements) {
      const configuration = accounts.get(placement.configurationTree);
      const declaration = configuration?.trees?.[placement.tree];
      if (!configuration?.account || !declaration) {
        diagnostics.push({
          code: configuration ? "undeclared-tree-placement" : "unknown-placement-account",
          message: configuration
            ? `Tree ${placement.tree} is not declared by account ${placement.configurationTree}`
            : `Placement refers to unknown account ${placement.configurationTree}`,
          path: placementsFilePath(),
          severity: "warning",
        });
        continue;
      }
      const sync = await loadPlacementSyncMetadata(placement.tree, placement.configurationTree);
      placements.push({
        ...placement,
        canonical: canonicalLocator(configuration.account.canopy, new URL(declaration.canonical).pathname),
        canonicalPath: new URL(declaration.canonical).pathname,
        access: "write",
        endpoint: configuration.account.canopy,
        ...sync,
      });
    }
    const source = JSON.stringify({ accounts: pluralConfigurations, placements: local.source });
    return {
      placements,
      diagnostics,
      revision: revisionOf(source),
      source,
      accounts: pluralConfigurations,
      plural: true,
      invalidAccounts: [...invalidAccounts],
      placementsValid: local.diagnostics.length === 0,
    };
  }
  return loadLegacySingletonTreeRegistry();
}

/** Steady-state configuration is edited as ordinary YAML; arborsync never writes it back. */
export async function saveSharedTreePlacement(_placement: SharedTreePlacement): Promise<never> {
  throw new Error("Tree placements are declared by editing the current device YAML file");
}

/** Steady-state configuration is edited as ordinary YAML; arborsync never writes it back. */
export async function deleteTreePlacement(_path: string): Promise<never> {
  throw new Error("Tree placements are removed by editing the current device YAML file");
}

export async function watchTreeRegistry(onChange: () => void): Promise<() => void> {
  const configurations = await loadCanopyAccountConfigurations();
  const placements = await loadLocalPlacements();
  if (!configurations.length && !placements.source) return watchAccountConfiguration(onChange);
  const stopAccounts = await watchCanopyAccountConfigurations(onChange);
  const stopPlacements = watchLocalPlacements(onChange);
  return () => { stopAccounts(); stopPlacements(); };
}
