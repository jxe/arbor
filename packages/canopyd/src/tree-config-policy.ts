import {
  decodeProtocolDirectory,
  mergeTreeConfigs,
  readTreeConfigGraph,
  sameTreeConfigValue,
  semanticTreeConfig,
  snapshotTreeConfig,
  type ObjectHash,
  type TreeConfigKind,
  type TreeConfigValues,
} from "@overstory/protocol";
import { PermissionDeniedError } from "./errors.ts";
import type { MergeResult } from "./updates/reconcile.ts";

/** The conflict reason of a tree configuration's policy conflict: an
 * ambiguous rule edit whose restrictive intersection may stay open. */
export const TREE_CONFIG_POLICY_CONFLICT = "tree-configuration-policy";
/** Any other tree configuration conflict, which refuses the merge. */
export const TREE_CONFIG_CONFLICT = "tree-configuration";

/**
 * The per-device rules of a person's configuration: any listed device may
 * change its own label; an administrator device may change everything else,
 * including pairing and revoking devices. `changesFrom` is the candidate's
 * base: a field the candidate leaves as its base had it is not the device's
 * change even when the accepted configuration has since moved on. Every other
 * configuration is edited only from administrator devices, which the caller
 * checks before this.
 */
export function authorizePersonConfigTransition(
  current: TreeConfigValues,
  next: TreeConfigValues,
  deviceID: string,
  changesFrom: TreeConfigValues = current,
): void {
  const devices = current.devices ?? {};
  const device = devices[deviceID];
  if (!device) throw new PermissionDeniedError("Submitting device is not active in the accepted configuration");
  if (device.administrator) return;
  const accepted = semanticTreeConfig(current);
  const base = semanticTreeConfig(changesFrom);
  const candidate = semanticTreeConfig(next);
  for (const field of ["access", "mounts", "apps"] as const) {
    if (!sameTreeConfigValue(base[field], candidate[field]) && !sameTreeConfigValue(accepted[field], candidate[field])) {
      throw new PermissionDeniedError(`Only an administrator device may edit ${field}.yaml`);
    }
  }
  const before = base.devices ?? {};
  const after = candidate.devices ?? {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameTreeConfigValue(after[id], accepted.devices?.[id])) continue;
    if (id !== deviceID || !before[id] || !after[id] || before[id].administrator !== after[id].administrator || before[id].label === after[id].label) {
      throw new PermissionDeniedError(`Device ${deviceID} may change only its own label`);
    }
  }
}

/**
 * The whole-tree merge for a tree configuration. Its files hold canopyd's own
 * policy, so canopyd merges them here rather than in the merge sidecar; the
 * result is authorized again before acceptance.
 */
export async function mergeTreeConfigTrees(
  kind: TreeConfigKind,
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<MergeResult> {
  const graphAt = async (root: ObjectHash) => {
    const objects = new Map<ObjectHash, Uint8Array>([[root, await load(root)]]);
    for (const entry of decodeProtocolDirectory(objects.get(root)!).entries)
      if (entry.file) objects.set(entry.file, await load(entry.file));
    return readTreeConfigGraph({ root, objects }, kind);
  };
  const [b, c, r] = await Promise.all([base, candidate, current].map(graphAt));
  const merged = mergeTreeConfigs(b!, c!, r!);
  const output = snapshotTreeConfig(merged.values);
  return {
    root: output.root,
    objects: output.objects,
    conflicts: merged.conflicts.map((conflict) => ({
      path: `/${conflict.file}`,
      reason: conflict.policy ? TREE_CONFIG_POLICY_CONFLICT : TREE_CONFIG_CONFLICT,
    })),
  };
}
