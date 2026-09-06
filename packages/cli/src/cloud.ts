import { deflateRawSync, inflateRawSync } from "node:zlib";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stableJSONString } from "@arbor/core";

export const CLOUD_BUNDLE_PREFIX = "arbor-cloud-v1";
export const MAX_CLOUD_BUNDLE_LENGTH = 32 * 1024;

export interface CloudBundlePlacement {
  treeID: string;
  canonicalURL: string;
  relativePath: string;
}

export interface CloudBundlePayload {
  version: 1;
  bundleID: string;
  label: string;
  createdAt: string;
  origin: string;
  account: string;
  accountID: string;
  configurationTree: string;
  profileTree: string;
  deviceID: string;
  credential: string;
  placements: CloudBundlePlacement[];
}

export interface SafeCloudBundleRecord {
  bundleID: string;
  label: string;
  createdAt: string;
  origin: string;
  account: string;
  configurationTree: string;
  deviceID: string;
  revokedAt?: string;
}

export type CloudSessionPhase = "preparing" | "ready" | "draining" | "needs-sync" | "finished";

export interface CloudSessionRecord {
  version: 1;
  sessionID: string;
  bundleID: string;
  configurationTree: string;
  root: string;
  dataHome: string;
  instanceID: string;
  phase: CloudSessionPhase;
  createdAt: string;
  updatedAt: string;
  origin?: string;
  pid?: number;
  placements: Array<CloudBundlePlacement & { path: string }>;
  lastError?: string;
}

interface CloudSessionRegistry {
  version: 1;
  sessions: CloudSessionRecord[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function cloudBundleID(value: unknown): string {
  const result = nonempty(value, "cloud bundle ID");
  if (!/^cb_[a-z0-9]{20,64}$/.test(result)) throw new Error("Cloud bundle ID is invalid");
  return result;
}

function normalizedOrigin(value: unknown, label: string): string {
  const source = nonempty(value, label);
  const origin = new URL(source).origin;
  if (origin !== source) throw new Error(`${label} must be normalized`);
  return origin;
}

function treeID(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!/^tr_[a-z2-7]+$/.test(result)) throw new Error(`${label} must be a TreeID`);
  return result;
}

function portableRelativePath(value: unknown, label = "placement path"): string {
  const result = nonempty(value, label);
  if (result === "." || result.startsWith("/") || result.includes("\\")) {
    throw new Error(`${label} must be a portable relative path below the cloud root`);
  }
  const parts = result.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must not contain empty, dot, or parent segments`);
  }
  return parts.join("/");
}

export function validateCloudPlacementPaths(paths: readonly string[]): string[] {
  const normalized = paths.map((path, index) => portableRelativePath(path, `placement ${index + 1} path`));
  const sorted = [...normalized].sort();
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const previous = sorted[index - 1];
    if (current === previous) throw new Error(`Cloud placement path is repeated: ${current}`);
    if (previous && current.startsWith(`${previous}/`)) {
      throw new Error(`Cloud placement paths must not overlap: ${previous} and ${current}`);
    }
  }
  return normalized;
}

export function cloudPlacementPath(rootInput: string, relativePathInput: string): string {
  const root = resolve(rootInput);
  const relativePath = portableRelativePath(relativePathInput);
  const destination = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, destination);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Cloud placement escapes its root: ${relativePath}`);
  }
  return destination;
}

