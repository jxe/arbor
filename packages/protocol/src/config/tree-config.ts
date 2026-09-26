import { isAlias, isMap, isSeq, parseDocument, stringify, type Node } from "yaml";
import {
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  type ObjectHash,
  type ProtocolDirectory,
  type TreeSnapshot,
} from "../objects.ts";
import { encodeBase32 } from "../model/identity.ts";
import { sha256 } from "../model/hash.ts";
import { isDeviceKey } from "../model/device-keys.ts";
import { stableJSONString } from "../model/protocol.ts";
import {
  intersectResourceRules,
  isTreeID,
  parseAppRule,
  parseResourceRules,
  resourceRuleKey,
  type AccessOperation,
  type AccessWho,
  type ResourceAccessRule,
} from "../model/resource-policy.ts";

/**
 * A tree configuration: the private tree, edited only by a tree's
 * administrators, that holds who may do what to the tree (`access.yaml`) and
 * which child trees it mounts (`mounts.yaml`). A profile tree's configuration
 * also holds the apps that may use the profile's access (`apps.yaml`) and, for
 * a person, their devices (`devices.yaml`). Its server policy is
 * `tree-config-v1`.
 */
export const TREE_CONFIG_POLICY = "tree-config-v1";

/** Which files a configuration may hold follows from the kind of its tree. */
export type TreeConfigKind = "tree" | "person" | "group";

export interface TreeConfigDevice {
  id: string;
  label: string;
  administrator: boolean;
  /** A key device's public key (`ed25519:…` or `p256:…`); absent for a
   * digest device, whose credential digest is host state. */
  key?: string;
}

/** One `apps.yaml` rule: the access a profile lets one app use. */
export interface AppAccessRule {
  resource: string;
  who: AccessWho;
  allow: AccessOperation[];
  within?: string;
}

/** The authored values of a tree configuration. `apps` is present exactly for
 * a profile's configuration, `devices` exactly for a person's. */
export interface TreeConfigValues {
  access: ResourceAccessRule[];
  mounts: Record<string, string>;
  apps?: Record<string, AppAccessRule[]>;
  devices?: Record<string, TreeConfigDevice>;
}

export interface TreeConfigGraph extends TreeConfigValues {
  sources: Record<string, string>;
}

export const TREE_CONFIG_FILES = ["access.yaml", "mounts.yaml", "apps.yaml", "devices.yaml"] as const;
export type TreeConfigFile = typeof TREE_CONFIG_FILES[number];

const CONFIGURATION_DOMAIN = "arbor-tree-config-v1\0";

/**
 * The TreeID of a tree's configuration: `tr_` and the unpadded lowercase
 * base32 of `SHA-256("arbor-tree-config-v1\0" || TreeID)`. Anyone can derive
 * it, so there is no pointer to keep consistent.
 */
export function treeConfigurationID(tree: string): string {
  if (!isTreeID(tree)) throw new Error("A tree configuration requires a TreeID");
  const digest = sha256(new TextEncoder().encode(`${CONFIGURATION_DOMAIN}${tree}`));
  return `tr_${encodeBase32(Uint8Array.from(digest.match(/../g)!, (byte) => Number.parseInt(byte, 16)))}`;
}

/** The segment parameter that addresses a tree's configuration. */
export const CONFIGURATION_PARAMETER = "arbor-config";

/** A tree reference as the host routes read it: `tr_x` or `tr_x;arbor-config`. */
export function parseTreeReference(value: string): { tree: string; configuration: boolean } {
  const suffix = `;${CONFIGURATION_PARAMETER}`;
  const configuration = value.endsWith(suffix);
  const tree = configuration ? value.slice(0, -suffix.length) : value;
  if (!isTreeID(tree)) throw new Error(`Invalid tree reference: ${value}`);
  return { tree, configuration };
}

function containsAlias(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (isAlias(node)) return true;
  if (isMap(node)) return node.items.some((pair) => containsAlias(pair.key as Node) || containsAlias(pair.value as Node));
  if (isSeq(node)) return node.items.some((item) => containsAlias(item as Node));
  return false;
}

