import {
  decodeWireObject,
  encodeWireObject,
  hashObject,
  type ObjectHash,
  type TreeSnapshot,
  type WireDirectory,
} from "@arbor/wire";
import {
  parseAccountConfiguration,
  parseDeviceConfiguration,
  parseTreesConfiguration,
  type AccountConfiguration,
  type DeviceConfiguration,
  type TreeDeclaration,
  type TreesConfiguration,
} from "@arbor/stores";
import { stringify } from "yaml";

export interface AccountConfigGraph {
  account: AccountConfiguration;
  trees: TreesConfiguration;
  devices: Record<string, DeviceConfiguration>;
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

export function readAccountConfigGraph(snapshot: TreeSnapshot, configTreeID?: string): AccountConfigGraph {
  const root = object(snapshot, snapshot.root, "/");
  if (root.type !== "directory") throw new Error("Account configuration root must be a directory");
  const allowed = new Set(["account.yaml", "trees.yaml", "devices"]);
  for (const entry of root.entries) {
    if (entry.name === ".state") throw new Error(".state is forbidden in an account-configuration graph");
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
  const accountSource = sourceAt("account.yaml");
  const treesSource = sourceAt("trees.yaml");
  const account = parseAccountConfiguration(accountSource, "account.yaml");
  const trees = parseTreesConfiguration(treesSource, "trees.yaml");
  const devicesEntry = root.entries.find((candidate) => candidate.name === "devices");
  if (!devicesEntry?.hash) throw new Error("Account configuration requires devices/");
  const devicesObject = object(snapshot, devicesEntry.hash, "devices");
  if (devicesObject.type !== "directory") throw new Error("devices must be a directory");
  const devices: Record<string, DeviceConfiguration> = {};
  const sources: Record<string, string> = { "account.yaml": accountSource, "trees.yaml": treesSource };
  for (const entry of devicesObject.entries) {
    const match = /^(dv_[a-z2-7]+)\.yaml$/.exec(entry.name);
    if (!match || !entry.hash || entry.tree) throw new Error(`Unsupported account configuration path: devices/${entry.name}`);
    const value = object(snapshot, entry.hash, `devices/${entry.name}`);
    if (value.type !== "file") throw new Error(`devices/${entry.name} must be a file`);
    const source = text(value.bytes, `devices/${entry.name}`);
    devices[match[1]!] = parseDeviceConfiguration(source, match[1]!, `devices/${entry.name}`);
    sources[`devices/${entry.name}`] = source;
  }
  if (!Object.keys(devices).length) throw new Error("Account configuration must contain an active device");
  for (const admin of account.admins) {
    if (!devices[admin]) throw new Error(`Administrator ${admin} is not an active device`);
  }
  if (configTreeID && trees.trees[configTreeID]) throw new Error("The account-configuration tree must not declare itself");
  for (const device of Object.values(devices)) {
    for (const [tree, placement] of Object.entries(device.placements)) {
      if (tree === configTreeID) throw new Error("The account-configuration tree must not place itself");
      if (!trees.trees[tree]) throw new Error(`Placement refers to undeclared tree ${tree}`);
      if (placement.server !== account.community) throw new Error(`Placement ${tree} uses a different server from account.yaml`);
      if (placement.path?.split(/[\\/]/).includes(".state")) throw new Error("Placement paths cannot enter .state");
    }
  }
  const profile = trees.trees[account.profile.tree];
  if (!profile || profile.kind !== "person-profile" || profile.canonicalPath !== `/~${account.profile.handle}`) {
    throw new Error("account.profile must match a person-profile declaration at its canonical handle");
  }
  return { account, trees, devices, sources };
}

function subjectKey(rule: TreeDeclaration["access"][number]): string {
  const subject = rule.subject;
  return subject.kind === "everyone" ? "everyone" : subject.kind === "profile" ? `profile:${subject.tree}` : `link:${subject.digest}`;
}

function semantic(graph: AccountConfigGraph): Record<string, unknown> {
  return {
    account: {
      community: graph.account.community,
      profile: graph.account.profile,
      admins: Object.fromEntries(graph.account.admins.map((id) => [id, true])),
    },
    trees: Object.fromEntries(Object.entries(graph.trees.trees).map(([id, tree]) => [id, {
      kind: tree.kind,
      canonicalPath: tree.canonicalPath,
      access: Object.fromEntries(tree.access.map((rule) => [subjectKey(rule), rule])),
    }])),
    devices: Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
      label: device.label,
      placements: device.placements,
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
interface MergeTally {
  conflicts: string[];
  /** Fields the candidate contributed while the remote changed elsewhere. */
  mergedFields: number;
}

function mergeValue(base: unknown, candidate: unknown, remote: unknown, path: string, tally: MergeTally): unknown {
  if (same(candidate, remote)) return candidate;
  if (same(candidate, base)) return remote;
  if (same(remote, base)) {
    tally.mergedFields += 1;
    return candidate;
  }
  const maps = [base, candidate, remote].every((value) => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value)));
  if (maps) {
    const result: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys((base ?? {}) as object),
      ...Object.keys((candidate ?? {}) as object),
      ...Object.keys((remote ?? {}) as object),
    ]);
    for (const key of [...keys].sort()) {
      const value = mergeValue(
        (base as Record<string, unknown> | undefined)?.[key] ?? missing,
        (candidate as Record<string, unknown> | undefined)?.[key] ?? missing,
        (remote as Record<string, unknown> | undefined)?.[key] ?? missing,
        path ? `${path}.${key}` : key,
        tally,
      );
      if (value !== missing) result[key] = value;
    }
    return result;
  }
  // Deleting a device wins over a concurrent edit made by that device.
  if (path.startsWith("devices.") && (candidate === missing || remote === missing)) return missing;
  tally.conflicts.push(path);
  return candidate;
}