function validateCloudBundlePayload(value: unknown): CloudBundlePayload {
  const payload = record(value, "cloud bundle");
  exactFields(payload, [
    "version", "bundleID", "label", "createdAt", "origin", "account", "accountID",
    "configurationTree", "profileTree", "deviceID", "credential", "placements",
  ], "cloud bundle");
  if (payload.version !== 1) throw new Error("Cloud bundle version is unsupported");
  const bundleID = cloudBundleID(payload.bundleID);
  const origin = normalizedOrigin(payload.origin, "cloud bundle origin");
  const account = nonempty(payload.account, "cloud bundle account");
  if (new URL(account).origin !== origin) throw new Error("Cloud bundle account belongs to another Canopy");
  const configurationTree = treeID(payload.configurationTree, "cloud bundle configuration tree");
  const profileTree = treeID(payload.profileTree, "cloud bundle profile tree");
  const deviceID = nonempty(payload.deviceID, "cloud bundle device ID");
  if (!/^dv_[a-z2-7]{26}$/.test(deviceID)) throw new Error("Cloud bundle device ID is invalid");
  const credential = nonempty(payload.credential, "cloud bundle credential");
  if (!/^arb_[a-f0-9]{64}$/.test(credential)) throw new Error("Cloud bundle credential is invalid");
  if (!Array.isArray(payload.placements) || !payload.placements.length) throw new Error("Cloud bundle requires at least one placement");
  const placements = payload.placements.map((candidate, index): CloudBundlePlacement => {
    const placement = record(candidate, `cloud bundle placement ${index + 1}`);
    exactFields(placement, ["treeID", "canonicalURL", "relativePath"], `cloud bundle placement ${index + 1}`);
    const canonicalURL = nonempty(placement.canonicalURL, `cloud bundle placement ${index + 1} URL`);
    const url = new URL(canonicalURL);
    if (url.origin !== origin || url.search || url.hash) throw new Error(`Cloud bundle placement ${index + 1} belongs to another Canopy`);
    return {
      treeID: treeID(placement.treeID, `cloud bundle placement ${index + 1} tree`),
      canonicalURL,
      relativePath: portableRelativePath(placement.relativePath, `cloud bundle placement ${index + 1} path`),
    };
  });
  validateCloudPlacementPaths(placements.map((placement) => placement.relativePath));
  if (new Set(placements.map((placement) => placement.treeID)).size !== placements.length) {
    throw new Error("Cloud bundle places the same tree more than once");
  }
  return {
    version: 1,
    bundleID,
    label: nonempty(payload.label, "cloud bundle label"),
    createdAt: nonempty(payload.createdAt, "cloud bundle creation time"),
    origin,
    account,
    accountID: nonempty(payload.accountID, "cloud bundle account ID"),
    configurationTree,
    profileTree,
    deviceID,
    credential,
    placements,
  };
}

export function encodeCloudBundle(payloadInput: CloudBundlePayload): string {
  const payload = validateCloudBundlePayload(payloadInput);
  const compressed = deflateRawSync(Buffer.from(stableJSONString(payload)));
  const encoded = `${CLOUD_BUNDLE_PREFIX}.${payload.bundleID}.${compressed.toString("base64url")}`;
  if (encoded.length > MAX_CLOUD_BUNDLE_LENGTH) {
    throw new Error(`Cloud bundle exceeds the ${MAX_CLOUD_BUNDLE_LENGTH}-character limit; use fewer or shorter placements`);
  }
  return encoded;
}

export function decodeCloudBundle(input: string): CloudBundlePayload {
  if (input.length > MAX_CLOUD_BUNDLE_LENGTH) throw new Error("Cloud bundle exceeds the supported size limit");
  const match = /^arbor-cloud-v1\.(cb_[a-z0-9]{20,64})\.([A-Za-z0-9_-]+)$/.exec(input);
  if (!match) throw new Error("Cloud bundle is malformed or uses an unsupported version");
  let decoded: unknown;
  try {
    decoded = JSON.parse(inflateRawSync(Buffer.from(match[2]!, "base64url")).toString("utf8"));
  } catch {
    throw new Error("Cloud bundle payload is corrupt");
  }
  const payload = validateCloudBundlePayload(decoded);
  if (payload.bundleID !== match[1]) throw new Error("Cloud bundle ID does not match its payload");
  return payload;
}

export function cloudHome(): string {
  return resolve(process.env.ARBOR_CLOUD_HOME ?? join(homedir(), ".arbor", "cloud-sessions"));
}

function bundlesPath(): string {
  return join(cloudHome(), "bundles.json");
}

function sessionsPath(): string {
  return join(cloudHome(), "sessions.json");
}