/** Strict YAML: one document, unique keys, no aliases. */
export function parseStrictYAML(source: string, label: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${label} is invalid: ${document.errors[0]!.message}`);
  if (containsAlias(document.contents as Node | null)) throw new Error("YAML aliases are not allowed");
  return document.toJS({ maxAliasCount: 0 });
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function deviceID(value: string, label: string): string {
  if (!/^dv_[a-z2-7]+$/.test(value)) throw new Error(`${label} is not a DeviceID`);
  return value;
}

/** A mount's name: a relative logical path of plain segments. */
export function mountPath(value: string): string {
  const segments = value.split("/");
  if (!value || segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[\x00-\x1f\x7f\\]/.test(segment) || segment === "_index.md")) {
    throw new Error(`Invalid mount path: ${value}`);
  }
  return value;
}

export function parseAccessYAML(source: string): ResourceAccessRule[] {
  const value = parseStrictYAML(source, "access.yaml");
  const rules = parseResourceRules(value ?? []);
  if (!rules.some((rule) => rule.allow.includes("admin"))) throw new Error("access.yaml must grant admin to at least one profile");
  return rules;
}

export function parseMountsYAML(source: string): Record<string, string> {
  const value = mapping(parseStrictYAML(source, "mounts.yaml"), "mounts.yaml");
  const mounts: Record<string, string> = {};
  const trees = new Set<string>();
  for (const [path, tree] of Object.entries(value)) {
    mountPath(path);
    if (!isTreeID(tree)) throw new Error(`mounts.yaml ${path} must name a TreeID`);
    if (trees.has(tree)) throw new Error(`mounts.yaml mounts ${tree} more than once`);
    trees.add(tree);
    mounts[path] = tree;
  }
  const paths = Object.keys(mounts);
  for (const path of paths) {
    if (paths.some((other) => other !== path && other.startsWith(`${path}/`))) {
      throw new Error(`mounts.yaml mounts a tree inside the mount ${path}`);
    }
  }
  return mounts;
}

export function parseAppsYAML(source: string, kind: "person" | "group"): Record<string, AppAccessRule[]> {
  const value = mapping(parseStrictYAML(source, "apps.yaml"), "apps.yaml");
  const apps: Record<string, AppAccessRule[]> = {};
  for (const [app, list] of Object.entries(value)) {
    if (!isTreeID(app)) throw new Error(`apps.yaml key ${app} is not a TreeID`);
    if (!Array.isArray(list)) throw new Error(`apps.yaml ${app} must be a list`);
    const rules = list.map((item): AppAccessRule => {
      const entry = mapping(item, `apps.yaml ${app}`);
      if (Object.keys(entry).some((key) => !["resource", "who", "allow", "within"].includes(key))) {
        throw new Error(`apps.yaml ${app} has an unknown field`);
      }
      if (!isTreeID(entry.resource)) throw new Error(`apps.yaml ${app} resource must be a TreeID`);
      const rule = parseAppRule(entry, kind === "person" ? "person-apps" : "group-apps");
      return { resource: entry.resource, ...rule, allow: rule.allow as AccessOperation[] };
    });
    if (new Set(rules.map(appRuleKey)).size !== rules.length) throw new Error(`apps.yaml ${app} has duplicate rules`);
    apps[app] = rules;
  }
  return apps;
}

export function parseDevicesYAML(source: string): Record<string, TreeConfigDevice> {
  const value = mapping(parseStrictYAML(source, "devices.yaml"), "devices.yaml");
  const devices: Record<string, TreeConfigDevice> = {};
  for (const [idValue, candidate] of Object.entries(value)) {
    const id = deviceID(idValue, `devices.yaml key ${idValue}`);
    const device = mapping(candidate, `devices.yaml.${id}`);
    const unknown = Object.keys(device).filter((key) => key !== "label" && key !== "administrator" && key !== "key");
    if (unknown.length) throw new Error(`devices.yaml.${id} has unknown fields: ${unknown.join(", ")}`);
    if (typeof device.label !== "string" || !device.label.trim()) throw new Error(`devices.yaml.${id}.label must be nonempty`);
    if (device.administrator !== undefined && typeof device.administrator !== "boolean") {
      throw new Error(`devices.yaml.${id}.administrator must be true or false`);
    }
    if (device.key !== undefined && !isDeviceKey(device.key)) throw new Error(`devices.yaml.${id}.key is not a device key`);
    devices[id] = { id, label: device.label, administrator: device.administrator === true, ...(device.key !== undefined ? { key: device.key as string } : {}) };
  }
  const keys = Object.values(devices).flatMap((device) => device.key ? [device.key] : []);
  if (new Set(keys).size !== keys.length) throw new Error("devices.yaml lists one key for two devices");
  if (!Object.values(devices).some((device) => device.administrator)) throw new Error("devices.yaml must contain an administrator");
  return devices;
}

/** An `apps.yaml` rule's merge key within its app: canonical `(resource, who, within)`. */
export function appRuleKey(rule: AppAccessRule): string {
  const who = typeof rule.who === "string" ? rule.who : "profile" in rule.who ? `profile:${rule.who.profile}` : `link:${rule.who.link}`;
  return JSON.stringify([rule.resource, who, rule.within ?? "/"]);
}

/**
 * Validation that depends on the tree a configuration belongs to: a person's
 * configuration grants `admin` to that person and no one else, and nothing
 * mounts the tree inside itself.
 */
export function checkTreeConfig(values: TreeConfigValues, kind: TreeConfigKind, tree?: string): void {
  if ((values.apps !== undefined) !== (kind !== "tree")) {
    throw new Error(kind === "tree" ? "Only a profile's configuration may hold apps.yaml" : "A profile's configuration must hold apps.yaml");
  }
  if ((values.devices !== undefined) !== (kind === "person")) {
    throw new Error(kind === "person" ? "A person's configuration must hold devices.yaml" : "Only a person's configuration may hold devices.yaml");
  }
  if (!values.access.some((rule) => rule.allow.includes("admin"))) throw new Error("access.yaml must grant admin to at least one profile");
  if (values.devices && !Object.values(values.devices).some((device) => device.administrator)) {
    throw new Error("devices.yaml must contain an administrator");
  }
  if (tree) {
    if (Object.values(values.mounts).includes(tree)) throw new Error("A tree cannot mount itself");
    if (kind === "person") {
      const admins = values.access.filter((rule) => rule.allow.includes("admin"));
      if (admins.length !== 1 || typeof admins[0]!.who !== "object" || !("profile" in admins[0]!.who) || admins[0]!.who.profile !== tree) {
        throw new Error("A person's configuration grants admin to that person and no one else");
      }
    }
  }
}

function text(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${path} must be UTF-8`); }
}

