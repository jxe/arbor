import { stringify } from "yaml";
import {
  decodeWireDirectory,
  encodeWireDirectory,
  hashObject,
  type ObjectHash,
  type TreeSnapshot,
  type WireDirectory,
} from "../index.ts";
import {
  parseAccountDevicesConfiguration,
  parseCanopyAccountConfiguration,
  type AccountDeviceConfiguration,
  type CanopyAccountConfiguration,
  type HostedTreesConfiguration,
} from "./account-config-v2.ts";
import { hostedProjection, parseResourceConfiguration, type ResourceConfiguration } from "./resource-configuration.ts";

/** One account-configuration tree: `account.yaml`, `trees.yaml` and
 * `devices.yaml`, parsed, with their authored sources. */
export interface AccountConfigGraphV2 {
  account: CanopyAccountConfiguration;
  trees: HostedTreesConfiguration;
  /** `trees.yaml`; `trees` is its hosted-tree projection. */
  resources: ResourceConfiguration;
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
  return bytes;
}

export function readAccountConfigGraphV2(snapshot: TreeSnapshot, configurationTree?: string): AccountConfigGraphV2 {
  const root = decodeWireDirectory(object(snapshot, snapshot.root, "/"));
  if (root.type !== "directory") throw new Error("Account configuration root must be a directory");
  const allowed = new Set(["account.yaml", "trees.yaml", "devices.yaml"]);
  for (const entry of root.entries) {
    if (!allowed.has(entry.name)) throw new Error(`Unsupported account configuration path: ${entry.name}`);
    if (entry.tree) throw new Error("Account configuration cannot contain nested tree boundaries");
  }
  const sourceAt = (name: string): string => {
    const entry = root.entries.find((candidate) => candidate.name === name);
    if (!entry?.file) throw new Error(`Account configuration requires ${name}`);
    const value = object(snapshot, entry.file, name);
    return text(value, name);
  };
  const sources = {
    "account.yaml": sourceAt("account.yaml"),
    "trees.yaml": sourceAt("trees.yaml"),
    "devices.yaml": sourceAt("devices.yaml"),
  };
  const account = parseCanopyAccountConfiguration(sources["account.yaml"]);
  const resources = parseResourceConfiguration(sources["trees.yaml"], account);
  const devices = parseAccountDevicesConfiguration(sources["devices.yaml"]);
  if (configurationTree && resources[configurationTree]) throw new Error("The account-configuration tree must not declare itself");
  return { account, trees: hostedProjection(resources), resources, devices, sources };
}

/** The authored values of an account-configuration tree; `trees` is derived. */
export type AccountConfigValuesV2 = Pick<AccountConfigGraphV2, "account" | "resources" | "devices">;

function yaml(value: unknown): string {
  return stringify(value, { aliasDuplicateObjects: false, lineWidth: 0, sortMapEntries: true });
}

/** Canonical authored files. yaml() sorts every map by key, so the inputs
 * need no ordering of their own. */
function accountConfigSourcesV2(graph: AccountConfigValuesV2): Record<"account.yaml" | "devices.yaml" | "trees.yaml", string> {
  const devices = Object.fromEntries(Object.entries(graph.devices).map(([id, device]) => [id, {
    label: device.label,
    ...(device.administrator ? { administrator: true } : {}),
  }]));
  return {
    "account.yaml": yaml(graph.account),
    "devices.yaml": yaml(devices),
    "trees.yaml": yaml(graph.resources),
  };
}

export function snapshotAccountConfigV2(graph: AccountConfigValuesV2): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const file = (source: string): ObjectHash => {
    const bytes = new TextEncoder().encode(source);
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  };
  const sources = accountConfigSourcesV2(graph);
  const rootBytes = encodeWireDirectory({ type: "directory", entries: [
    { name: "account.yaml", file: file(sources["account.yaml"]) },
    { name: "devices.yaml", file: file(sources["devices.yaml"]) },
    { name: "trees.yaml", file: file(sources["trees.yaml"]) },
  ] } satisfies WireDirectory);
  const root = hashObject(rootBytes);
  objects.set(root, rootBytes);
  return { root, objects };
}
