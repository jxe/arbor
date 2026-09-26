import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, TreeID } from "../index.ts";
import { writeAtomic } from "../model/file-ops.ts";
import { parseDocument, type Document } from "yaml";
import { arborDataRoot, arborPrivateRoot, prepareArborDataRoot } from "./private-state.ts";
import { HostAccountStore } from "./server-config.ts";
import {
  checkTreeConfig,
  parseAccessYAML,
  parseAppsYAML,
  parseDevicesYAML,
  parseMountsYAML,
  treeConfigurationID,
  type TreeConfigDevice,
  type TreeConfigValues,
} from "./tree-config.ts";

/**
 * A host account's local checkout: the configuration of the account's
 * person profile (`access.yaml`, `mounts.yaml`, `apps.yaml`, `devices.yaml`),
 * placed at `accounts/<configuration TreeID>/`. The profile and the host
 * origin are the account's connection record, not authored files.
 */
export interface AccountConfigurationSnapshot {
  configurationTree: TreeID;
  path: string;
  /** The Canopy origin of the account's connection. */
  canopy?: string;
  /** The person profile whose configuration this is. */
  profile?: TreeID;
  configuration?: TreeConfigValues;
  devices?: Record<string, TreeConfigDevice>;
  currentDevice?: TreeConfigDevice;
  sources: Record<string, string>;
  diagnostics: Diagnostic[];
}

export type AccountDeviceConfiguration = TreeConfigDevice;

const ID = /^(?:tr|dv)_[a-z2-7]+$/;

function issue(code: string, message: string, path: string): Diagnostic {
  return { code, message, path, severity: "warning" };
}

export function configurationTreeID(value: unknown, label = "configuration TreeID"): TreeID {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith("tr_")) throw new Error(`${label} is not a TreeID`);
  return value;
}

function deviceID(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith("dv_")) throw new Error(`${label} is not a DeviceID`);
  return value;
}

/** A person's `devices.yaml`. */
export function parseAccountDevicesConfiguration(source: string): Record<string, AccountDeviceConfiguration> {
  return parseDevicesYAML(source);
}

export function accountsRoot(): string {
  return join(arborDataRoot(), "accounts");
}

export function accountCheckoutPath(configurationTree: string): string {
  return join(accountsRoot(), configurationTreeID(configurationTree));
}

/**
 * Edit one file of an account checkout on disk.
 *
 * Contract (shared with the Mac app's Swift twin, `AccountConfigurationYAML`):
 * - The file lives at `accountCheckoutPath(configurationTree)/<filename>` and is
 *   read as strict UTF-8.
 * - It is parsed as a single YAML document with unique keys and source tokens
 *   retained, so an edit rewrites only the nodes it touches; comments, ordering,
 *   and unrelated formatting survive.
 * - `change` mutates the document in place; the result is serialized without
 *   line folding (`lineWidth: 0`).
 * - `validate` runs against the serialized source before anything is written;
 *   when it throws, the file on disk is untouched.
 * - The new source replaces the file atomically (temporary file + rename), so
 *   the daemon's checkout watcher only ever observes complete files.
 * - Nothing here talks to the daemon. The checkout is a placed folder: Arbor Sync
 *   watches it and pushes the edit like any other placement, and callers that
 *   need it pushed before they exit ask the daemon to synchronize afterwards.
 *
 * Returns the source that was written.
 */