/** Parse and validate the complete graph of a tree configuration. */
export function readTreeConfigGraph(snapshot: TreeSnapshot, kind: TreeConfigKind, tree?: string): TreeConfigGraph {
  const load = (hash: ObjectHash, path: string) => {
    const bytes = snapshot.objects.get(hash);
    if (!bytes) throw new Error(`Tree configuration is missing ${path}`);
    return bytes;
  };
  const root = decodeProtocolDirectory(load(snapshot.root, "/"));
  if (root.type !== "directory" || root.childrenSource) throw new Error("Tree configuration root must be a plain directory");
  const allowed = new Set<string>(["access.yaml", "mounts.yaml", ...(kind !== "tree" ? ["apps.yaml"] : []), ...(kind === "person" ? ["devices.yaml"] : [])]);
  const sources: Record<string, string> = {};
  for (const entry of root.entries) {
    if (!allowed.has(entry.name)) throw new Error(`Unsupported tree configuration path: ${entry.name}`);
    if (!entry.file) throw new Error(`Tree configuration ${entry.name} must be a file`);
    sources[entry.name] = text(load(entry.file, entry.name), entry.name);
  }
  for (const required of ["access.yaml", "mounts.yaml", ...(kind === "person" ? ["devices.yaml"] : [])]) {
    if (sources[required] === undefined) throw new Error(`Tree configuration requires ${required}`);
  }
  const values: TreeConfigValues = {
    access: parseAccessYAML(sources["access.yaml"]!),
    mounts: parseMountsYAML(sources["mounts.yaml"]!),
    ...(kind !== "tree" ? { apps: sources["apps.yaml"] === undefined ? {} : parseAppsYAML(sources["apps.yaml"], kind) } : {}),
    ...(kind === "person" ? { devices: parseDevicesYAML(sources["devices.yaml"]!) } : {}),
  };
  checkTreeConfig(values, kind, tree);
  return { ...values, sources };
}

