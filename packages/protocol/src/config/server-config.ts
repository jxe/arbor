import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../index.ts";
import { deviceKeyFromSeed, openDeviceSession } from "./device-key.ts";
import { arborDataRoot, arborPrivateRoot, prepareArborDataRoot } from "./private-state.ts";

const SERVICE = "org.arbor.community-account";

export function accountCredentialName(configurationTree: string, dataRoot = arborDataRoot()): string {
  return `account-${sha256(`${dataRoot}\0${configurationTree}`).slice(0, 24)}`;
}

function credentialLocation(reference: string): { service: string; name: string } | null {
  const separator = reference.lastIndexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return { service: reference.slice(0, separator), name: reference.slice(separator + 1) };
}

export interface HostAccountRecord {
  configurationTree: string;
  origin: string;
  account: string;
  accountID: string;
  /** Optional Canopy-specific presentation hint; never account identity. */
  handle?: string;
  profileTree: string;
  deviceID: string;
  /** Where the device key's seed lives: `file:device-key` or a credential-store slot. */
  credential: string;
  /** SHA-256 of the seed, to confirm the slot still holds this device's key. */
  tokenDigest: string;
  /** The device's `devices.yaml` key. */
  deviceKey: string;
  configurationRef?: string;
  configurationUpdate?: string;
  connected: true;
}

/**
 * A session within this long of expiring is replaced before it is handed out,
 * or within a quarter of its length when that is shorter: a placement host
 * issues shorter sessions near the end of its grace (accounts §5.4), and each
 * would otherwise be replaced as soon as it was opened.
 */
const SESSION_MARGIN_MS = 5 * 60_000;
type CachedSession = { token: string; expiresAt: number; openedAt?: number };
/** Keyed by a connection's private directory: one data home, one account or placement. */
const sessions = new Map<string, CachedSession>();
/** Session opens in flight, so concurrent callers share one challenge and one session. */
const sessionOpens = new Map<string, Promise<CachedSession>>();

/** Whether a cached session is still worth handing out. */
export function sessionUsable(session: CachedSession, now = Date.now()): boolean {
  const margin = session.openedAt === undefined
    ? SESSION_MARGIN_MS
    : Math.min(SESSION_MARGIN_MS, (session.expiresAt - session.openedAt) / 4);
  return session.expiresAt - margin > now;
}
/**
 * Each account's record and secret as last read, so a request does not reread
 * the connection file and the keychain. Writes through this store replace it;
 * another process's edits show within a minute, or at once after a refusal.
 */
const CREDENTIAL_READ_TTL_MS = 60_000;
const credentialReads = new Map<string, { record: HostAccountRecord; secret: string | null; readAt: number }>();

/**
 * A session the device key opens at `origin`, cached in memory under `key`
 * and on disk at `sessionPath`, and reused until close to expiry. Concurrent
 * callers share one challenge and one session.
 */
