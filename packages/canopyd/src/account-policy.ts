import {
  decodeProtocolDirectory,
  intersectResourceRules,
  readAccountConfigGraph,
  resourceRuleKey,
  snapshotAccountConfig,
  stableJSONString,
  type AccountConfigValues,
  type AccountDeviceConfiguration,
  type ObjectHash,
  type ResourceAccessRule,
  type ResourceConfiguration,
} from "@overstory/protocol";
import { PermissionDeniedError } from "./errors.ts";
import type { MergeResult } from "./updates/reconcile.ts";

export function authorizeAccountConfigTransition(
  current: AccountConfigValues,
  next: AccountConfigValues,
  deviceID: string,
  changesFrom: AccountConfigValues = current,
): void {
  const currentDevice = current.devices[deviceID];
  if (!currentDevice) throw new PermissionDeniedError("Submitting device is not active in the accepted configuration");
  const accepted = semantic(current);
  const base = semantic(changesFrom);
  const candidate = semantic(next);
  if (!same(base.account, candidate.account) && !same(accepted.account, candidate.account)) {
    throw new Error("account.yaml changes require an account lifecycle transition");
  }
  if (!currentDevice.administrator && !same(base.resources, candidate.resources) && !same(accepted.resources, candidate.resources)) {
    throw new PermissionDeniedError("Only an administrator may edit trees.yaml");
  }
  for (const id of new Set([...Object.keys(base.devices), ...Object.keys(candidate.devices)])) {
    const before = base.devices[id];
    const after = candidate.devices[id];
    if (same(after, accepted.devices[id])) continue;
    if (currentDevice.administrator) continue;
    if (id !== deviceID || !before || !after || before.administrator !== after.administrator) {
      throw new Error(`Device ${deviceID} may change only its own label`);
    }
    if (before.label === after.label) throw new Error(`Device ${deviceID} may change only its own label`);
  }
  if (!Object.values(next.devices).some((device) => device.administrator)) {
    throw new Error("At least one administrator must remain active");
  }
}

/** The comparable form of a configuration: resource rules keyed by rule
 * identity, so authoring order and the default scope spelling do not count. */
function semantic(graph: AccountConfigValues): Record<string, any> {
  return {
    account: graph.account,
    resources: Object.fromEntries(Object.entries(graph.resources).map(([id, d]) => [id, {
      ...(d.canonical ? { canonical: d.canonical } : {}),
      access: Object.fromEntries(d.access.map(r => {
        const { within, ...rule } = r;
        return [resourceRuleKey(r), { ...rule, ...(within && within !== "/" ? { within } : {}), allow: [...r.allow].sort() }];
      })),
    }])),
    devices: Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
      label: device.label,
      administrator: device.administrator,
    }])),
  };
}

/** Semantic equality of parsed configuration values: canonical JSON, whose
 * key order is a total order rather than a locale's collation. */
function same(left: unknown, right: unknown): boolean {
  return stableJSONString(left) === stableJSONString(right);
}

const missing = Symbol("missing");
interface MergeTally { conflicts: string[] }

function mergeValue(base: unknown, candidate: unknown, remote: unknown, path: string, tally: MergeTally): unknown {
  if (same(candidate, remote)) return candidate;
  if (same(candidate, base)) return remote;
  if (same(remote, base)) return candidate;
  if (/^devices\.[^.]+$/.test(path) && (candidate === missing || remote === missing)) return missing;
  if (/^resources\.[^.]+$/.test(path) && (candidate === missing || remote === missing)) {
    tally.conflicts.push(path);
    return missing;
  }
  if (path.startsWith("resources.") && path.includes(".access.[")) {
    tally.conflicts.push(path);
    if (candidate === missing || remote === missing) return missing;
    const intersection = intersectResourceRules(candidate as ResourceAccessRule, remote as ResourceAccessRule);
    return intersection ?? missing;
  }
  const maps = [base, candidate, remote].every((value) => value === missing || (value !== null && typeof value === "object" && !Array.isArray(value)));
  if (maps) {
    const result: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(base === missing ? {} : base as object),
      ...Object.keys(candidate === missing ? {} : candidate as object),
      ...Object.keys(remote === missing ? {} : remote as object),
    ]);
    for (const key of [...keys].sort()) {
      const value = mergeValue(
        base === missing ? missing : (base as Record<string, unknown>)[key] ?? missing,
        candidate === missing ? missing : (candidate as Record<string, unknown>)[key] ?? missing,
        remote === missing ? missing : (remote as Record<string, unknown>)[key] ?? missing,
        path ? `${path}.${key}` : key,
        tally,
      );
      if (value !== missing) result[key] = value;
    }
    return result;
  }
  tally.conflicts.push(path);
  return candidate;
}

function fromSemantic(value: Record<string, any>): AccountConfigValues {
  const devices: Record<string, AccountDeviceConfiguration> = Object.fromEntries(Object.entries(value.devices).map(([id, raw]: [string, any]) => [id, {
    id,
    label: raw.label,
    administrator: raw.administrator === true,
  }]));
  const resources: ResourceConfiguration = Object.fromEntries(Object.entries(value.resources).map(([id, d]: [string, any]) => [id, {
    ...(d.canonical ? { canonical: d.canonical } : {}),
    access: Object.values(d.access ?? {}) as ResourceAccessRule[],
  }]));
  return { account: { canopy: value.account.canopy, profile: value.account.profile }, resources, devices };
}

export function mergeAccountConfigGraphs(
  base: AccountConfigValues,
  candidate: AccountConfigValues,
  remote: AccountConfigValues,
) {
  const tally: MergeTally = { conflicts: [] };
  const value = mergeValue(semantic(base), semantic(candidate), semantic(remote), "", tally) as Record<string, any>;
  return { graph: fromSemantic(value), conflicts: tally.conflicts };
}

/** The whole-tree merge for an account-configuration tree. Its files hold
 * canopyd's own policy, so canopyd merges them here rather than in the merge
 * worker; the result is authorized again before acceptance. */
export async function mergeAccountConfigTrees(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<MergeResult> {
  const graphAt = async (root: ObjectHash) => {
    const objects = new Map<ObjectHash, Uint8Array>([[root, await load(root)]]);
    for (const entry of decodeProtocolDirectory(objects.get(root)!).entries)
      if (entry.file) objects.set(entry.file, await load(entry.file));
    return readAccountConfigGraph({ root, objects });
  };
  const inputs = await Promise.all([base, candidate, current].map(graphAt));
  const merged = mergeAccountConfigGraphs(inputs[0]!, inputs[1]!, inputs[2]!);
  const policyOnlyRemoval = (field: string) => {
    const match = /^resources\.([^.]+)$/.exec(field);
    return !!match && inputs.every(graph => !graph.resources[match[1]!]?.canonical);
  };
  const output = snapshotAccountConfig(merged.graph);
  return {
    root: output.root,
    objects: output.objects,
    conflicts: merged.conflicts.map(field => ({
      path: /^resources\.[^.]+\.access(?:\.|$)/.test(field) || policyOnlyRemoval(field) ? "/trees.yaml/access"
        : field.startsWith("resources.") ? "/trees.yaml"
        : field.startsWith("devices.") ? "/devices.yaml" : "/account.yaml",
      reason: "account-configuration",
    })),
  };
}