function yaml(value: unknown): string {
  return stringify(value, { aliasDuplicateObjects: false, lineWidth: 0, sortMapEntries: true });
}

function ruleValue(rule: ResourceAccessRule): Record<string, unknown> {
  return {
    who: rule.who,
    ...(rule.app ? { app: rule.app } : {}),
    allow: [...rule.allow],
    ...(rule.within && rule.within !== "/" ? { within: rule.within } : {}),
  };
}

/** Canonical authored files for configuration values. */
export function treeConfigSources(values: TreeConfigValues): Partial<Record<TreeConfigFile, string>> {
  // Administrators first, then every other rule by its merge key.
  const order = (rule: ResourceAccessRule) => `${rule.allow.includes("admin") ? 0 : 1}${resourceRuleKey(rule)}`;
  const access = [...values.access].sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0);
  return {
    "access.yaml": stringify(access.map(ruleValue), { lineWidth: 0 }),
    "mounts.yaml": yaml(values.mounts),
    ...(values.apps ? { "apps.yaml": yaml(Object.fromEntries(Object.entries(values.apps).map(([app, rules]) => [app,
      [...rules].sort((a, b) => appRuleKey(a) < appRuleKey(b) ? -1 : appRuleKey(a) > appRuleKey(b) ? 1 : 0).map((rule) => ({
        resource: rule.resource,
        ...(rule.who === "me" || rule.who === "members" ? {} : { who: rule.who }),
        allow: [...rule.allow],
        ...(rule.within && rule.within !== "/" ? { within: rule.within } : {}),
      }))]))) } : {}),
    ...(values.devices ? { "devices.yaml": yaml(Object.fromEntries(Object.entries(values.devices).map(([id, device]) => [id, {
      label: device.label,
      ...(device.administrator ? { administrator: true } : {}),
      ...(device.key ? { key: device.key } : {}),
    }]))) } : {}),
  };
}

/** A snapshot of the given files; objects include the root directory. */
export function snapshotTreeConfigFiles(files: Partial<Record<TreeConfigFile, string>>): TreeSnapshot {
  const objects = new Map<ObjectHash, Uint8Array>();
  const entries: ProtocolDirectory["entries"] = [];
  for (const name of Object.keys(files).sort() as TreeConfigFile[]) {
    const bytes = new TextEncoder().encode(files[name]!);
    const hash = hashObject(bytes);
    objects.set(hash, bytes);
    entries.push({ name, file: hash });
  }
  const rootBytes = encodeProtocolDirectory({ type: "directory", entries } satisfies ProtocolDirectory);
  const root = hashObject(rootBytes);
  objects.set(root, rootBytes);
  return { root, objects };
}

export function snapshotTreeConfig(values: TreeConfigValues): TreeSnapshot {
  return snapshotTreeConfigFiles(treeConfigSources(values));
}

/** The initial configuration of a person's profile: that person administers
 * it from one administrator device. */
export function initialPersonConfig(profile: string, device: { id: string; label: string; key?: string }): TreeConfigValues {
  return {
    access: [{ who: { profile }, allow: ["admin"] }],
    mounts: {},
    apps: {},
    devices: { [device.id]: { id: device.id, label: device.label, administrator: true, ...(device.key ? { key: device.key } : {}) } },
  };
}

// The comparable form, merge and conflicts.

/** Rules keyed by merge key, so authoring order and the default scope
 * spelling do not count. */
export function semanticTreeConfig(values: TreeConfigValues): Record<string, any> {
  const rule = (value: ResourceAccessRule | AppAccessRule) => {
    const { within, ...rest } = value;
    return { ...rest, ...(within && within !== "/" ? { within } : {}), allow: [...value.allow].sort() };
  };
  return {
    access: Object.fromEntries(values.access.map((r) => [resourceRuleKey(r), rule(r)])),
    mounts: { ...values.mounts },
    ...(values.apps ? { apps: Object.fromEntries(Object.entries(values.apps).map(([app, rules]) => [app, Object.fromEntries(rules.map((r) => [appRuleKey(r), rule(r)]))])) } : {}),
    ...(values.devices ? { devices: Object.fromEntries(Object.entries(values.devices).map(([id, device]) => [id, { label: device.label, administrator: device.administrator, ...(device.key ? { key: device.key } : {}) }])) } : {}),
  };
}

