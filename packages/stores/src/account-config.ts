import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { AccessRule, Diagnostic, TreeID } from "@arbor/core";
import { isAlias, isMap, isSeq, parseDocument, type Node } from "yaml";
import { arborDataRoot, arborPrivateRoot, prepareArborDataRoot } from "./private-state.ts";

export interface AccountConfiguration {
  version: 1;
  community: string;
  profile: { tree: TreeID; handle: string };
  admins: string[];
}

export interface TreeDeclaration {
  canonicalPath: string;
  access: AccessRule[];
}

export interface TreesConfiguration {
  version: 1;
  trees: Record<TreeID, TreeDeclaration>;
}

export interface DevicePlacement {
  server: string;
  path?: string;
}

export interface DeviceConfiguration {
  version: 1;
  id: string;
  label: string;
  placements: Record<TreeID, DevicePlacement>;
}

export interface AccountConfigurationSnapshot {
  account?: AccountConfiguration;
  trees?: TreesConfiguration;
  devices: Record<string, DeviceConfiguration>;
  currentDevice?: DeviceConfiguration;
  diagnostics: Diagnostic[];
}

const ID = /^(?:tr|dv)_[a-z2-7]+$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
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

function parseStrict(source: string, path: string): unknown {
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

function origin(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an HTTP(S) origin`);
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error(`${label} must be an HTTP(S) origin`);
  }
  return value;
}

function treeID(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith("tr_")) throw new Error(`${label} is not a TreeID`);
  return value;
}

function deviceID(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith("dv_")) throw new Error(`${label} is not a DeviceID`);
  return value;
}

function canonicalPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("//") || value.includes("\\") || value.includes("\0")) {
    throw new Error("canonicalPath must be a decoded absolute logical path");
  }
  return value === "/" ? value : value.replace(/\/$/, "");
}

function accessRules(value: unknown): AccessRule[] {
  if (!Array.isArray(value)) throw new Error("access must be a list");
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const rule = record(candidate, `access[${index}]`);
    exactFields(rule, ["subject", "access"], `access[${index}]`);
    if (rule.access !== "read" && rule.access !== "write") throw new Error(`access[${index}].access must be read or write`);
    const subject = record(rule.subject, `access[${index}].subject`);
    if (subject.kind === "everyone") {
      exactFields(subject, ["kind"], `access[${index}].subject`);
      if (seen.has("everyone")) throw new Error("access subjects must be unique");
      seen.add("everyone");
      return { subject: { kind: "everyone" }, access: rule.access };
    }
    if (subject.kind === "profile") {
      exactFields(subject, ["kind", "tree"], `access[${index}].subject`);
      const tree = treeID(subject.tree, `access[${index}].subject.tree`);
      if (seen.has(`profile:${tree}`)) throw new Error("access subjects must be unique");
      seen.add(`profile:${tree}`);
      return { subject: { kind: "profile", tree }, access: rule.access };
    }
    if (subject.kind === "link") {
      exactFields(subject, ["kind", "digest"], `access[${index}].subject`);
      if (typeof subject.digest !== "string" || !HASH.test(subject.digest)) throw new Error(`access[${index}].subject.digest is invalid`);
      if (seen.has(`link:${subject.digest}`)) throw new Error("access subjects must be unique");
      seen.add(`link:${subject.digest}`);
      return { subject: { kind: "link", digest: subject.digest as `sha256:${string}` }, access: rule.access };
    }
    throw new Error(`access[${index}].subject.kind is invalid`);
  });
}

export function parseAccountConfiguration(source: string, path = join(arborDataRoot(), "account.yaml")): AccountConfiguration {
  const value = record(parseStrict(source, path), "account.yaml");
  exactFields(value, ["version", "community", "profile", "admins"], "account.yaml");
  if (value.version !== 1) throw new Error("account.yaml version must be 1");
  const profile = record(value.profile, "profile");
  exactFields(profile, ["tree", "handle"], "profile");
  const handle = profile.handle;
  if (typeof handle !== "string" || !HANDLE.test(handle)) throw new Error("profile.handle is invalid");
  if (!Array.isArray(value.admins) || !value.admins.length) throw new Error("admins must be a nonempty DeviceID list");
  const admins = value.admins.map((id, index) => deviceID(id, `admins[${index}]`));
  if (new Set(admins).size !== admins.length) throw new Error("admins must not contain duplicates");
  return {
    version: 1,
    community: origin(value.community, "community"),
    profile: { tree: treeID(profile.tree, "profile.tree"), handle },
    admins,
  };
}

export function parseTreesConfiguration(source: string, path = join(arborDataRoot(), "trees.yaml")): TreesConfiguration {
  const value = record(parseStrict(source, path), "trees.yaml");
  exactFields(value, ["version", "trees"], "trees.yaml");
  if (value.version !== 1) throw new Error("trees.yaml version must be 1");
  const input = record(value.trees, "trees");
  const trees: Record<TreeID, TreeDeclaration> = {};
  for (const [idValue, candidate] of Object.entries(input)) {
    const id = treeID(idValue, `trees.${idValue}`);
    const declaration = record(candidate, `trees.${id}`);
    exactFields(declaration, ["canonicalPath", "access"], `trees.${id}`);
    trees[id] = {
      canonicalPath: canonicalPath(declaration.canonicalPath),
      access: accessRules(declaration.access),
    };
  }
  return { version: 1, trees };
}

export function parseDeviceConfiguration(source: string, idValue: string, path: string): DeviceConfiguration {
  const id = deviceID(idValue, "device filename");
  const value = record(parseStrict(source, path), path);
  exactFields(value, ["version", "label", "placements"], path);
  if (value.version !== 1) throw new Error(`${path} version must be 1`);
  if (typeof value.label !== "string" || !value.label.trim()) throw new Error(`${path} label must be nonempty`);
  const input = record(value.placements, `${path}.placements`);
  const placements: Record<TreeID, DevicePlacement> = {};
  for (const [treeValue, candidate] of Object.entries(input)) {
    const tree = treeID(treeValue, `${path}.placements key`);
    const placement = record(candidate, `${path}.placements.${tree}`);
    exactFields(placement, ["server", "path"], `${path}.placements.${tree}`);
    if (placement.server === undefined) throw new Error(`${path}.placements.${tree}.server is required`);
    const server = origin(placement.server, `${path}.placements.${tree}.server`);
    if (placement.path !== undefined && (
      typeof placement.path !== "string"
      || !isAbsolute(placement.path)
      || normalize(placement.path) !== placement.path
    )) throw new Error(`${path}.placements.${tree}.path must be canonical and absolute`);
    placements[tree] = { server, ...(placement.path === undefined ? {} : { path: placement.path }) };
  }
  return { version: 1, id, label: value.label, placements };
}

export function currentDeviceStatePath(): string {
  return join(arborPrivateRoot(), "device.json");
}

export async function currentDeviceID(): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(currentDeviceStatePath(), "utf8")) as { id?: unknown };
    return typeof value.id === "string" ? deviceID(value.id, "current device") : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveCurrentDeviceID(id: string): Promise<void> {
  await prepareArborDataRoot();
  const valid = deviceID(id, "current device");
  const destination = currentDeviceStatePath();
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ id: valid })}\n`, { mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function loadAccountConfiguration(): Promise<AccountConfigurationSnapshot> {
  await prepareArborDataRoot();
  const diagnostics: Diagnostic[] = [];
  let account: AccountConfiguration | undefined;
  let trees: TreesConfiguration | undefined;
  const accountPath = join(arborDataRoot(), "account.yaml");
  const treesPath = join(arborDataRoot(), "trees.yaml");
  try { account = parseAccountConfiguration(await readFile(accountPath, "utf8"), accountPath); }
  catch (error) { diagnostics.push(issue("invalid-account-yaml", error instanceof Error ? error.message : String(error), accountPath)); }
  try { trees = parseTreesConfiguration(await readFile(treesPath, "utf8"), treesPath); }
  catch (error) { diagnostics.push(issue("invalid-trees-yaml", error instanceof Error ? error.message : String(error), treesPath)); }

  const devices: Record<string, DeviceConfiguration> = {};
  const devicesPath = join(arborDataRoot(), "devices");
  await mkdir(devicesPath, { recursive: true, mode: 0o700 });
  for (const name of await readdir(devicesPath)) {
    const match = /^(dv_[a-z2-7]+)\.yaml$/.exec(name);
    const path = join(devicesPath, name);
    if (!match) {
      diagnostics.push(issue("invalid-device-file", `Unsupported account configuration path: devices/${name}`, path));
      continue;
    }
    try { devices[match[1]!] = parseDeviceConfiguration(await readFile(path, "utf8"), match[1]!, path); }
    catch (error) { diagnostics.push(issue("invalid-device-yaml", error instanceof Error ? error.message : String(error), path)); }
  }
  if (account) {
    for (const admin of account.admins) {
      if (!devices[admin]) diagnostics.push(issue("inactive-admin", `Administrator ${admin} is not an active device`, accountPath));
    }
  }
  const device = await currentDeviceID();
  return { account, trees, devices, ...(device && devices[device] ? { currentDevice: devices[device] } : {}), diagnostics };
}

export async function watchAccountConfiguration(onChange: () => void): Promise<() => void> {
  await prepareArborDataRoot();
  const devicesPath = join(arborDataRoot(), "devices");
  await mkdir(devicesPath, { recursive: true, mode: 0o700 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  };
  const rootWatcher = watch(arborDataRoot(), { persistent: false }, (_event, filename) => {
    if (["account.yaml", "trees.yaml", "devices"].includes(filename?.toString() ?? "")) changed();
  });
  const deviceWatcher = watch(devicesPath, { persistent: false }, changed);
  const watchers: FSWatcher[] = [rootWatcher, deviceWatcher];
  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