export function cloudSessionDirectory(sessionID: string): string {
  return join(cloudHome(), "sessions", sessionID);
}

async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(cloudHome(), { recursive: true, mode: 0o700 });
  await chmod(cloudHome(), 0o700).catch(() => {});
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function loadCloudBundles(): Promise<SafeCloudBundleRecord[]> {
  try {
    const value = JSON.parse(await readFile(bundlesPath(), "utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error("Cloud bundle registry must be a list");
    return value.map((candidate, index): SafeCloudBundleRecord => {
      const item = record(candidate, `cloud bundle registry entry ${index + 1}`);
      exactFields(item, ["bundleID", "label", "createdAt", "origin", "account", "configurationTree", "deviceID", "revokedAt"], `cloud bundle registry entry ${index + 1}`);
      const origin = normalizedOrigin(item.origin, `cloud bundle registry entry ${index + 1} origin`);
      const account = nonempty(item.account, `cloud bundle registry entry ${index + 1} account`);
      if (new URL(account).origin !== origin) throw new Error(`Cloud bundle registry entry ${index + 1} account belongs to another Canopy`);
      return {
        bundleID: cloudBundleID(item.bundleID),
        label: nonempty(item.label, `cloud bundle registry entry ${index + 1} label`),
        createdAt: nonempty(item.createdAt, `cloud bundle registry entry ${index + 1} creation time`),
        origin,
        account,
        configurationTree: treeID(item.configurationTree, `cloud bundle registry entry ${index + 1} configuration tree`),
        deviceID: nonempty(item.deviceID, `cloud bundle registry entry ${index + 1} device ID`),
        ...(item.revokedAt === undefined ? {} : { revokedAt: nonempty(item.revokedAt, `cloud bundle registry entry ${index + 1} revocation time`) }),
      };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveCloudBundleRecord(record: SafeCloudBundleRecord): Promise<void> {
  const existing = await loadCloudBundles();
  const next = [...existing.filter((candidate) => candidate.bundleID !== record.bundleID), record]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  await atomicJSON(bundlesPath(), next);
}

export async function updateCloudBundleRecord(bundleID: string, change: Partial<SafeCloudBundleRecord>): Promise<SafeCloudBundleRecord> {
  const existing = await loadCloudBundles();
  const record = existing.find((candidate) => candidate.bundleID === bundleID);
  if (!record) throw new Error(`Unknown local cloud bundle: ${bundleID}`);
  const next = { ...record, ...change, bundleID: record.bundleID };
  await atomicJSON(bundlesPath(), existing.map((candidate) => candidate.bundleID === bundleID ? next : candidate));
  return next;
}

export async function loadCloudSessions(): Promise<CloudSessionRecord[]> {
  try {
    const value = record(JSON.parse(await readFile(sessionsPath(), "utf8")), "cloud session registry");
    exactFields(value, ["version", "sessions"], "cloud session registry");
    if (value.version !== 1 || !Array.isArray(value.sessions)) throw new Error("Cloud session registry is invalid");
    return value.sessions.map((candidate, index): CloudSessionRecord => {
      const item = record(candidate, `cloud session registry entry ${index + 1}`);
      exactFields(item, [
        "version", "sessionID", "bundleID", "configurationTree", "root", "dataHome", "instanceID", "phase",
        "createdAt", "updatedAt", "origin", "pid", "placements", "lastError",
      ], `cloud session registry entry ${index + 1}`);
      if (item.version !== 1) throw new Error(`Cloud session registry entry ${index + 1} version is unsupported`);
      const sessionID = nonempty(item.sessionID, `cloud session registry entry ${index + 1} ID`);
      if (!/^cs_[a-z0-9]{20,64}$/.test(sessionID)) throw new Error(`Cloud session registry entry ${index + 1} ID is invalid`);
      const rootPath = nonempty(item.root, `cloud session registry entry ${index + 1} root`);
      if (!isAbsolute(rootPath) || resolve(rootPath) !== rootPath) throw new Error(`Cloud session registry entry ${index + 1} root must be an absolute normalized path`);
      const dataHome = nonempty(item.dataHome, `cloud session registry entry ${index + 1} data home`);
      if (dataHome !== join(cloudSessionDirectory(sessionID), "data")) throw new Error(`Cloud session registry entry ${index + 1} data home is outside its session directory`);
      if (!Array.isArray(item.placements) || !item.placements.length) throw new Error(`Cloud session registry entry ${index + 1} requires placements`);
      const placements = item.placements.map((candidatePlacement, placementIndex) => {
        const placement = record(candidatePlacement, `cloud session registry entry ${index + 1} placement ${placementIndex + 1}`);
        exactFields(placement, ["treeID", "canonicalURL", "relativePath", "path"], `cloud session registry entry ${index + 1} placement ${placementIndex + 1}`);
        const relativePath = portableRelativePath(placement.relativePath, `cloud session registry entry ${index + 1} placement ${placementIndex + 1} path`);
        const path = nonempty(placement.path, `cloud session registry entry ${index + 1} placement ${placementIndex + 1} destination`);
        if (path !== cloudPlacementPath(rootPath, relativePath)) throw new Error(`Cloud session registry entry ${index + 1} placement ${placementIndex + 1} escapes its root`);
        return {
          treeID: treeID(placement.treeID, `cloud session registry entry ${index + 1} placement ${placementIndex + 1} tree`),
          canonicalURL: nonempty(placement.canonicalURL, `cloud session registry entry ${index + 1} placement ${placementIndex + 1} URL`),
          relativePath,
          path,
        };
      });
      validateCloudPlacementPaths(placements.map((placement) => placement.relativePath));
      const phase = nonempty(item.phase, `cloud session registry entry ${index + 1} phase`);
      if (!["preparing", "ready", "draining", "needs-sync", "finished"].includes(phase)) throw new Error(`Cloud session registry entry ${index + 1} phase is invalid`);
      if (item.pid !== undefined && (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 0)) throw new Error(`Cloud session registry entry ${index + 1} PID is invalid`);
      return {
        version: 1,
        sessionID,
        bundleID: cloudBundleID(item.bundleID),
        configurationTree: treeID(item.configurationTree, `cloud session registry entry ${index + 1} configuration tree`),
        root: rootPath,
        dataHome,
        instanceID: nonempty(item.instanceID, `cloud session registry entry ${index + 1} instance ID`),
        phase: phase as CloudSessionPhase,
        createdAt: nonempty(item.createdAt, `cloud session registry entry ${index + 1} creation time`),
        updatedAt: nonempty(item.updatedAt, `cloud session registry entry ${index + 1} update time`),
        ...(item.origin === undefined ? {} : { origin: normalizedOrigin(item.origin, `cloud session registry entry ${index + 1} origin`) }),
        ...(item.pid === undefined ? {} : { pid: item.pid as number }),
        placements,
        ...(item.lastError === undefined ? {} : { lastError: nonempty(item.lastError, `cloud session registry entry ${index + 1} error`) }),
      };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveCloudSession(record: CloudSessionRecord): Promise<void> {
  const existing = await loadCloudSessions();
  const next = [...existing.filter((candidate) => candidate.sessionID !== record.sessionID), record]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  await atomicJSON(sessionsPath(), { version: 1, sessions: next } satisfies CloudSessionRegistry);
}

export async function cloudSessionForPath(pathInput: string): Promise<CloudSessionRecord | null> {
  const requested = resolve(pathInput);
  const path = await realpath(requested).catch(() => requested);
  const candidates = (await loadCloudSessions()).filter((session) => {
    const rel = relative(session.root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }).sort((left, right) => right.root.length - left.root.length);
  return candidates[0] ?? null;
}

export async function cloudSessionForRoot(rootInput: string): Promise<CloudSessionRecord | null> {
  const requested = resolve(rootInput);
  const root = await realpath(requested).catch(() => requested);
  return (await loadCloudSessions()).find((session) => session.root === root && session.phase !== "finished") ?? null;
}