function fromSemantic(value: Record<string, any>): TreeConfigValues {
  return {
    access: Object.values(value.access ?? {}) as ResourceAccessRule[],
    mounts: { ...(value.mounts ?? {}) },
    ...(value.apps ? { apps: Object.fromEntries(Object.entries(value.apps).map(([app, rules]) => [app, Object.values(rules as object) as AppAccessRule[]])) } : {}),
    ...(value.devices ? { devices: Object.fromEntries(Object.entries(value.devices).map(([id, raw]: [string, any]) => [id, { id, label: raw.label, administrator: raw.administrator === true, ...(raw.key ? { key: raw.key } : {}) }])) } : {}),
  };
}

export function sameTreeConfigValue(left: unknown, right: unknown): boolean {
  return stableJSONString(left) === stableJSONString(right);
}

/**
 * A field the merge could not settle. A `policy` conflict is an ambiguous
 * edit of one rule: the merge enforces the restrictive intersection, and an
 * administrator may leave it open. Any other conflict refuses the merge.
 */
export interface TreeConfigConflict {
  file: TreeConfigFile;
  field: string;
  policy: boolean;
}

const missing = Symbol("missing");

function mergeValue(base: unknown, candidate: unknown, remote: unknown, path: string, conflicts: TreeConfigConflict[]): unknown {
  const same = sameTreeConfigValue;
  if (same(candidate, remote)) return candidate;
  if (same(candidate, base)) return remote;
  if (same(remote, base)) return candidate;
  const [area] = path.split(".");
  const file = `${area}.yaml` as TreeConfigFile;
  const rule = /^access\.[^.]+$/.test(path) || /^apps\.[^.]+\.[^.]+$/.test(path);
  if (rule) {
    conflicts.push({ file, field: path, policy: true });
    if (candidate === missing || remote === missing) return missing;
    return intersectResourceRules(candidate as ResourceAccessRule, remote as ResourceAccessRule) ?? missing;
  }
  // Removal beats a concurrent edit of the same device or mount.
  if (/^(?:devices|mounts)\.[^.]+$/.test(path) && (candidate === missing || remote === missing)) return missing;
  const maps = [base, candidate, remote].every((value) => value === missing || (value !== null && typeof value === "object" && !Array.isArray(value)));
  if (maps) {
    const at = (value: unknown, key: string) => value === missing ? missing : (value as Record<string, unknown>)[key] ?? missing;
    const keys = new Set([base, candidate, remote].flatMap((value) => value === missing ? [] : Object.keys(value as object)));
    const result: Record<string, unknown> = {};
    for (const key of [...keys].sort()) {
      const value = mergeValue(at(base, key), at(candidate, key), at(remote, key), path ? `${path}.${key}` : key, conflicts);
      if (value !== missing) result[key] = value;
    }
    return result;
  }
  conflicts.push({ file, field: path, policy: false });
  return candidate;
}

/**
 * The restrictive three-way merge: disjoint changes merge, removal beats a
 * concurrent edit of the same entry, ambiguous rule edits enforce their
 * intersection, and a result that would break an invariant (no administrator,
 * no administrator device, a tree mounted twice) is a conflict.
 */
export function mergeTreeConfigs(base: TreeConfigValues, candidate: TreeConfigValues, remote: TreeConfigValues): { values: TreeConfigValues; conflicts: TreeConfigConflict[] } {
  const conflicts: TreeConfigConflict[] = [];
  const merged = mergeValue(semanticTreeConfig(base), semanticTreeConfig(candidate), semanticTreeConfig(remote), "", conflicts) as Record<string, any>;
  const values = fromSemantic(merged);
  if (!values.access.some((rule) => rule.allow.includes("admin"))) conflicts.push({ file: "access.yaml", field: "access", policy: false });
  if (values.devices && !Object.values(values.devices).some((device) => device.administrator)) conflicts.push({ file: "devices.yaml", field: "devices", policy: false });
  if (new Set(Object.values(values.mounts)).size !== Object.keys(values.mounts).length) conflicts.push({ file: "mounts.yaml", field: "mounts", policy: false });
  return { values, conflicts };
}