export async function editAccountConfigurationFile(
  configurationTree: string,
  filename: string,
  change: (document: Document) => void | Promise<void>,
  validate?: (source: string) => void,
): Promise<string> {
  const path = join(accountCheckoutPath(configurationTree), filename);
  const previous = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  const document = parseDocument(previous, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(`${filename} is invalid: ${document.errors[0]!.message}`);
  await change(document);
  const source = document.toString({ lineWidth: 0 });
  validate?.(source);
  await writeAtomic(path, source);
  return source;
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

const ACCOUNT_FILES = ["access.yaml", "mounts.yaml", "apps.yaml", "devices.yaml"] as const;

export async function loadAccountConfiguration(configurationTreeInput: string): Promise<AccountConfigurationSnapshot> {
  await prepareArborDataRoot();
  const configurationTree = configurationTreeID(configurationTreeInput);
  const path = accountCheckoutPath(configurationTree);
  const diagnostics: Diagnostic[] = [];
  const sources: Record<string, string> = {};
  const expected = new Set<string>(ACCOUNT_FILES);
  try {
    for (const name of await readdir(path)) {
      if (!expected.has(name)) diagnostics.push(issue("invalid-account-path", `Unsupported account configuration path: ${name}`, join(path, name)));
    }
  } catch (error) {
    diagnostics.push(issue("missing-account-checkout", error instanceof Error ? error.message : String(error), path));
    return { configurationTree, path, sources, diagnostics };
  }
  for (const name of ACCOUNT_FILES) {
    try { sources[name] = await readFile(join(path, name), "utf8"); }
    catch (error) {
      if (name === "apps.yaml" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      diagnostics.push(issue(`invalid-${name.replace(".yaml", "")}-yaml`, error instanceof Error ? error.message : String(error), join(path, name)));
    }
  }
  const connection = await new HostAccountStore(configurationTree).safe();
  const profile = connection?.profileTree;
  if (profile && treeConfigurationID(profile) !== configurationTree) {
    diagnostics.push(issue("account-identity-mismatch", `Account ${configurationTree} is not the configuration of profile ${profile}`, path));
  }
  const parsed: Partial<TreeConfigValues> = {};
  const parse = <T>(name: string, read: (source: string) => T): T | undefined => {
    if (sources[name] === undefined) return undefined;
    try { return read(sources[name]!); }
    catch (error) {
      diagnostics.push(issue(`invalid-${name.replace(".yaml", "")}-yaml`, error instanceof Error ? error.message : String(error), join(path, name)));
      return undefined;
    }
  };
  parsed.access = parse("access.yaml", parseAccessYAML);
  parsed.mounts = parse("mounts.yaml", parseMountsYAML);
  parsed.apps = sources["apps.yaml"] === undefined ? {} : parse("apps.yaml", (source) => parseAppsYAML(source, "person"));
  const devices = parse("devices.yaml", parseDevicesYAML);
  parsed.devices = devices;
  let configuration: TreeConfigValues | undefined;
  if (parsed.access && parsed.mounts && parsed.apps && devices) {
    try {
      checkTreeConfig(parsed as TreeConfigValues, "person", profile);
      configuration = parsed as TreeConfigValues;
    } catch (error) {
      diagnostics.push(issue("invalid-access-yaml", error instanceof Error ? error.message : String(error), join(path, "access.yaml")));
    }
  }
  const current = await currentAccountDeviceID(configurationTree);
  if (current && devices && !devices[current]) diagnostics.push(issue("inactive-current-device", `Current device ${current} is not active`, join(path, "devices.yaml")));
  return {
    configurationTree,
    path,
    ...(connection ? { canopy: connection.origin, profile: connection.profileTree } : {}),
    ...(configuration ? { configuration } : {}),
    ...(devices ? { devices } : {}),
    ...(current && devices?.[current] ? { currentDevice: devices[current] } : {}),
    sources,
    diagnostics,
  };
}

export async function loadAccountConfigurations(): Promise<AccountConfigurationSnapshot[]> {
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
  return Promise.all(valid.sort().map(loadAccountConfiguration));
}

export async function watchAccountConfigurations(onChange: () => void): Promise<() => void> {
  await mkdir(accountsRoot(), { recursive: true, mode: 0o700 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const accountWatchers = new Map<string, FSWatcher>();
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  };
  const refreshAccountWatchers = async () => {
    const accounts = await loadAccountConfigurations();
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
