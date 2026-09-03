import {
  parseAccountDevicesConfiguration,
  parseCanopyAccountConfiguration,
  parseHostedTreesConfiguration,
  type AccountDeviceConfiguration,
  type CanopyAccountConfiguration,
  type HostedTreeDeclaration,
  type HostedTreesConfiguration,
} from "@arbor/stores";
import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type TreeSnapshot,
  type WireDirectory,
} from "@arbor/wire";
import { stringify } from "yaml";

export interface AccountConfigGraphV2 {
  account: CanopyAccountConfiguration;
  trees: HostedTreesConfiguration;
  devices: Record<string, AccountDeviceConfiguration>;
  sources: Record<string, string>;
}

function text(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${path} must be UTF-8`); }
}

function object(snapshot: TreeSnapshot, hash: ObjectHash, path: string) {
  const bytes = snapshot.objects.get(hash);
  if (!bytes) throw new Error(`Account configuration is missing ${path}`);
  return decodeWireObject(bytes);
}

export function readAccountConfigGraphV2(snapshot: TreeSnapshot, configurationTree?: string): AccountConfigGraphV2 {
  const root = object(snapshot, snapshot.root, "/");
  if (root.type !== "directory") throw new Error("Account configuration root must be a directory");
  const allowed = new Set(["account.yaml", "trees.yaml", "devices.yaml"]);
  for (const entry of root.entries) {
    if (!allowed.has(entry.name)) throw new Error(`Unsupported account configuration path: ${entry.name}`);
    if (entry.tree) throw new Error("Account configuration cannot contain nested tree boundaries");
  }
  const sourceAt = (name: string): string => {
    const entry = root.entries.find((candidate) => candidate.name === name);
    if (!entry?.hash) throw new Error(`Account configuration requires ${name}`);
    const value = object(snapshot, entry.hash, name);
    if (value.type !== "file") throw new Error(`${name} must be a file`);
    return text(value.bytes, name);
  };
  const sources = {
    "account.yaml": sourceAt("account.yaml"),
    "trees.yaml": sourceAt("trees.yaml"),
    "devices.yaml": sourceAt("devices.yaml"),
  };
  const account = parseCanopyAccountConfiguration(sources["account.yaml"]);
  const trees = parseHostedTreesConfiguration(sources["trees.yaml"], account);
  const devices = parseAccountDevicesConfiguration(sources["devices.yaml"]);
  if (configurationTree && trees[configurationTree]) throw new Error("The account-configuration tree must not declare itself");
  return { account, trees, devices, sources };
}

function subjectKey(rule: HostedTreeDeclaration["access"][number]): string {
  const subject = rule.subject;
  return subject.kind === "everyone" ? "everyone" : subject.kind === "profile" ? `profile:${subject.tree}` : `link:${subject.digest}`;
}

function semantic(graph: Omit<AccountConfigGraphV2, "sources">): Record<string, any> {
  return {
    account: graph.account,
    trees: Object.fromEntries(Object.entries(graph.trees).map(([id, tree]) => [id, {
      canonical: tree.canonical,
      access: Object.fromEntries(tree.access.map((rule) => [subjectKey(rule), rule])),
    }])),
    devices: Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
      label: device.label,
      administrator: device.administrator,
    }])),
  };
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, comparable(entry)]));
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
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
  return { account, trees, devices };
}

export function mergeAccountConfigGraphsV2(
  base: AccountConfigGraphV2,
  candidate: AccountConfigGraphV2,
  remote: AccountConfigGraphV2,
) {
  const tally: MergeTally = { conflicts: [], mergedFields: 0 };
  const value = mergeValue(semantic(base), semantic(candidate), semantic(remote), "", tally) as Record<string, any>;
  return { graph: fromSemantic(value), conflicts: tally.conflicts, mergedFields: tally.mergedFields };
}

export function authorizeAccountConfigTransitionV2(
  current: AccountConfigGraphV2,
  next: AccountConfigGraphV2,
  deviceID: string,
  changesFrom: AccountConfigGraphV2 = current,
): void {
  const currentDevice = current.devices[deviceID];
  if (!currentDevice) throw new Error("Submitting device is not active in the accepted configuration");
  const accepted = semantic(current);
  const base = semantic(changesFrom);
  const candidate = semantic(next);
  if (!same(base.account, candidate.account) && !same(accepted.account, candidate.account)) {
    throw new Error("account.yaml changes require an account lifecycle transition");
  }
  if (!currentDevice.administrator && !same(base.trees, candidate.trees) && !same(accepted.trees, candidate.trees)) {
    throw new Error("Only an administrator may edit trees.yaml");
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

function yaml(value: unknown): string {
  return stringify(value, { aliasDuplicateObjects: false, lineWidth: 0, sortMapEntries: true });
}

export function snapshotAccountConfigV2(graph: Omit<AccountConfigGraphV2, "sources">): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const file = (source: string): ObjectHash => {
    const bytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(source) });
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  const devices = Object.fromEntries(Object.entries(graph.devices).sort(([a], [b]) => a.localeCompare(b)).map(([id, device]) => [id, {
    label: device.label,
    ...(device.administrator ? { administrator: true } : {}),
  }]));
  const trees = Object.fromEntries(Object.entries(graph.trees).sort(([a], [b]) => a.localeCompare(b)).map(([id, tree]) => [id, tree]));
  const rootBytes = encodeWireObject({ type: "directory", entries: [
    { name: "account.yaml", hash: file(yaml(graph.account)) },
    { name: "devices.yaml", hash: file(yaml(devices)) },
    { name: "trees.yaml", hash: file(yaml(trees)) },
  ] } satisfies WireDirectory);
  const root = hashObject(rootBytes);
  objects.set(root, rootBytes);
  return { root, objects };
}
