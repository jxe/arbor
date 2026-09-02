import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, TreeID, TreeKind } from "@arbor/core";
import { revisionOf } from "@arbor/core";
import {
  loadAccountConfiguration,
  watchAccountConfiguration,
  type AccountConfigurationSnapshot,
} from "./account-config.ts";
import { CommunityConfigStore } from "./server-config.ts";
import { arborDataRoot, arborPrivateRoot } from "./private-state.ts";

export interface SharedTreePlacement {
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
  configuration: AccountConfigurationSnapshot;
}

interface PlacementSyncMetadata {
  ref?: string;
  update?: string;
  access?: "read" | "write";
}

function syncMetadataPath(tree: string): string {
  return join(arborPrivateRoot(), "refs", `${tree}.json`);
}

async function loadPlacementSyncMetadata(tree: string): Promise<PlacementSyncMetadata> {
  try { return JSON.parse(await readFile(syncMetadataPath(tree), "utf8")) as PlacementSyncMetadata; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function savePlacementSyncMetadata(tree: string, metadata: PlacementSyncMetadata): Promise<void> {
  const directory = join(arborPrivateRoot(), "refs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = syncMetadataPath(tree);
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

export async function loadTreeRegistry(): Promise<TreeRegistrySnapshot> {
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
  return { placements, diagnostics, revision: revisionOf(source), source, configuration };
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
  return watchAccountConfiguration(onChange);
}
