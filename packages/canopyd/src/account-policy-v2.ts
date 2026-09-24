import {
  decodeWireDirectory,
  intersectResourceRules,
  readAccountConfigGraphV2,
  resourceRuleFromLegacy,
  resourceRuleKey,
  snapshotAccountConfigV2,
  stableJSONString,
  type AccountConfigGraphV2,
  type AccountDeviceConfiguration,
  type CanopyAccountConfiguration,
  type HostedTreeDeclaration,
  type HostedTreesConfiguration,
  type ObjectHash,
  type ResourceAccessRule,
  type ResourceConfiguration,
} from "@overstory/protocol";
import { hostedProjection } from "@overstory/protocol";
import type { MergeResult } from "./updates/reconcile.ts";
import { PermissionDeniedError } from "./errors.ts";

export { readAccountConfigGraphV2, snapshotAccountConfigV2, type AccountConfigGraphV2 } from "@overstory/protocol";

export function authorizeAccountConfigTransitionV2(
  current: AccountConfigGraphV2,
  next: AccountConfigGraphV2,
  deviceID: string,
  changesFrom: AccountConfigGraphV2 = current,
  resourceFormat = !!current.resources,
): void {
  if (resourceFormat && !next.resources && Object.values(next.trees).some(tree => tree.access.length)) {
    throw new PermissionDeniedError("Legacy policy writes are not allowed after resource-policy conversion");
  }
  const currentDevice = current.devices[deviceID];
  if (!currentDevice) throw new PermissionDeniedError("Submitting device is not active in the accepted configuration");
  const accepted = semantic(current);
  const base = semantic(changesFrom);
  const candidate = semantic(next);
  if (!same(base.account, candidate.account) && !same(accepted.account, candidate.account)) {
    throw new Error("account.yaml changes require an account lifecycle transition");
  }
  if (!currentDevice.administrator && (!same(base.trees, candidate.trees) || !same(base.resources, candidate.resources)) && (!same(accepted.trees, candidate.trees) || !same(accepted.resources, candidate.resources))) {
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

function subjectKey(rule: HostedTreeDeclaration["access"][number]): string {
  const subject = rule.subject;
  return subject.kind === "everyone" ? "everyone" : subject.kind === "profile" ? `profile:${subject.tree}` : `link:${subject.digest}`;
}

export function semantic(graph: Omit<AccountConfigGraphV2, "sources">): Record<string, any> {
  return {
    account: graph.account,
    trees: Object.fromEntries(Object.entries(graph.trees).map(([id, tree]) => [id, {
      canonical: tree.canonical,
      access: Object.fromEntries(tree.access.map((rule) => [subjectKey(rule), rule])),
    }])),
    ...({ resources: Object.fromEntries(Object.entries(graph.resources ?? Object.fromEntries(Object.entries(graph.trees).map(([id, d]) => [id, { canonical: d.canonical, access: d.access.map(resourceRuleFromLegacy) }]))).map(([id, d]) => [id, {
      ...(d.canonical ? { canonical: d.canonical } : {}),
      access: Object.fromEntries(d.access.map(r => {
        const { within, ...rule } = r;
        return [resourceRuleKey(r), { ...rule, ...(within && within !== "/" ? { within } : {}), allow: [...r.allow].sort() }];
      })),
    }])) }),
    devices: Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
      label: device.label,
      administrator: device.administrator,
    }])),
  };
}

/** Semantic equality of parsed configuration values: canonical JSON, whose
 * key order is a total order rather than a locale's collation. */
export function same(left: unknown, right: unknown): boolean {
  return stableJSONString(left) === stableJSONString(right);
}

const missing = Symbol("missing");
interface MergeTally { conflicts: string[]; mergedFields: number }

