import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccessRule, Diagnostic, TreeID } from "@arbor/core";
import { isAlias, isMap, isSeq, parseDocument, type Node } from "yaml";
import { arborDataRoot, arborPrivateRoot, prepareArborDataRoot } from "./private-state.ts";

export interface CanopyAccountConfiguration {
  canopy: string;
  profile: TreeID;
}

export interface HostedTreeDeclaration {
  canonical: string;
  access: AccessRule[];
}

export type HostedTreesConfiguration = Record<TreeID, HostedTreeDeclaration>;

export interface AccountDeviceConfiguration {
  id: string;
  label: string;
  administrator: boolean;
}

export interface CanopyAccountConfigurationSnapshot {
  configurationTree: TreeID;
  path: string;
  account?: CanopyAccountConfiguration;
  trees?: HostedTreesConfiguration;
  devices?: Record<string, AccountDeviceConfiguration>;
  currentDevice?: AccountDeviceConfiguration;
  sources: Record<string, string>;
  diagnostics: Diagnostic[];
}

const ID = /^(?:tr|dv)_[a-z2-7]+$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

function issue(code: string, message: string, path: string): Diagnostic {
  return { code, message, path, severity: "warning" };
}

function containsAlias(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (isAlias(node)) return true;
  if (isMap(node) || isSeq(node)) {
    return node.items.some((item: unknown) => {
      if (isMap(node)) {
        const pair = item as { key?: Node; value?: Node };
        return containsAlias(pair.key) || containsAlias(pair.value);
      }
      return containsAlias(item as Node);
    });
  }
  return false;
}

function parseStrict(source: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  if (containsAlias(document.contents as Node | null)) throw new Error("YAML aliases are not allowed");
  return document.toJS({ maxAliasCount: 0 });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

export function configurationTreeID(value: unknown, label = "configuration TreeID"): TreeID {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith("tr_")) throw new Error(`${label} is not a TreeID`);
  return value;
}

function deviceID(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith("dv_")) throw new Error(`${label} is not a DeviceID`);
  return value;
}

function canopyOrigin(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an HTTPS origin`);
  const parsed = new URL(value);
  const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !loopback) || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error(`${label} must be a normalized HTTPS origin`);
  }
  return value;
}

function accessRules(value: unknown, label: string): AccessRule[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const rule = record(candidate, `${label}[${index}]`);
    exactFields(rule, ["subject", "access"], `${label}[${index}]`);
    if (rule.access !== "read" && rule.access !== "write") throw new Error(`${label}[${index}].access must be read or write`);
    const subject = record(rule.subject, `${label}[${index}].subject`);
    if (subject.kind === "everyone") {
      exactFields(subject, ["kind"], `${label}[${index}].subject`);
      if (seen.has("everyone")) throw new Error(`${label} subjects must be unique`);
      seen.add("everyone");
      return { subject: { kind: "everyone" }, access: rule.access };
    }
    if (subject.kind === "profile") {
      exactFields(subject, ["kind", "tree"], `${label}[${index}].subject`);
      const tree = configurationTreeID(subject.tree, `${label}[${index}].subject.tree`);
      if (seen.has(`profile:${tree}`)) throw new Error(`${label} subjects must be unique`);
      seen.add(`profile:${tree}`);
      return { subject: { kind: "profile", tree }, access: rule.access };
    }
    if (subject.kind === "link") {
      exactFields(subject, ["kind", "digest"], `${label}[${index}].subject`);
      if (typeof subject.digest !== "string" || !HASH.test(subject.digest)) throw new Error(`${label}[${index}].subject.digest is invalid`);
      if (seen.has(`link:${subject.digest}`)) throw new Error(`${label} subjects must be unique`);
      seen.add(`link:${subject.digest}`);
      return { subject: { kind: "link", digest: subject.digest as `sha256:${string}` }, access: rule.access };
    }
    throw new Error(`${label}[${index}].subject.kind is invalid`);
  });
}

export function parseCanopyAccountConfiguration(source: string): CanopyAccountConfiguration {
  const value = record(parseStrict(source), "account.yaml");
  exactFields(value, ["canopy", "profile"], "account.yaml");
  return {
    canopy: canopyOrigin(value.canopy, "account.yaml canopy"),
    profile: configurationTreeID(value.profile, "account.yaml profile"),
  };
}

function canonicalURL(value: unknown, account: CanopyAccountConfiguration, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical HTTPS URL`);
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.origin !== account.canopy) {
    throw new Error(`${label} must use the account Canopy origin without credentials, query, or fragment`);
  }
  if (!url.pathname.startsWith("/") || url.pathname.includes("//")) throw new Error(`${label} path is not canonical`);
  return value;
}

