import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, TreeID, SharedTreePlacement, TreePlacement } from "@overstory/protocol";
import { revisionOf, HostAccountStore, arborPrivateRoot } from "@overstory/protocol";
import {
  loadAccountConfigurations,
  watchAccountConfigurations,
  type AccountConfigurationSnapshot,
} from "@overstory/protocol";
import { loadLocalPlacements, placementsFilePath, watchLocalPlacements } from "./placements.ts";
import { loadRehomeTransactions } from "./rehome-state.ts";

export type { SharedTreePlacement, TreePlacement } from "@overstory/protocol";

export interface TreeRegistrySnapshot {
  placements: TreePlacement[];
  diagnostics: Diagnostic[];
  revision: string;
  source: string;
  accounts: AccountConfigurationSnapshot[];
  /** V2 accounts whose authored graph could not safely replace its last accepted local projection. */
  invalidAccounts: TreeID[];
  /** False means keep the last accepted local placement projection unchanged. */
  placementsValid: boolean;
}

interface PlacementSyncMetadata {
  conflicted?: boolean;
  ref?: string;
  update?: string;
  cursor?: string;
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

function canonicalLocator(origin: string, path: string): string {
  const url = new URL(origin);
  return `arbor://${url.host}${path}`;
}

export async function loadTreeRegistry(): Promise<TreeRegistrySnapshot> {
  const pluralConfigurations = await loadAccountConfigurations();
  const local = await loadLocalPlacements();
  const rehomes = await loadRehomeTransactions();
  const placements: SharedTreePlacement[] = [];
  const diagnostics = [
    ...local.diagnostics,
    ...rehomes.diagnostics,
    ...pluralConfigurations.flatMap((configuration) => configuration.diagnostics),
  ];
  let placementsValid = local.diagnostics.length === 0 && rehomes.diagnostics.length === 0;
  const invalidAccounts = new Set(pluralConfigurations
    .filter((configuration) => configuration.diagnostics.length > 0 || !configuration.account || !configuration.trees || !configuration.devices || !configuration.currentDevice)
    .map((configuration) => configuration.configurationTree));
  const accounts = new Map(pluralConfigurations.map((configuration) => [configuration.configurationTree, configuration]));
  const declarationOwners = new Map<string, string[]>();
  for (const configuration of pluralConfigurations) {
    for (const tree of Object.keys(configuration.trees ?? {})) {
      const owners = declarationOwners.get(tree) ?? [];
      owners.push(configuration.configurationTree);
      declarationOwners.set(tree, owners);
    }
  }
  for (const [tree, owners] of declarationOwners) {
    if (owners.length < 2) continue;
    const transaction = rehomes.transactions.get(tree);
    const expected = transaction
      ? new Set([transaction.sourceConfigurationTree, transaction.destinationConfigurationTree])
      : undefined;
    const explicitlyRehoming = expected?.size === 2
      && owners.length === 2
      && owners.every((owner) => expected.has(owner))
      && accounts.get(transaction!.sourceConfigurationTree)?.trees?.[tree]?.canonical === transaction!.sourceCanonical
      && accounts.get(transaction!.destinationConfigurationTree)?.trees?.[tree]?.canonical === transaction!.destinationCanonical;
    if (explicitlyRehoming) continue;
    placementsValid = false;
    diagnostics.push({
      code: "multiply-declared-tree",
      message: `Tree ${tree} is declared by several accounts without a matching rehome transaction: ${owners.join(", ")}`,
      path: placementsFilePath(),
      severity: "error",
    });
  }
  for (const configuration of pluralConfigurations) {
    if (!configuration.account || !configuration.trees || !configuration.devices || !configuration.currentDevice) continue;
    const connected = await new HostAccountStore(configuration.configurationTree).safe();
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
      placementsValid = false;
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
    invalidAccounts: [...invalidAccounts],
    placementsValid,
  };
}

export async function watchTreeRegistry(onChange: () => void): Promise<() => void> {
  const stopAccounts = await watchAccountConfigurations(onChange);
  const stopPlacements = watchLocalPlacements(onChange);
  return () => { stopAccounts(); stopPlacements(); };
}