async function openCachedSession(key: string, sessionPath: string, origin: string, profileTree: string, deviceID: string, seed: string): Promise<string> {
  const usable = (value?: CachedSession) => value && sessionUsable(value) ? value : undefined;
  let cached = usable(sessions.get(key));
  if (!cached) {
    try {
      const saved = JSON.parse(await readFile(sessionPath, "utf8")) as { device?: string; token?: string; expiresAt?: number; openedAt?: number };
      if (saved.device === deviceID && typeof saved.token === "string" && typeof saved.expiresAt === "number") {
        cached = usable({ token: saved.token, expiresAt: saved.expiresAt, ...(typeof saved.openedAt === "number" ? { openedAt: saved.openedAt } : {}) });
      }
    } catch {}
  }
  if (cached) {
    sessions.set(key, cached);
    return cached.token;
  }
  let opening = sessionOpens.get(key);
  if (!opening) {
    opening = (async () => {
      const openedAt = Date.now();
      const opened = await openDeviceSession(origin, profileTree, deviceID, seed);
      const value = { token: opened.token, expiresAt: opened.expiresAt, openedAt };
      sessions.set(key, value);
      const temporary = `${sessionPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ device: deviceID, ...value }), { mode: 0o600 });
      await rename(temporary, sessionPath);
      return value;
    })().finally(() => sessionOpens.delete(key));
    sessionOpens.set(key, opening);
  }
  return (await opening).token;
}

/** Private connection metadata and credential lookup for one configuration TreeID. */
export class HostAccountStore {
  constructor(readonly configurationTree: string) {
    if (!/^tr_[a-z2-7]+$/.test(configurationTree)) throw new Error("Account store requires a configuration TreeID");
  }

  private get directory(): string {
    return join(arborPrivateRoot(), "accounts", this.configurationTree);
  }

  private get path(): string {
    return join(this.directory, "connection.json");
  }

  private credentialLocation(): { service: string; name: string } {
    return { service: SERVICE, name: accountCredentialName(this.configurationTree) };
  }

  private keyLocation(): { service: string; name: string } {
    return { service: SERVICE, name: `${accountCredentialName(this.configurationTree)}-key` };
  }

  private get credentialPath(): string {
    return join(this.directory, "credential");
  }

  private get keyPath(): string {
    return join(this.directory, "device-key");
  }

  private get sessionPath(): string {
    return join(this.directory, "session.json");
  }

  private get usesFileCredentials(): boolean {
    return process.env.ARBOR_CREDENTIAL_STORE === "file";
  }

  /** Durable pre-network slot for a new device's key seed while a claim or pairing is pending. */
  async storeProvisionalCredential(value: string): Promise<void> {
    if (!value) throw new Error("Account credential must not be empty");
    if (this.usesFileCredentials) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.credentialPath, value, { mode: 0o600 });
    } else {
      await Bun.secrets.set({ ...this.credentialLocation(), value });
    }
  }

  /** Empty the pre-network slot once a claim has installed the device's key instead. */
  async clearProvisionalCredential(): Promise<void> {
    if (this.usesFileCredentials) await rm(this.credentialPath, { force: true });
    else await Bun.secrets.delete(this.credentialLocation()).catch(() => {});
  }

  async provisionalCredential(): Promise<string | null> {
    if (this.usesFileCredentials) return readFile(this.credentialPath, "utf8").catch(() => null);
    return Bun.secrets.get(this.credentialLocation()).catch(() => null);
  }

  /** Connect as a key device with its seed, as claiming and pairing do. */
  async setDeviceKey(seed: string, metadata: Omit<HostAccountRecord, "configurationTree" | "credential" | "tokenDigest" | "connected" | "deviceKey">): Promise<HostAccountRecord> {
    await prepareArborDataRoot();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.usesFileCredentials) await writeFile(this.keyPath, seed, { mode: 0o600 });
    else await Bun.secrets.set({ ...this.keyLocation(), value: seed });
    const key = this.keyLocation();
    return this.writeRecord({
      ...metadata,
      origin: new URL(metadata.origin).origin,
      configurationTree: this.configurationTree,
      credential: this.usesFileCredentials ? "file:device-key" : `${key.service}/${key.name}`,
      tokenDigest: sha256(seed),
      deviceKey: deviceKeyFromSeed(seed),
      connected: true,
    });
  }

  async safe(): Promise<HostAccountRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.path, "utf8")) as HostAccountRecord;
      if (
        typeof record.account !== "string"
        || record.configurationTree !== this.configurationTree
        || new URL(record.origin).origin !== record.origin
        || new URL(record.account).origin !== record.origin
        || !record.accountID || !record.profileTree || !record.deviceID
        || !record.credential || !record.tokenDigest || record.connected !== true
      ) return null;
      return record;
    } catch { return null; }
  }

  /**
   * The connection and the bearer token its requests send: a session its key
   * opens, reused until close to expiry.
   */
  async get(): Promise<{ record: HostAccountRecord; accountToken: string } | null> {
    const credential = await this.credential();
    if (!credential) return null;
    const { record, secret } = credential;
    return { record, accountToken: await openCachedSession(this.directory, this.sessionPath, record.origin, record.profileTree, record.deviceID, secret) };
  }

  /** The connection and its device key's seed, when the slot still holds this device's key. */
  private async credential(): Promise<{ record: HostAccountRecord; secret: string } | null> {
    let read = credentialReads.get(this.directory);
    if (!read || Date.now() - read.readAt > CREDENTIAL_READ_TTL_MS) {
      const record = await this.safe();
      if (!record) { credentialReads.delete(this.directory); return null; }
      read = { record, secret: await this.readSecret(record.credential), readAt: Date.now() };
      credentialReads.set(this.directory, read);
    }
    const { record, secret } = read;
    if (!record.deviceKey || !secret || sha256(secret) !== record.tokenDigest) return null;
    return { record, secret };
  }

  /**
   * This device's key seed and DeviceID, which its placement connections
   * (`HostPlacementStore`) sign in with: one installation has one DeviceID
   * per profile (accounts §5), valid at every host that reads its home's list.
   */
  async deviceKeySeed(): Promise<{ deviceID: string; seed: string } | null> {
    const credential = await this.credential();
    return credential ? { deviceID: credential.record.deviceID, seed: credential.secret } : null;
  }

  /** After the host refused this device: forget its session so the next `get` opens another. */
  async forgetSession(): Promise<void> {
    sessions.delete(this.directory);
    credentialReads.delete(this.directory);
    await rm(this.sessionPath, { force: true });
  }

  private async readSecret(reference: string): Promise<string | null> {
    if (reference === "file:device-key") return readFile(this.keyPath, "utf8").catch(() => null);
    const location = credentialLocation(reference);
    if (!location) return null;
    return Bun.secrets.get(location).catch(() => null);
  }

  /** Whether this installation holds a key for the account. */
  async hasDeviceKey(): Promise<boolean> {
    return (await this.readKeySeed()) !== null;
  }

  private async readKeySeed(): Promise<string | null> {
    if (this.usesFileCredentials) return readFile(this.keyPath, "utf8").catch(() => null);
    return Bun.secrets.get(this.keyLocation()).catch(() => null);
  }

  private async writeRecord(record: HostAccountRecord): Promise<HostAccountRecord> {
    credentialReads.delete(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    credentialReads.delete(this.directory);
    return record;
  }

  async remove(): Promise<void> {
    const record = await this.safe();
    if (record?.credential === "file:device-key" || this.usesFileCredentials) {
      await rm(this.credentialPath, { force: true });
      await rm(this.keyPath, { force: true });
    } else {
      await Bun.secrets.delete(record ? credentialLocation(record.credential) ?? this.credentialLocation() : this.credentialLocation());
      await Bun.secrets.delete(this.credentialLocation()).catch(() => {});
      await Bun.secrets.delete(this.keyLocation()).catch(() => {});
    }
    await this.forgetSession();
    await rm(this.path, { force: true });
    credentialReads.delete(this.directory);
  }

  static async list(): Promise<HostAccountRecord[]> {
    let names: string[];
    try { names = await readdir(join(arborPrivateRoot(), "accounts")); }
    catch { return []; }
    const records = await Promise.all(names.filter((name) => /^tr_[a-z2-7]+$/.test(name)).map((name) => new HostAccountStore(name).safe()));
    return records.filter((record): record is HostAccountRecord => record !== null).sort((a, b) => a.configurationTree.localeCompare(b.configurationTree));
  }
}

/**
 * A placement account's connection (accounts §1.3): the profile's account at
 * a host other than its home. The device signs in there with the same
 * DeviceID and key as at its home host, whose connection holds the key.
 */
export interface HostPlacementRecord {
  /** The profile's configuration TreeID; its home connection is `HostAccountStore(configurationTree)`. */
  configurationTree: string;
  /** The placement host's origin. */
  origin: string;
  account: string;
  accountID: string;
  /** Optional Canopy-specific presentation hint; never account identity. */
  handle?: string;
  profileTree: string;
  /** The home host the placement host reads the profile's device keys from. */
  homeHost: string;
  /** The ordinary tree the claim declared at the account's address there. */
  placementRoot: string;
  placed: true;
}

/** The directory name of a placement connection: one per placement host origin. */
function placementDirectoryName(origin: string): string {
  return `host-${sha256(origin).slice(0, 24)}`;
}

/**
 * Private connection metadata for one placement account, keyed by the
 * profile's configuration TreeID and the placement host's origin, beside the
 * home connection whose device key it uses. `HostAccountStore.list()` lists
 * home connections only, so every reader that treats a connection as an
 * account with a configuration checkout keeps doing so.
 */
export class HostPlacementStore {
  readonly origin: string;
  constructor(readonly configurationTree: string, origin: string) {
    if (!/^tr_[a-z2-7]+$/.test(configurationTree)) throw new Error("Placement store requires a configuration TreeID");
    this.origin = new URL(origin).origin;
    if (this.origin !== origin) throw new Error("Placement store requires a canonical origin");
  }

  private static root(configurationTree: string): string {
    return join(arborPrivateRoot(), "accounts", configurationTree, "placements");
  }

  private get directory(): string {
    return join(HostPlacementStore.root(this.configurationTree), placementDirectoryName(this.origin));
  }

  private get path(): string {
    return join(this.directory, "connection.json");
  }

  private get sessionPath(): string {
    return join(this.directory, "session.json");
  }

  async safe(): Promise<HostPlacementRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.path, "utf8")) as HostPlacementRecord;
      if (
        record.configurationTree !== this.configurationTree || record.origin !== this.origin
        || typeof record.account !== "string" || new URL(record.account).origin !== record.origin
        || typeof record.homeHost !== "string" || new URL(record.homeHost).origin !== record.homeHost || record.homeHost === record.origin
        || !record.accountID || !record.profileTree || !record.placementRoot || record.placed !== true
      ) return null;
      return record;
    } catch { return null; }
  }

  async set(record: Omit<HostPlacementRecord, "configurationTree" | "origin" | "placed">): Promise<HostPlacementRecord> {
    await prepareArborDataRoot();
    const complete: HostPlacementRecord = { ...record, configurationTree: this.configurationTree, origin: this.origin, placed: true };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    return complete;
  }

  /**
   * The placement connection and a session the home connection's device key
   * opens at the placement host; null without either.
   */
  async get(): Promise<{ record: HostPlacementRecord; accountToken: string; deviceID: string } | null> {
    const record = await this.safe();
    if (!record) return null;
    const key = await new HostAccountStore(this.configurationTree).deviceKeySeed();
    if (!key) return null;
    const accountToken = await openCachedSession(this.directory, this.sessionPath, record.origin, record.profileTree, key.deviceID, key.seed);
    return { record, accountToken, deviceID: key.deviceID };
  }

  /** After the placement host refused this device: forget its session so the next `get` opens another. */
  async forgetSession(): Promise<void> {
    sessions.delete(this.directory);
    await rm(this.sessionPath, { force: true });
  }

  async remove(): Promise<void> {
    await this.forgetSession();
    await rm(this.directory, { recursive: true, force: true });
  }

  /** A profile's placement connections, or every profile's. */
  static async list(configurationTree?: string): Promise<HostPlacementRecord[]> {
    let trees: string[];
    if (configurationTree) trees = [configurationTree];
    else {
      try { trees = (await readdir(join(arborPrivateRoot(), "accounts"))).filter((name) => /^tr_[a-z2-7]+$/.test(name)); }
      catch { return []; }
    }
    const records: HostPlacementRecord[] = [];
    for (const tree of trees) {
      let names: string[];
      try { names = await readdir(HostPlacementStore.root(tree)); } catch { continue; }
      for (const name of names) {
        try {
          const record = JSON.parse(await readFile(join(HostPlacementStore.root(tree), name, "connection.json"), "utf8")) as HostPlacementRecord;
          if (typeof record.origin !== "string" || placementDirectoryName(record.origin) !== name) continue;
          const checked = await new HostPlacementStore(tree, record.origin).safe();
          if (checked) records.push(checked);
        } catch {}
      }
    }
    return records.sort((a, b) => a.configurationTree.localeCompare(b.configurationTree) || a.origin.localeCompare(b.origin));
  }
}