function fromSemantic(value: Record<string, any>): Omit<AccountConfigGraph, "sources"> {
  const account: AccountConfiguration = {
    version: 1,
    community: value.account.community,
    profile: value.account.profile,
    admins: Object.keys(value.account.admins).sort(),
  };
  const trees: TreesConfiguration = {
    version: 1,
    trees: Object.fromEntries(Object.entries(value.trees).map(([id, raw]: [string, any]) => [id, {
      kind: raw.kind,
      canonicalPath: raw.canonicalPath,
      access: Object.values(raw.access),
    }])),
  };
  const devices = Object.fromEntries(Object.entries(value.devices).map(([id, raw]: [string, any]) => [id, {
    version: 1,
    id,
    label: raw.label,
    placements: raw.placements,
  }])) as Record<string, DeviceConfiguration>;
  return { account, trees, devices };
}

export function mergeAccountConfigGraphs(base: AccountConfigGraph, candidate: AccountConfigGraph, remote: AccountConfigGraph) {
  const tally: MergeTally = { conflicts: [], mergedFields: 0 };
  const value = mergeValue(semantic(base), semantic(candidate), semantic(remote), "", tally) as Record<string, any>;
  return { graph: fromSemantic(value), conflicts: tally.conflicts, mergedFields: tally.mergedFields };
}

export function authorizeAccountConfigTransition(
  current: AccountConfigGraph,
  next: AccountConfigGraph,
  deviceID: string,
  changesFrom: AccountConfigGraph = current,
): void {
  if (!current.devices[deviceID]) throw new Error("Submitting device is not active in the accepted configuration");
  const administrator = current.account.admins.includes(deviceID);
  const acceptedSemantic = semantic(current) as any;
  const nextSemantic = semantic(next) as any;
  const baseSemantic = semantic(changesFrom) as any;
  const accountChangedBySubmitter = !same(baseSemantic.account, nextSemantic.account)
    && !same(acceptedSemantic.account, nextSemantic.account);
  const treesChangedBySubmitter = !same(baseSemantic.trees, nextSemantic.trees)
    && !same(acceptedSemantic.trees, nextSemantic.trees);
  if (!administrator && (accountChangedBySubmitter || treesChangedBySubmitter)) {
    throw new Error("Only an administrator may edit account.yaml or trees.yaml");
  }
  for (const id of new Set([...Object.keys(baseSemantic.devices), ...Object.keys(nextSemantic.devices)])) {
    if (id === deviceID) continue;
    const before = baseSemantic.devices[id];
    const after = nextSemantic.devices[id];
    if (same(after, acceptedSemantic.devices[id])) continue;
    if (before && !after && administrator) continue;
    if (!same(before, after)) throw new Error(`Device ${deviceID} may not edit devices/${id}.yaml`);
  }
  if (!next.account.admins.length || next.account.admins.some((id) => !next.devices[id])) {
    throw new Error("Administrators must remain a nonempty subset of active devices");
  }
  for (const [id, before] of Object.entries(changesFrom.trees.trees)) {
    const after = next.trees.trees[id];
    if (after && after.kind !== before.kind) throw new Error(`Tree kind is immutable after activation: ${id}`);
  }
}

function yaml(value: unknown): string {
  return stringify(value, { aliasDuplicateObjects: false, lineWidth: 0, sortMapEntries: true });
}

export function snapshotAccountConfig(graph: Omit<AccountConfigGraph, "sources">): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const file = (source: string): ObjectHash => {
    const bytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(source) });
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  const devicesEntries = Object.entries(graph.devices).sort(([a], [b]) => a.localeCompare(b)).map(([id, device]) => ({
    name: `${id}.yaml`,
    hash: file(yaml({ version: 1, label: device.label, placements: device.placements })),
  }));
  const devicesBytes = encodeWireObject({ type: "directory", entries: devicesEntries } satisfies WireDirectory);
  const devicesHash = hashObject(devicesBytes);
  objects.set(devicesHash, devicesBytes);
  const rootBytes = encodeWireObject({ type: "directory", entries: [
    { name: "account.yaml", hash: file(yaml(graph.account)) },
    { name: "devices", hash: devicesHash },
    { name: "trees.yaml", hash: file(yaml(graph.trees)) },
  ] } satisfies WireDirectory);
  const root = hashObject(rootBytes);
  objects.set(root, rootBytes);
  return { root, objects };
}