export function parseHostedTreesConfiguration(source: string, account: CanopyAccountConfiguration): HostedTreesConfiguration {
  const value = record(parseStrict(source), "trees.yaml");
  const trees: HostedTreesConfiguration = {};
  for (const [idValue, candidate] of Object.entries(value)) {
    const id = configurationTreeID(idValue, `trees.yaml key ${idValue}`);
    const declaration = record(candidate, `trees.yaml.${id}`);
    exactFields(declaration, ["canonical", "access"], `trees.yaml.${id}`);
    trees[id] = {
      canonical: canonicalURL(declaration.canonical, account, `trees.yaml.${id}.canonical`),
      access: accessRules(declaration.access, `trees.yaml.${id}.access`),
    };
  }
  return trees;
}

export function parseAccountDevicesConfiguration(source: string): Record<string, AccountDeviceConfiguration> {
  const value = record(parseStrict(source), "devices.yaml");
  const devices: Record<string, AccountDeviceConfiguration> = {};
  for (const [idValue, candidate] of Object.entries(value)) {
    const id = deviceID(idValue, `devices.yaml key ${idValue}`);
    const device = record(candidate, `devices.yaml.${id}`);
    exactFields(device, ["label", "administrator"], `devices.yaml.${id}`);
    if (typeof device.label !== "string" || !device.label.trim()) throw new Error(`devices.yaml.${id}.label must be nonempty`);
    if (device.administrator !== undefined && typeof device.administrator !== "boolean") {
      throw new Error(`devices.yaml.${id}.administrator must be true or false`);
    }
    devices[id] = { id, label: device.label, administrator: device.administrator === true };
  }
  if (!Object.keys(devices).length) throw new Error("devices.yaml must contain an active device");
  if (!Object.values(devices).some((device) => device.administrator)) throw new Error("devices.yaml must contain an administrator");
  return devices;
}

export function accountsRoot(): string {
  return join(arborDataRoot(), "accounts");
}

export function accountCheckoutPath(configurationTree: string): string {
  return join(accountsRoot(), configurationTreeID(configurationTree));
}

function currentDeviceStatePath(configurationTree: string): string {
  return join(arborPrivateRoot(), "accounts", configurationTreeID(configurationTree), "device.json");
}