function mergeValue(base: unknown, candidate: unknown, remote: unknown, path: string, tally: MergeTally): unknown {
  if (same(candidate, remote)) return candidate;
  if (same(candidate, base)) return remote;
  if (same(remote, base)) {
    tally.mergedFields += 1;
    return candidate;
  }
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

function fromSemantic(value: Record<string, any>): Omit<AccountConfigGraphV2, "sources"> {
  const account: CanopyAccountConfiguration = {
    canopy: value.account.canopy,
    profile: value.account.profile,
  };
  const trees: HostedTreesConfiguration = Object.fromEntries(Object.entries(value.trees).map(([id, raw]: [string, any]) => [id, {
    canonical: raw.canonical,
    access: Object.values(raw.access),
  }]));
  const devices: Record<string, AccountDeviceConfiguration> = Object.fromEntries(Object.entries(value.devices).map(([id, raw]: [string, any]) => [id, {
    id,
    label: raw.label,
    administrator: raw.administrator === true,
  }]));
  const resources: ResourceConfiguration | undefined = value.resources ? Object.fromEntries(Object.entries(value.resources).map(([id, d]: [string, any]) => [id, { ...(d.canonical ? { canonical: d.canonical } : {}), access: Object.values(d.access ?? {}) as ResourceAccessRule[] }])) : undefined;
  return { account, trees: resources ? hostedProjection(resources) : trees, ...(resources ? { resources } : {}), devices };
}

export function mergeAccountConfigGraphsV2(
  base: AccountConfigGraphV2,
  candidate: AccountConfigGraphV2,
  remote: AccountConfigGraphV2,
) {
  const tally: MergeTally = { conflicts: [], mergedFields: 0 };
  const value = mergeValue(semantic(base), semantic(candidate), semantic(remote), "", tally) as Record<string, any>;
  // Resource rules are authoritative; the legacy hosting ACL is only a derived
  // projection. Its same-field conflicts must not duplicate policy conflicts.
  const resourceFormat = !!(base.resources || candidate.resources || remote.resources);
  if (!resourceFormat) delete value.resources;
  const conflicts = tally.conflicts.filter(path => resourceFormat
    ? !/^trees\.[^.]+\.access(?:\.|$)/.test(path)
    : !path.startsWith("resources."));
  return { graph: fromSemantic(value), conflicts, mergedFields: tally.mergedFields };
}

/** The whole-tree merge for an account-configuration tree. Its files hold
 * canopyd's own policy, so canopyd merges them here rather than in the merge
 * worker; the result is authorized again before acceptance. */
export async function mergeAccountConfigTreesV2(
  base: ObjectHash,
  candidate: ObjectHash,
  current: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>,
): Promise<MergeResult> {
  const graphAt = async (root: ObjectHash) => {
    const objects = new Map<ObjectHash, Uint8Array>([[root, await load(root)]]);
    for (const entry of decodeWireDirectory(objects.get(root)!).entries)
      if (entry.file) objects.set(entry.file, await load(entry.file));
    return readAccountConfigGraphV2({ root, objects });
  };
  const inputs = await Promise.all([base, candidate, current].map(graphAt));
  const merged = mergeAccountConfigGraphsV2(inputs[0]!, inputs[1]!, inputs[2]!);
  const policyOnlyRemoval = (field: string) => {
    const match = /^resources\.([^.]+)$/.exec(field);
    return !!match && inputs.every(graph => !graph.resources?.[match[1]!]?.canonical);
  };
  const output = snapshotAccountConfigV2(merged.graph);
  return {
    root: output.root,
    objects: output.objects,
    conflicts: merged.conflicts.map(field => ({
      path: /^resources\.[^.]+\.access(?:\.|$)/.test(field) || policyOnlyRemoval(field) ? "/trees.yaml/access"
        : /^(resources|trees)\./.test(field) ? "/trees.yaml"
        : field.startsWith("devices.") ? "/devices.yaml" : "/account.yaml",
      reason: "account-configuration",
    })),
    summary: { version: "account-config-v2", mergedFields: merged.mergedFields },
  };
}