export async function currentAccountDeviceID(configurationTree: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(currentDeviceStatePath(configurationTree), "utf8")) as { id?: unknown };
    return typeof value.id === "string" ? deviceID(value.id, "current account device") : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveCurrentAccountDeviceID(configurationTree: string, idValue: string): Promise<void> {
  await prepareArborDataRoot();
  const id = deviceID(idValue, "current account device");
  const destination = currentDeviceStatePath(configurationTree);
  await mkdir(join(arborPrivateRoot(), "accounts", configurationTreeID(configurationTree)), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ id })}\n`, { mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function loadCanopyAccountConfiguration(configurationTreeInput: string): Promise<CanopyAccountConfigurationSnapshot> {
  await prepareArborDataRoot();
  const configurationTree = configurationTreeID(configurationTreeInput);
  const path = accountCheckoutPath(configurationTree);
  const diagnostics: Diagnostic[] = [];
  const sources: Record<string, string> = {};
  const expected = new Set(["account.yaml", "trees.yaml", "devices.yaml"]);
  try {
    for (const name of await readdir(path)) {
      if (!expected.has(name)) diagnostics.push(issue("invalid-account-path", `Unsupported account configuration path: ${name}`, join(path, name)));
    }
  } catch (error) {
    diagnostics.push(issue("missing-account-checkout", error instanceof Error ? error.message : String(error), path));
    return { configurationTree, path, sources, diagnostics };
  }
  for (const name of expected) {
    try { sources[name] = await readFile(join(path, name), "utf8"); }
    catch (error) { diagnostics.push(issue(`invalid-${name.replace(".yaml", "")}-yaml`, error instanceof Error ? error.message : String(error), join(path, name))); }
  }
  let account: CanopyAccountConfiguration | undefined;
  let trees: HostedTreesConfiguration | undefined;
  let devices: Record<string, AccountDeviceConfiguration> | undefined;
  try { if (sources["account.yaml"] !== undefined) account = parseCanopyAccountConfiguration(sources["account.yaml"]); }
  catch (error) { diagnostics.push(issue("invalid-account-yaml", error instanceof Error ? error.message : String(error), join(path, "account.yaml"))); }
  try { if (account && sources["trees.yaml"] !== undefined) trees = parseHostedTreesConfiguration(sources["trees.yaml"], account); }
  catch (error) { diagnostics.push(issue("invalid-trees-yaml", error instanceof Error ? error.message : String(error), join(path, "trees.yaml"))); }
  try { if (sources["devices.yaml"] !== undefined) devices = parseAccountDevicesConfiguration(sources["devices.yaml"]); }
  catch (error) { diagnostics.push(issue("invalid-devices-yaml", error instanceof Error ? error.message : String(error), join(path, "devices.yaml"))); }
  if (trees?.[configurationTree]) diagnostics.push(issue("self-declared-account", "The account-configuration tree must not declare itself", join(path, "trees.yaml")));
  const current = await currentAccountDeviceID(configurationTree);
  if (current && devices && !devices[current]) diagnostics.push(issue("inactive-current-device", `Current device ${current} is not active`, join(path, "devices.yaml")));
  return {
    configurationTree,
    path,
    account,
    trees,
    devices,
    ...(current && devices?.[current] ? { currentDevice: devices[current] } : {}),
    sources,
    diagnostics,
  };
}

export async function loadCanopyAccountConfigurations(): Promise<CanopyAccountConfigurationSnapshot[]> {
  await prepareArborDataRoot();
  let names: string[];
  try { names = await readdir(accountsRoot()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const valid: string[] = [];
  for (const name of names) {
    try { valid.push(configurationTreeID(name, `accounts/${name}`)); }
    catch { /* Invalid entries surface through the root layout validator later. */ }
  }
  return Promise.all(valid.sort().map(loadCanopyAccountConfiguration));
}

export async function watchCanopyAccountConfigurations(onChange: () => void): Promise<() => void> {
  await mkdir(accountsRoot(), { recursive: true, mode: 0o700 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const accountWatchers = new Map<string, FSWatcher>();
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  };
  const refreshAccountWatchers = async () => {
    const accounts = await loadCanopyAccountConfigurations();
    const paths = new Set(accounts.map((account) => account.path));
    for (const [path, watcher] of accountWatchers) {
      if (paths.has(path)) continue;
      watcher.close();
      accountWatchers.delete(path);
    }
    if (stopped) return;
    for (const path of paths) {
      if (accountWatchers.has(path)) continue;
      accountWatchers.set(path, watch(path, { persistent: false }, changed));
    }
  };
  await refreshAccountWatchers();
  const rootWatcher = watch(accountsRoot(), { persistent: false }, () => {
    changed();
    void refreshAccountWatchers().catch(changed);
  });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    rootWatcher.close();
    for (const watcher of accountWatchers.values()) watcher.close();
    accountWatchers.clear();
  };
}
